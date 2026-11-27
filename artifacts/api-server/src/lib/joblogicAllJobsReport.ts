import { Client } from "basic-ftp";
import { Writable } from "node:stream";
import { getSharePointAccessToken } from "./sharepoint.js";
import {
  buildAllJobsSharePointFilename,
  selectNewestAllJobsReport,
} from "./joblogicAllJobsReportCore.js";

const FTP_PORT = 21;
const FTP_LOGIN_DIRECTORY = "/";
const SHAREPOINT_SITE_PATH =
  "/sites/catercombi.sharepoint.com:/sites/CaterCombiTeamSite";
const SHAREPOINT_DISPLAY_PATH = "Shared Documents/Reporting/Job Logic";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const MAX_SIMPLE_UPLOAD_BYTES = 250 * 1024 * 1024;

type GraphDrive = { id: string; name: string };
type GraphItem = {
  id: string;
  name: string;
  size?: number;
  file?: Record<string, unknown>;
  folder?: Record<string, unknown>;
  parentReference?: { id?: string };
};
type GraphPage = {
  value?: GraphItem[];
  "@odata.nextLink"?: string;
};
type GraphRequestError = Error & { httpStatus?: number };

export type JoblogicAllJobsUploadResult =
  | {
      status: "uploaded" | "already_uploaded";
      filename: string;
      sourceModifiedAt: string;
      sourceSizeBytes: number;
      sharePointSizeBytes: number;
      sizeMatches: boolean;
    }
  | { status: "no_report" };

export class JoblogicAllJobsUploadError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "JoblogicAllJobsUploadError";
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown transfer error";
  const sensitiveValues = [
    process.env.FTP_PASSWORD,
    process.env.AZURE_CLIENT_SECRET,
  ].filter((value): value is string => Boolean(value));
  return sensitiveValues.reduce(
    (safe, secret) => safe.replaceAll(secret, "[redacted]"),
    message,
  )
    .replace(/https?:\/\/[^\s]+/g, "[URL redacted]")
    .slice(0, 400);
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
    error?: { code?: string };
  };

  if (!response.ok) {
    const error = new Error(
      `Microsoft Graph ${method} returned HTTP ${response.status}`
      + (payload.error?.code ? ` (${payload.error.code})` : ""),
    ) as GraphRequestError;
    error.httpStatus = response.status;
    throw error;
  }

  return payload;
}

async function listChildren(
  token: string,
  driveId: string,
  itemId: string,
): Promise<GraphItem[]> {
  const items: GraphItem[] = [];
  let nextUrl: string | null =
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}`
    + `/items/${encodeURIComponent(itemId)}/children`
    + "?$select=id,name,size,file,folder,parentReference&$top=200";

  while (nextUrl) {
    const page = await graphRequest(token, "GET", nextUrl) as GraphPage;
    items.push(...(page.value ?? []));
    nextUrl = page["@odata.nextLink"] ?? null;
  }

  return items;
}

async function findTargetFolder(token: string): Promise<{
  drive: GraphDrive;
  folder: GraphItem;
}> {
  const site = await graphRequest(
    token,
    "GET",
    `${SHAREPOINT_SITE_PATH}?$select=id,name,webUrl`,
  ) as { id?: string; webUrl?: string };
  if (!site.id || site.webUrl?.replace(/\/+$/, "") !==
    "https://catercombi.sharepoint.com/sites/CaterCombiTeamSite") {
    throw new Error("The configured SharePoint site did not match the requested site");
  }

  const drivesResponse = await graphRequest(
    token,
    "GET",
    `/sites/${encodeURIComponent(site.id)}/drives?$select=id,name,driveType`,
  ) as { value?: GraphDrive[] };
  const drives = drivesResponse.value ?? [];
  // Graph calls the site's user-facing "Shared Documents" library "Documents".
  const drive = drives.find((candidate) =>
    ["shared documents", "documents"].includes(candidate.name.trim().toLowerCase()),
  );
  if (!drive) {
    throw new Error("The SharePoint Shared Documents library was not found");
  }

  const root = await graphRequest(
    token,
    "GET",
    `/drives/${encodeURIComponent(drive.id)}/root/children?$select=id,name,folder&$top=200`,
  ) as GraphPage;
  const reporting = (root.value ?? []).find((item) =>
    item.name.trim().toLowerCase() === "reporting" && item.folder,
  );
  if (!reporting?.id) {
    throw new Error("The SharePoint Reporting folder was not found");
  }

  const reportingChildren = await listChildren(token, drive.id, reporting.id);
  const folder = reportingChildren.find((item) =>
    item.name.trim().toLowerCase() === "job logic" && item.folder,
  );
  if (!folder?.id) {
    throw new Error("The SharePoint Job Logic folder was not found");
  }

  return { drive, folder };
}

async function findExistingFile(
  token: string,
  driveId: string,
  folderId: string,
  filename: string,
): Promise<GraphItem | null> {
  const children = await listChildren(token, driveId, folderId);
  return children.find((item) =>
    item.name.toLocaleLowerCase() === filename.toLocaleLowerCase(),
  ) ?? null;
}

function alreadyUploadedResult(
  filename: string,
  sourceModifiedAt: Date,
  sourceSizeBytes: number,
  existing: GraphItem,
): JoblogicAllJobsUploadResult {
  return {
    status: "already_uploaded",
    filename,
    sourceModifiedAt: sourceModifiedAt.toISOString(),
    sourceSizeBytes,
    sharePointSizeBytes: Number(existing.size ?? 0),
    sizeMatches: Number(existing.size) === sourceSizeBytes,
  };
}

async function uploadFileContent(
  token: string,
  driveId: string,
  fileId: string,
  content: Buffer,
): Promise<void> {
  const response = await fetch(
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}`
    + `/items/${encodeURIComponent(fileId)}/content`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: content,
    },
  );
  if (!response.ok) {
    const error = new Error(
      `SharePoint upload returned HTTP ${response.status}`,
    ) as GraphRequestError;
    error.httpStatus = response.status;
    throw error;
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
      `/drives/${encodeURIComponent(driveId)}`
      + `/items/${encodeURIComponent(fileId)}?$select=id,name,size`,
    ) as GraphItem;
    if (item.name === filename && Number(item.size ?? 0) === 0) {
      await graphRequest(
        token,
        "DELETE",
        `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(fileId)}`,
      );
    }
  } catch {
    // Preserve the upload error; cleanup is limited to this newly created empty item.
  }
}

