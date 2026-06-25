import { getGraphToken } from "./auth";
import { logger } from "./logger";

const siteId = process.env["GRAPH_SITE_ID"] ?? "";
const listId = process.env["GRAPH_LIST_ID"] ?? "";
const colStatus = process.env["COL_STATUS"] ?? "Status";
const colShippingDate = process.env["COL_SHIPPING_DATE"] ?? "ShippingDate";
const colSerial = process.env["COL_SERIAL"] ?? "SerialNumber";

export interface OvenItem {
  title: string;
  status: string;
  shippingDate: string | null;
  serial: string | null;
  manufacturer: string | null;
  model: string | null;
  size: string | null;
  fuel: string | null;
  urgency: string | null;
  additionalInfo: string | null;
}

async function graphFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await getGraphToken();
  const url = `https://graph.microsoft.com/v1.0${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
      ...(options.headers as Record<string, string> ?? {}),
    },
  });

  // Handle throttling
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? "5");
    logger.warn({ retryAfter }, "Graph API throttled, retrying");
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    const token2 = await getGraphToken();
    return fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token2}`,
        "Content-Type": "application/json",
        Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
        ...(options.headers as Record<string, string> ?? {}),
      },
    });
  }

  return res;
}

function ukToday(): { todayStr: string; tomorrowStr: string } {
  const now = new Date();

  // Get today's date components in UK timezone using formatToParts (avoids locale parsing bugs)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);

  // Determine the UK UTC offset (GMT=0, BST=+1) by comparing noon UTC with London noon
  const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const londonNoonHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "numeric",
      hour12: false,
    }).format(noonUTC)
  );
  const offsetHours = londonNoonHour - 12; // 1 for BST, 0 for GMT

  // Midnight London time = UTC 00:00 minus the offset
  // e.g. BST: midnight London = 23:00 UTC previous night
  const todayMidnightUTC = new Date(Date.UTC(y, m - 1, d, -offsetHours, 0, 0));
  const tomorrowMidnightUTC = new Date(
    todayMidnightUTC.getTime() + 24 * 60 * 60 * 1000
  );

  return {
    todayStr: todayMidnightUTC.toISOString(),
    tomorrowStr: tomorrowMidnightUTC.toISOString(),
  };
}

function mapItem(fields: Record<string, unknown>): OvenItem {
  const title =
    (fields["Title"] as string) ||
    (fields["title"] as string) ||
    "Unnamed";
  const status = String(fields[colStatus] ?? "");
  const shippingDate = (fields[colShippingDate] as string) ?? null;
  const serial = (fields[colSerial] as string) || null;
  // Manufacturer_x002e_ is the internal name for the Model column
  const manufacturer = (fields["Manufacturer"] as string) || null;
  const model = (fields["Manufacturer_x002e_"] as string) || null;
  const size = (fields["Size"] as string) || null;
  const fuel = (fields["Fuel"] as string) || null;
  const urgency = (fields["Urgency"] as string)?.trim() || null;
  const additionalInfo = (fields["Additionalinformation"] as string)?.trim() || null;
  return { title, status, shippingDate, serial, manufacturer, model, size, fuel, urgency, additionalInfo };
}

async function fetchAllItems(): Promise<OvenItem[]> {
  const items: OvenItem[] = [];
  let url: string | null =
    `/sites/${siteId}/lists/${listId}/items?expand=fields&$top=999`;

  while (url) {
    const res = await graphFetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph list fetch failed ${res.status}: ${text}`);
    }
    const json = (await res.json()) as {
      value: Array<{ fields: Record<string, unknown> }>;
      "@odata.nextLink"?: string;
    };
    for (const item of json.value) {
      items.push(mapItem(item.fields));
    }
    url = json["@odata.nextLink"]
      ? json["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "")
      : null;
  }
  return items;
}

export async function getShippingToday(): Promise<OvenItem[]> {
  const { todayStr, tomorrowStr } = ukToday();

  // Filter by ShippingDate = today AND Status = Booked
  const filteredUrl =
    `/sites/${siteId}/lists/${listId}/items?expand=fields` +
    `&$filter=fields/${colShippingDate} ge '${todayStr}'` +
    ` and fields/${colShippingDate} lt '${tomorrowStr}'` +
    ` and fields/${colStatus} eq 'Booked'`;

  try {
    const res = await graphFetch(filteredUrl);
    if (res.status === 400) {
      logger.warn("Graph filtered query returned 400, falling back to full fetch");
      throw new Error("filter_unsupported");
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph filtered fetch failed ${res.status}: ${text}`);
    }
    const json = (await res.json()) as {
      value: Array<{ fields: Record<string, unknown> }>;
    };
    return json.value.map((i) => mapItem(i.fields));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== "filter_unsupported") throw err;

    // Fallback: fetch all and filter in Node
    const all = await fetchAllItems();
    const today = new Date(todayStr).getTime();
    const tomorrow = new Date(tomorrowStr).getTime();
    return all.filter((item) => {
      if (!item.shippingDate) return false;
      if (item.status !== "Booked") return false;
      const t = new Date(item.shippingDate).getTime();
      return t >= today && t < tomorrow;
    });
  }
}

