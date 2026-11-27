import { getSharePointAccessToken } from "./sharepoint.js";
import { logger } from "./logger.js";
import {
  dueServiceDeskReportMonth,
  serviceDeskMonthlyReportFilename,
} from "./serviceDeskMonthlyReportCore.js";
import { loadMonthlyServiceDeskReport } from "./serviceDeskMonthlyReportData.js";
import { generateMonthlyServiceDeskReportPdf } from "./serviceDeskMonthlyReportPdf.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SHAREPOINT_SITE_PATH = "/sites/catercombi.sharepoint.com:/sites/CaterCombiTeamSite";
const SHAREPOINT_SITE_URL = "https://catercombi.sharepoint.com/sites/CaterCombiTeamSite";
const SHAREPOINT_DISPLAY_PATH = "Shared Documents/Reporting/Job Logic";
const MAX_SIMPLE_UPLOAD_BYTES = 250 * 1024 * 1024;

type GraphItem = {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  file?: Record<string, unknown>;
  folder?: Record<string, unknown>;
  parentReference?: { id?: string };
};

type GraphPage = {
  value?: GraphItem[];
  "@odata.nextLink"?: string;
};

type GraphRequestError = Error & { httpStatus?: number };

export type ServiceDeskReportUploadResult =
  | { status: "uploaded" | "already_uploaded"; reportMonth: string; filename: string; sizeBytes: number; webUrl?: string }
  | { status: "skipped"; reportMonth: string; filename: string; reason: "stale" | "missing" }
  | { status: "not_due"; reportMonth: null }
  | { status: "failed"; reportMonth: string; filename: string; stage: string };

function requestError(message: string, status: number): GraphRequestError {
  const error = new Error(message) as GraphRequestError;
  error.httpStatus = status;
  return error;
}

async function graphRequest(
  token: string,
  method: string,
  pathOrUrl: string,
  body?: unknown,
): Promise<unknown> {
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({})) as {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw requestError(
      `Microsoft Graph ${method} failed`
      + (payload.error?.code ? ` (${payload.error.code})` : "")
      + (payload.error?.message ? `: ${payload.error.message}` : ""),
      response.status,
    );
  }
  return payload;
}

