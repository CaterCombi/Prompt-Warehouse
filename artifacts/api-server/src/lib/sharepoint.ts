// SharePoint / Microsoft Graph integration using Azure AD app-only auth
// Uses client credentials flow (no user login required) — full Sites.ReadWrite.All access
import { logger } from "./logger";

const TENANT_ID = process.env["AZURE_TENANT_ID"] ?? process.env["TENANT_ID"] ?? "";
const CLIENT_ID = process.env["AZURE_CLIENT_ID"] ?? process.env["CLIENT_ID"] ?? "";
const CLIENT_SECRET = process.env["AZURE_CLIENT_SECRET"] ?? process.env["CLIENT_SECRET"] ?? "";
const SITE_NAME = process.env["SHAREPOINT_SITE_ID"] ?? "";
const LIST_NAME = process.env["SHAREPOINT_LIST_ID"] ?? "";
const GRAPH_SITE_ID = process.env["GRAPH_SITE_ID"] ?? "";
const GRAPH_LIST_ID = process.env["GRAPH_LIST_ID"] ?? "";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// Cached access token
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }

  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = (await resp.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };

  if (!data.access_token) {
    throw new Error(`Failed to get access token: ${data.error} — ${data.error_description}`);
  }

  cachedToken = {
    value: data.access_token,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  };

  return cachedToken.value;
}

async function graphRequest(method: string, pathOrUrl: string, body?: unknown): Promise<unknown> {
  const token = await getAccessToken();
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const json = await resp.json() as { error?: { message?: string } };
  if (!resp.ok) {
    throw new Error(`Graph API ${method} ${pathOrUrl} failed (${resp.status}): ${json.error?.message ?? JSON.stringify(json)}`);
  }
  return json;
}

async function graphGet(path: string): Promise<unknown> {
  return graphRequest("GET", path);
}

async function graphPost(path: string, body: unknown): Promise<unknown> {
  return graphRequest("POST", path, body);
}

async function graphPatch(path: string, body: unknown): Promise<unknown> {
  return graphRequest("PATCH", path, body);
}

function assertGraphPath(path: string) {
  if (
    !path.startsWith("/sites/") &&
    !path.startsWith("/drives/") &&
    !path.startsWith(`${GRAPH_BASE}/`)
  ) {
    throw new Error("SharePoint Graph path must be scoped to a site or drive.");
  }
}

// Cached site ID and list ID
let resolvedSiteId: string | null = null;
let resolvedListId: string | null = null;

async function getSiteId(): Promise<string> {
  if (resolvedSiteId) return resolvedSiteId;

  if (GRAPH_SITE_ID) {
    resolvedSiteId = GRAPH_SITE_ID;
    return resolvedSiteId;
  }

  // Get root site hostname then resolve site by path
  const root = (await graphGet("/sites/root")) as { siteCollection?: { hostname?: string } };
  const hostname = root.siteCollection?.hostname;
  if (!hostname) throw new Error("Could not resolve SharePoint hostname");

  const site = (await graphGet(`/sites/${hostname}:/sites/${encodeURIComponent(SITE_NAME)}`)) as { id?: string; error?: { message?: string } };
  if (!site.id) throw new Error(`Site "${SITE_NAME}" not found: ${site.error?.message}`);

  resolvedSiteId = site.id;
  logger.info({ siteId: resolvedSiteId }, "Resolved SharePoint site ID");
  return resolvedSiteId;
}

async function getListId(): Promise<string> {
  if (resolvedListId) return resolvedListId;

  if (GRAPH_LIST_ID) {
    resolvedListId = GRAPH_LIST_ID;
    return resolvedListId;
  }

  const siteId = await getSiteId();
  // Enumerate all lists and match by name (handles trailing dots / display name quirks)
  const lists = (await graphGet(`/sites/${siteId}/lists?$top=100&$select=id,name,displayName`)) as {
    value?: Array<{ id: string; name: string; displayName?: string }>;
  };

  const needle = LIST_NAME.toLowerCase().replace(/\.$/, "").trim();
  const match = (lists.value ?? []).find(
    (l) =>
      l.name.toLowerCase().replace(/\.$/, "").trim() === needle ||
      (l.displayName ?? "").toLowerCase().replace(/\.$/, "").trim() === needle,
  );

  if (!match) {
    throw new Error(
      `List "${LIST_NAME}" not found. Available: ${(lists.value ?? []).map((l) => l.name).join(", ")}`,
    );
  }

  resolvedListId = match.id;
  logger.info({ listId: resolvedListId, listName: match.name }, "Resolved SharePoint list ID");
  return resolvedListId;
}

export interface AssetFields {
  Title?: string;
  Status?: string;
  Manufacturer?: string;
  // SharePoint internal name for "Model" column is Manufacturer_x002e_
  "Manufacturer_x002e_"?: string;
  Size?: string;
  Fuel?: string;
  Features?: string;
  DatePurchased?: string;
  DateRetested?: string;
  Supplier?: string;
  Company?: string;
}