let testedOKCache: { count: number; expiry: number } = { count: 0, expiry: 0 };
const TESTED_OK_CACHE_TTL = 15 * 60 * 1000;

export async function getTotalTestedOKThisMonth(): Promise<number> {
  const nowMs = Date.now();
  if (testedOKCache.expiry > nowMs) return testedOKCache.count;

  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "numeric",
    }).formatToParts(now);
    const year = Number(parts.find((p) => p.type === "year")?.value);
    const month = Number(parts.find((p) => p.type === "month")?.value) - 1; // 0-indexed

    let items: Array<{ fields: { DateTestedOK?: string } }> = [];
    let path: string | null =
      `/sites/${siteId}/lists/${listId}/items?$expand=fields($select=DateTestedOK)&$select=id&$top=500`;

    while (path) {
      const res = await graphFetch(path);
      if (!res.ok) break;
      const json = (await res.json()) as {
        value: typeof items;
        "@odata.nextLink"?: string;
      };
      items = items.concat(json.value ?? []);
      path = json["@odata.nextLink"]
        ? json["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "")
        : null;
    }

    const count = items.filter((item) => {
      const d = item.fields?.DateTestedOK;
      if (!d) return false;
      const parsed = new Date(d);
      if (isNaN(parsed.getTime())) return false;
      const ukStr = parsed.toLocaleString("en-GB", { timeZone: "Europe/London" });
      // "DD/MM/YYYY, HH:MM:SS"
      const [day, mon, yrPart] = ukStr.split("/");
      void day;
      const yr = Number(yrPart?.split(",")[0]);
      const mo = Number(mon) - 1;
      return yr === year && mo === month;
    }).length;

    testedOKCache = { count, expiry: nowMs + TESTED_OK_CACHE_TTL };
    return count;
  } catch (err) {
    logger.error({ err }, "getTotalTestedOKThisMonth failed");
    return testedOKCache.count;
  }
}

export async function getPriorityOvens(): Promise<OvenItem[]> {
  const all = await fetchAllItems();
  const urgencyIs = (item: OvenItem, val: string) =>
    item.urgency?.toLowerCase().replace(/-/g, "") === val.toLowerCase().replace(/-/g, "");

  const filtered = all.filter((item) => {
    if (item.status === "Booked" && urgencyIs(item, "urgent")) return true;
    if (item.status === "Priority" && urgencyIs(item, "urgent")) return true;
    if (item.status === "Booked" && urgencyIs(item, "retest")) return true;
    if (item.status === "Priority") return true;
    if (item.status === "Booked" && !item.serial?.trim()) return true;
    return false;
  });

  // Sort order:
  // 1. Booked + Urgent
  // 2. Priority + Urgent
  // 3. Booked + Retest
  // 4. Priority (no special urgency)
  // 5. Booked without serial (catch-all)
  const rank = (item: OvenItem): number => {
    if (item.status === "Booked" && urgencyIs(item, "urgent")) return 0;
    if (item.status === "Priority" && urgencyIs(item, "urgent")) return 1;
    if (item.status === "Booked" && urgencyIs(item, "retest")) return 2;
    if (item.status === "Priority") return 3;
    return 4;
  };
  return filtered.sort((a, b) => rank(a) - rank(b));
}
