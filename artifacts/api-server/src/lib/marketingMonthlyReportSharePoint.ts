import { getSharePointAccessToken } from "./sharepoint.js";
import { logger } from "./logger.js";
import { dueMarketingReportMonth, monthlyMarketingReportFilename } from "./marketingMonthlyReportCore.js";
import { loadMonthlyMarketingReport } from "./marketingMonthlyReportData.js";
import { generateMonthlyMarketingReportPdf } from "./marketingMonthlyReportPdf.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SHAREPOINT_SITE_PATH =
  "/sites/catercombi.sharepoint.com:/sites/CaterCombiTeamSite";
const SHAREPOINT_SITE_URL =
  "https://catercombi.sharepoint.com/sites/CaterCombiTeamSite";
const SHAREPOINT_DISPLAY_PATH = "Shared Documents/Reporting/Marketing";
const REPORTING_FOLDER = "Reporting";
const MARKETING_FOLDER = "Marketing";
const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;

type GraphItem = {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  folder?: Record<string, unknown>;
  parentReference?: { id?: string };
};

type GraphPage = {
  value?: GraphItem[];
  "@odata.nextLink"?: string;
};

type GraphRequestError = Error & { httpStatus?: number };

type MarketingReportUploadResult =
  | { status: "uploaded" | "already_uploaded"; reportMonth: string; filename: string; sizeBytes: number; webUrl?: string }
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
  const url = pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `${GRAPH_BASE}${pathOrUrl}`;
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

async function listChildren(
  token: string,
  driveId: string,
  parentId: string | null,
): Promise<GraphItem[]> {
  const parentPath = parentId
    ? `/items/${encodeURIComponent(parentId)}/children`
    : "/root/children";
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
  const findFolder = async () => {
    const children = await listChildren(token, driveId, parentId);
    return children.find((item) =>
      item.name.trim().toLowerCase() === name.toLowerCase(),
    ) ?? null;
  };

  const existing = await findFolder();
  if (existing) {
    if (!existing.folder || !existing.id) {
      throw new Error(`A SharePoint item named ${name} exists but is not a folder`);
    }
    return existing;
  }

  const parentPath = parentId
    ? `/items/${encodeURIComponent(parentId)}/children`
    : "/root/children";
  try {
    const created = await graphRequest(
      token,
      "POST",
      `/drives/${encodeURIComponent(driveId)}${parentPath}`,
      {
        name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      },
    ) as GraphItem;
    if (!created.id || !created.folder) {
      throw new Error(`SharePoint did not confirm the ${name} folder`);
    }
    return created;
  } catch (error) {
    const httpStatus = (error as GraphRequestError).httpStatus;
    if (httpStatus === 409 || httpStatus === 412) {
      const concurrentFolder = await findFolder();
      if (concurrentFolder?.id && concurrentFolder.folder) return concurrentFolder;
    }
    throw error;
  }
}