async function downloadFile(client: Client, filename: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await client.downloadTo(destination, `${FTP_LOGIN_DIRECTORY}${filename}`);
  return Buffer.concat(chunks);
}

export async function uploadNewestAllJobsReport(): Promise<JoblogicAllJobsUploadResult> {
  const host = process.env.FTP_HOST;
  const user = process.env.FTP_USER;
  const password = process.env.FTP_PASSWORD;
  if (!host || !user || !password) {
    throw new JoblogicAllJobsUploadError(
      "configuration",
      "The configured FTP credentials are unavailable",
    );
  }

  const client = new Client(20_000);
  client.ftp.verbose = false;
  let stage = "ftp_connect";

  try {
    await client.access({
      host,
      port: FTP_PORT,
      user,
      password,
      secure: false,
    });

    stage = "ftp_list";
    const files = await client.list(FTP_LOGIN_DIRECTORY);
    const newest = selectNewestAllJobsReport(files);
    if (!newest) return { status: "no_report" };
    if (!newest.modifiedAt) {
      throw new Error("The newest All Jobs report has no modified time");
    }
    const modifiedAt = newest.modifiedAt;
    const sharePointFilename = buildAllJobsSharePointFilename(modifiedAt);

    stage = "ftp_download";
    const content = await downloadFile(client, newest.name);
    if (content.length === 0) {
      throw new Error("The newest All Jobs report was empty");
    }

    stage = "sharepoint_auth";
    const token = await getSharePointAccessToken();
    stage = "sharepoint_folder_check";
    const { drive, folder } = await findTargetFolder(token);

    stage = "sharepoint_duplicate_check";
    const existing = await findExistingFile(token, drive.id, folder.id, sharePointFilename);
    if (existing) {
      return alreadyUploadedResult(
        sharePointFilename,
        modifiedAt,
        content.length,
        existing,
      );
    }

    if (content.length > MAX_SIMPLE_UPLOAD_BYTES) {
      throw new Error("The newest All Jobs report exceeds SharePoint's simple-upload limit");
    }

    stage = "sharepoint_file_create";
    const createFilePath =
      `/drives/${encodeURIComponent(drive.id)}`
      + `/items/${encodeURIComponent(folder.id)}/children`;
    let createdFile: GraphItem;
    try {
      createdFile = await graphRequest(token, "POST", createFilePath, {
        name: sharePointFilename,
        file: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }) as GraphItem;
    } catch (error) {
      const httpStatus = (error as GraphRequestError).httpStatus;
      if (httpStatus === 409 || httpStatus === 412) {
        const concurrentUpload = await findExistingFile(
          token,
          drive.id,
          folder.id,
          sharePointFilename,
        );
        if (concurrentUpload) {
          return alreadyUploadedResult(
            sharePointFilename,
            modifiedAt,
            content.length,
            concurrentUpload,
          );
        }
      }
      throw error;
    }
    if (!createdFile.id || !createdFile.file) {
      throw new Error("SharePoint did not confirm the new All Jobs file");
    }

    stage = "sharepoint_upload";
    try {
      await uploadFileContent(token, drive.id, createdFile.id, content);
      stage = "sharepoint_verify";
      const verified = await graphRequest(
        token,
        "GET",
        `/drives/${encodeURIComponent(drive.id)}`
        + `/items/${encodeURIComponent(createdFile.id)}?$select=id,name,size,parentReference`,
      ) as GraphItem;
      if (
        verified.name !== sharePointFilename
        || Number(verified.size) !== content.length
        || (verified.parentReference?.id && verified.parentReference.id !== folder.id)
      ) {
        throw new Error("SharePoint verification did not match the source file");
      }

      return {
        status: "uploaded",
        filename: sharePointFilename,
        sourceModifiedAt: modifiedAt.toISOString(),
        sourceSizeBytes: content.length,
        sharePointSizeBytes: Number(verified.size),
        sizeMatches: true,
      };
    } catch (error) {
      await removeEmptyPlaceholder(token, drive.id, createdFile.id, sharePointFilename);
      throw error;
    }
  } catch (error) {
    if (error instanceof JoblogicAllJobsUploadError) throw error;
    throw new JoblogicAllJobsUploadError(
      stage,
      safeErrorMessage(error),
      (error as GraphRequestError).httpStatus,
    );
  } finally {
    client.close();
  }
}