interface ListItem {
  id: string;
  fields: Record<string, unknown>;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

function mapItem(item: ListItem) {
  const f = item.fields;
  const dateRetested = String(f["DateRetested"] ?? "");
  const retestedAt = new Date(dateRetested);
  const retestAgeMs = Date.now() - retestedAt.getTime();
  const fourWeeksMs = 28 * 24 * 60 * 60 * 1000;
  const needsRetest =
    !dateRetested ||
    Number.isNaN(retestedAt.getTime()) ||
    retestAgeMs < 0 ||
    retestAgeMs > fourWeeksMs;

  return {
    id: item.id,
    assetNumber: String(f["Title"] ?? f["AssetNumber"] ?? ""),
    status: String(f["Status"] ?? ""),
    manufacturer: String(f["Manufacturer"] ?? ""),
    model: String(f["Manufacturer_x002e_"] ?? ""),
    size: String(f["Size"] ?? ""),
    fuel: String(f["Fuel"] ?? ""),
    features: String(f["Features"] ?? ""),
    datePurchased: String(f["DatePurchased"] ?? ""),
    dateSold: String(f["DateSold"] ?? ""),
    dateRetested,
    needsRetest,
    supplier: String(f["Supplier"] ?? ""),
    customer: String(f["Company"] ?? ""),
    createdAt: item.createdDateTime ?? "",
    modifiedAt: item.lastModifiedDateTime ?? "",
  };
}

export async function getAssets(search?: string, status?: string) {
  const [siteId, listId] = await Promise.all([getSiteId(), getListId()]);

  const allItems: ListItem[] = [];
  let nextUrl: string | null = `/sites/${siteId}/lists/${listId}/items?expand=fields&$top=999`;

  while (nextUrl) {
    const data = (await graphRequest("GET", nextUrl)) as {
      value?: ListItem[];
      "@odata.nextLink"?: string;
    };
    if (!data.value) throw new Error("Could not fetch items from SharePoint");
    allItems.push(...data.value);
    nextUrl = data["@odata.nextLink"] ?? null;
  }

  let items = allItems;

  if (status) {
    items = items.filter((i) => String(i.fields["Status"] ?? "") === status);
  }

  if (search) {
    const q = search.toLowerCase();
    items = items.filter(
      (i) =>
        String(i.fields["Title"] ?? "").toLowerCase().includes(q) ||
        String(i.fields["Manufacturer"] ?? "").toLowerCase().includes(q) ||
        String(i.fields["Manufacturer_x002e_"] ?? "").toLowerCase().includes(q),
    );
  }

  return items.map(mapItem);
}

export async function getAssetById(id: string) {
  const [siteId, listId] = await Promise.all([getSiteId(), getListId()]);
  const item = (await graphGet(`/sites/${siteId}/lists/${listId}/items/${id}?expand=fields`)) as ListItem;
  return mapItem(item);
}

export async function createAsset(fields: AssetFields) {
  const [siteId, listId] = await Promise.all([getSiteId(), getListId()]);
  const item = (await graphPost(`/sites/${siteId}/lists/${listId}/items`, { fields })) as { id: string };
  return getAssetById(item.id);
}

export async function updateAsset(id: string, fields: AssetFields) {
  const [siteId, listId] = await Promise.all([getSiteId(), getListId()]);
  await graphPatch(`/sites/${siteId}/lists/${listId}/items/${id}/fields`, fields);
  return getAssetById(id);
}

export async function getAssetStats() {
  const assets = await getAssets();
  const statusMap = new Map<string, number>();
  for (const a of assets) {
    const s = a.status || "Unknown";
    statusMap.set(s, (statusMap.get(s) ?? 0) + 1);
  }
  return {
    total: assets.length,
    byStatus: Array.from(statusMap.entries()).map(([status, count]) => ({ status, count })),
  };
}

export async function getSharePointSiteId(): Promise<string> {
  return getSiteId();
}

export async function getSharePointGraphJson(path: string): Promise<unknown> {
  assertGraphPath(path);
  return graphGet(path);
}

export async function postSharePointGraphJson(path: string, body: unknown): Promise<unknown> {
  assertGraphPath(path);
  return graphPost(path, body);
}

export class SharePointConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharePointConflictError";
  }
}

export interface SharePointDriveFile {
  id: string;
  name: string;
  webUrl?: string;
  size?: number;
}

export async function uploadSharePointDriveFile(
  driveId: string,
  parentItemId: string,
  fileName: string,
  content: Uint8Array,
  contentType: string,
): Promise<SharePointDriveFile> {
  if (!fileName || /[\\/:*?"<>|]/.test(fileName)) {
    throw new Error("SharePoint file name contains unsupported characters.");
  }
  const token = await getAccessToken();
  const path = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentItemId)}:/${encodeURIComponent(fileName)}:/content?@microsoft.graph.conflictBehavior=fail`;
  const url = `${GRAPH_BASE}${path}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
    },
    body: content,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    webUrl?: string;
    size?: number;
    error?: { message?: string; code?: string };
  };
  if (response.status === 409 || payload.error?.code === "nameAlreadyExists") {
    throw new SharePointConflictError(payload.error?.message ?? `A file named "${fileName}" already exists.`);
  }
  if (!response.ok || !payload.id || !payload.name) {
    throw new Error(
      `SharePoint file upload failed (${response.status}): ${payload.error?.message ?? JSON.stringify(payload)}`,
    );
  }
  return {
    id: payload.id,
    name: payload.name,
    webUrl: payload.webUrl,
    size: payload.size,
  };
}