async function listChildren(token: string, driveId: string, parentId: string | null): Promise<GraphItem[]> {
  const parentPath = parentId ? `/items/${encodeURIComponent(parentId)}/children` : "/root/children";
  const items: GraphItem[] = [];
  let nextUrl: string | null =
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}${parentPath}`
    + "?$select=id,name,size,webUrl,file,folder,parentReference&$top=200";
  while (nextUrl) {
    const page = await graphRequest(token, "GET", nextUrl) as GraphPage;
    items.push(...(page.value ?? []));
    nextUrl = page["@odata.nextLink"] ?? null;
  }
  return items;
}

async function findOrCreateFolder(
  token: string,
  driveId: string,
  parentId: string | null,
  name: string,
): Promise<GraphItem> {
  const listFolder = async () => {
    const children = await listChildren(token, driveId, parentId);
    return children.find((item) => item.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase()) ?? null;
  };
  const existing = await listFolder();
  if (existing) {
    if (!existing.id || !existing.folder) {
      throw new Error(`A SharePoint item named ${name} exists but is not a folder`);
    }
    return existing;
  }

  const parentPath = parentId ? `/items/${encodeURIComponent(parentId)}/children` : "/root/children";
  try {
    const created = await graphRequest(
      token,
      "POST",
      `/drives/${encodeURIComponent(driveId)}${parentPath}`,
      { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
    ) as GraphItem;
    if (!created.id || !created.folder) throw new Error(`SharePoint did not confirm the ${name} folder`);
    return created;
  } catch (error) {
    const status = (error as GraphRequestError).httpStatus;
    if (status === 409 || status === 412) {
      const concurrentFolder = await listFolder();
      if (concurrentFolder?.id && concurrentFolder.folder) return concurrentFolder;
    }
    throw error;
  }
}

async function findReportFolder(token: string): Promise<{ driveId: string; folder: GraphItem }> {
  const site = await graphRequest(token, "GET", `${SHAREPOINT_SITE_PATH}?$select=id,name,webUrl`) as {
    id?: string;
    webUrl?: string;
  };
  if (!site.id || site.webUrl?.replace(/\/+$/, "") !== SHAREPOINT_SITE_URL) {
    throw new Error("The configured SharePoint site did not match the Service Desk report destination");
  }
  const drives = await graphRequest(
    token,
    "GET",
    `/sites/${encodeURIComponent(site.id)}/drives?$select=id,name,driveType`,
  ) as { value?: Array<{ id: string; name: string }> };
  const drive = (drives.value ?? []).find((item) =>
    ["shared documents", "documents"].includes(item.name.trim().toLocaleLowerCase()),
  );
  if (!drive) throw new Error("The SharePoint Shared Documents library was not found");
  const reporting = await findOrCreateFolder(token, drive.id, null, "Reporting");
  const jobLogic = await findOrCreateFolder(token, drive.id, reporting.id, "Job Logic");
  return { driveId: drive.id, folder: jobLogic };
}

async function findExistingFile(
  token: string,
  driveId: string,
  folderId: string,
  filename: string,
): Promise<GraphItem | null> {
  const children = await listChildren(token, driveId, folderId);
  return children.find((item) =>
    !item.folder && item.name.toLocaleLowerCase() === filename.toLocaleLowerCase(),
  ) ?? null;
}

async function uploadPdfContent(token: string, driveId: string, fileId: string, content: Uint8Array): Promise<void> {
  const response = await fetch(
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(fileId)}/content`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/pdf" }, body: content },
  );
  const payload = await response.json().catch(() => ({})) as {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw requestError(
      "SharePoint rejected the Service Desk PDF content"
      + (payload.error?.code ? ` (${payload.error.code})` : "")
      + (payload.error?.message ? `: ${payload.error.message}` : ""),
      response.status,
    );
  }
}

async function removeEmptyPlaceholder(
  token: string,
  driveId: string,
  fileId: string,
  filename: string,
): Promise<void> {
  try {
    const item = await graphRequest(
      token,
      "GET",
      `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(fileId)}?$select=id,name,size`,
    ) as GraphItem;
    if (item.name === filename && Number(item.size ?? 0) === 0) {
      await graphRequest(token, "DELETE", `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(fileId)}`);
    }
  } catch {
    // Preserve the original error; cleanup is limited to this new empty item.
  }
}

function safeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown transfer error";
  const sensitiveValues = [process.env.AZURE_CLIENT_SECRET, process.env.FTP_PASSWORD]
    .filter((value): value is string => Boolean(value));
  return sensitiveValues.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), message)
    .replace(/https?:\/\/[^\s]+/g, "[URL redacted]")
    .slice(0, 300);
}

function alreadyUploaded(
  reportMonth: string,
  filename: string,
  item: GraphItem,
): ServiceDeskReportUploadResult {
  const sizeBytes = Number(item.size ?? 0);
  logger.info({
    reportMonth,
    filename,
    sizeBytes,
    destination: SHAREPOINT_DISPLAY_PATH,
  }, "Monthly Service Desk PDF already exists in SharePoint; it was not replaced");
  return {
    status: "already_uploaded",
    reportMonth,
    filename,
    sizeBytes,
    ...(item.webUrl ? { webUrl: item.webUrl } : {}),
  };
}