async function findMarketingFolder(token: string): Promise<{
  driveId: string;
  folder: GraphItem;
}> {
  const site = await graphRequest(
    token,
    "GET",
    `${SHAREPOINT_SITE_PATH}?$select=id,name,webUrl`,
  ) as { id?: string; webUrl?: string };
  if (!site.id || site.webUrl?.replace(/\/+$/, "") !== SHAREPOINT_SITE_URL) {
    throw new Error("The configured SharePoint site did not match the Marketing report destination");
  }

  const drivesResponse = await graphRequest(
    token,
    "GET",
    `/sites/${encodeURIComponent(site.id)}/drives?$select=id,name,driveType`,
  ) as { value?: Array<{ id: string; name: string }> };
  const drive = (drivesResponse.value ?? []).find((candidate) =>
    ["shared documents", "documents"].includes(candidate.name.trim().toLowerCase()),
  );
  if (!drive) {
    throw new Error("The SharePoint Shared Documents library was not found");
  }

  const reporting = await findOrCreateFolder(token, drive.id, null, REPORTING_FOLDER);
  const marketing = await findOrCreateFolder(token, drive.id, reporting.id, MARKETING_FOLDER);
  return { driveId: drive.id, folder: marketing };
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

async function uploadPdfBytes(uploadUrl: string, content: Uint8Array): Promise<GraphItem> {
  let uploadedItem: GraphItem | null = null;
  for (let start = 0; start < content.length; start += UPLOAD_CHUNK_BYTES) {
    const end = Math.min(start + UPLOAD_CHUNK_BYTES, content.length);
    const chunk = content.subarray(start, end);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${end - 1}/${content.length}`,
      },
      body: chunk,
    });
    const item = await response.json().catch(() => ({})) as GraphItem;
    if (!response.ok) {
      throw requestError("SharePoint rejected the Marketing PDF upload", response.status);
    }
    if (end === content.length && item.id) uploadedItem = item;
  }
  if (!uploadedItem?.id) {
    throw new Error("SharePoint did not confirm the Marketing PDF upload");
  }
  return uploadedItem;
}

function safeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown transfer error";
  const secret = process.env.AZURE_CLIENT_SECRET;
  return message
    .replace(/https?:\/\/[^\s]+/g, "[URL redacted]")
    .replace(secret || "\u0000", "[redacted]")
    .slice(0, 300);
}

function alreadyUploadedResult(
  reportMonth: string,
  filename: string,
  existing: GraphItem,
): MarketingReportUploadResult {
  const sizeBytes = Number(existing.size ?? 0);
  logger.info({
    reportMonth,
    filename,
    sizeBytes,
    destination: SHAREPOINT_DISPLAY_PATH,
  }, "Monthly Marketing PDF already exists in SharePoint; it was not replaced");
  return {
    status: "already_uploaded",
    reportMonth,
    filename,
    sizeBytes,
    ...(existing.webUrl ? { webUrl: existing.webUrl } : {}),
  };
}

export async function uploadMonthlyMarketingReportForMonth(
  reportMonth: string,
  now = new Date(),
): Promise<MarketingReportUploadResult> {
  const filename = monthlyMarketingReportFilename(reportMonth);
  let stage = "sharepoint_auth";

  try {
    const token = await getSharePointAccessToken();
    stage = "sharepoint_folder_check";
    const { driveId, folder } = await findMarketingFolder(token);

    stage = "sharepoint_duplicate_check";
    const existing = await findExistingFile(token, driveId, folder.id, filename);
    if (existing) {
      return alreadyUploadedResult(reportMonth, filename, existing);
    }

    stage = "report_generation";
    const report = await loadMonthlyMarketingReport(reportMonth, now);
    const pdf = await generateMonthlyMarketingReportPdf(report);
    if (pdf.byteLength === 0) {
      throw new Error("The generated Marketing PDF was empty");
    }

    stage = "sharepoint_upload_session";
    const sessionPath =
      `/drives/${encodeURIComponent(driveId)}`
      + `/items/${encodeURIComponent(folder.id)}:/${encodeURIComponent(filename)}`
      + `:/createUploadSession`;
    let session: { uploadUrl?: string };
    try {
      session = await graphRequest(token, "POST", sessionPath, {
        item: {
          name: filename,
          "@microsoft.graph.conflictBehavior": "fail",
        },
      }) as { uploadUrl?: string };
    } catch (error) {
      const httpStatus = (error as GraphRequestError).httpStatus;
      if (httpStatus === 409 || httpStatus === 412) {
        const concurrentUpload = await findExistingFile(token, driveId, folder.id, filename);
        if (concurrentUpload) {
          return alreadyUploadedResult(reportMonth, filename, concurrentUpload);
        }
      }
      throw error;
    }
    if (!session.uploadUrl) {
      throw new Error("Microsoft Graph did not return a Marketing PDF upload session");
    }

    stage = "sharepoint_upload";
    let uploaded: GraphItem;
    try {
      uploaded = await uploadPdfBytes(session.uploadUrl, pdf);
    } catch (error) {
      const httpStatus = (error as GraphRequestError).httpStatus;
      if (httpStatus === 409 || httpStatus === 412) {
        const concurrentUpload = await findExistingFile(token, driveId, folder.id, filename);
        if (concurrentUpload) {
          return alreadyUploadedResult(reportMonth, filename, concurrentUpload);
        }
      }
      throw error;
    }

    stage = "sharepoint_verify";
    const verified = await graphRequest(
      token,
      "GET",
      `/drives/${encodeURIComponent(driveId)}`
      + `/items/${encodeURIComponent(uploaded.id)}?$select=id,name,size,webUrl,parentReference`,
    ) as GraphItem;
    if (
      verified.name !== filename
      || Number(verified.size) !== pdf.byteLength
      || (verified.parentReference?.id && verified.parentReference.id !== folder.id)
    ) {
      throw new Error("SharePoint verification did not match the Marketing PDF");
    }

    logger.info({
      reportMonth,
      filename,
      sizeBytes: pdf.byteLength,
      destination: SHAREPOINT_DISPLAY_PATH,
    }, "Monthly Marketing PDF uploaded and verified in SharePoint");
    return {
      status: "uploaded",
      reportMonth,
      filename,
      sizeBytes: pdf.byteLength,
      ...(verified.webUrl ? { webUrl: verified.webUrl } : {}),
    };
  } catch (error) {
    logger.error({
      reportMonth,
      filename,
      destination: SHAREPOINT_DISPLAY_PATH,
      stage,
      httpStatus: (error as GraphRequestError).httpStatus,
      errorType: error instanceof Error ? error.name : "UnknownError",
      message: safeFailureMessage(error),
    }, "Monthly Marketing SharePoint upload failed");
    return { status: "failed", reportMonth, filename, stage };
  }
}

export async function runMonthlyMarketingReportSharePointUploadIfDue(
  now = new Date(),
): Promise<MarketingReportUploadResult> {
  const reportMonth = dueMarketingReportMonth(now);
  if (!reportMonth) return { status: "not_due", reportMonth: null };
  return uploadMonthlyMarketingReportForMonth(reportMonth, now);
}