async function uploadServiceDeskReportForMonth(
  reportMonth: string,
  now: Date,
  testMode: boolean,
): Promise<ServiceDeskReportUploadResult> {
  const filename = testMode
    ? `Service Desk Report TEST ${reportMonth}.pdf`
    : serviceDeskMonthlyReportFilename(reportMonth);
  let stage = "sharepoint_auth";
  try {
    const token = await getSharePointAccessToken();
    stage = "sharepoint_folder_check";
    const { driveId, folder } = await findReportFolder(token);

    stage = "sharepoint_duplicate_check";
    const existing = await findExistingFile(token, driveId, folder.id, filename);
    if (existing) return alreadyUploaded(reportMonth, filename, existing);

    stage = "report_data";
    const report = await loadMonthlyServiceDeskReport(reportMonth, now);
    if (!testMode && report.source.status !== "fresh") {
      return {
        status: "skipped",
        reportMonth,
        filename,
        reason: report.source.status,
      };
    }

    stage = "report_generation";
    const pdf = await generateMonthlyServiceDeskReportPdf(report);
    if (pdf.byteLength === 0) throw new Error("The generated Service Desk PDF was empty");
    if (pdf.byteLength > MAX_SIMPLE_UPLOAD_BYTES) {
      throw new Error("The generated Service Desk PDF exceeds SharePoint's simple-upload limit");
    }

    stage = "sharepoint_file_create";
    const createPath = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folder.id)}/children`;
    let createdFile: GraphItem;
    try {
      createdFile = await graphRequest(token, "POST", createPath, {
        name: filename,
        file: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }) as GraphItem;
    } catch (error) {
      const status = (error as GraphRequestError).httpStatus;
      if (status === 409 || status === 412) {
        const concurrentUpload = await findExistingFile(token, driveId, folder.id, filename);
        if (concurrentUpload) return alreadyUploaded(reportMonth, filename, concurrentUpload);
      }
      throw error;
    }
    if (!createdFile.id || !createdFile.file) {
      throw new Error("SharePoint did not confirm the new Service Desk PDF file");
    }

    stage = "sharepoint_upload";
    try {
      await uploadPdfContent(token, driveId, createdFile.id, pdf);
      stage = "sharepoint_verify";
      const verified = await graphRequest(
        token,
        "GET",
        `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(createdFile.id)}`
        + "?$select=id,name,size,webUrl,parentReference",
      ) as GraphItem;
      if (
        verified.name !== filename
        || Number(verified.size) !== pdf.byteLength
        || (verified.parentReference?.id && verified.parentReference.id !== folder.id)
      ) {
        throw new Error("SharePoint verification did not match the Service Desk PDF");
      }
      logger.info({
        reportMonth,
        filename,
        sizeBytes: pdf.byteLength,
        destination: SHAREPOINT_DISPLAY_PATH,
        testMode,
      }, "Monthly Service Desk PDF uploaded and verified in SharePoint");
      return {
        status: "uploaded",
        reportMonth,
        filename,
        sizeBytes: pdf.byteLength,
        ...(verified.webUrl ? { webUrl: verified.webUrl } : {}),
      };
    } catch (error) {
      await removeEmptyPlaceholder(token, driveId, createdFile.id, filename);
      throw error;
    }
  } catch (error) {
    logger.error({
      reportMonth,
      filename,
      destination: SHAREPOINT_DISPLAY_PATH,
      stage,
      httpStatus: (error as GraphRequestError).httpStatus,
      errorType: error instanceof Error ? error.name : "UnknownError",
      message: safeFailureMessage(error),
    }, "Monthly Service Desk SharePoint upload failed");
    return { status: "failed", reportMonth, filename, stage };
  }
}

export async function uploadMonthlyServiceDeskReportForMonth(
  reportMonth: string,
  now = new Date(),
): Promise<ServiceDeskReportUploadResult> {
  return uploadServiceDeskReportForMonth(reportMonth, now, false);
}

export async function uploadServiceDeskReportTestForMonth(
  reportMonth: string,
  now = new Date(),
): Promise<ServiceDeskReportUploadResult> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Service Desk test reports can only be uploaded outside production");
  }
  return uploadServiceDeskReportForMonth(reportMonth, now, true);
}

export async function runMonthlyServiceDeskReportUploadIfDue(
  bankHolidayDates: ReadonlySet<string>,
  now = new Date(),
): Promise<ServiceDeskReportUploadResult> {
  const reportMonth = dueServiceDeskReportMonth(now, bankHolidayDates);
  if (!reportMonth) return { status: "not_due", reportMonth: null };
  return uploadMonthlyServiceDeskReportForMonth(reportMonth, now);
}
