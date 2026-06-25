import { getGraphToken } from "./auth";
import { logger } from "./logger";

const siteId = process.env["GRAPH_SITE_ID"] ?? "";
const itemId = process.env["EXCEL_ENGINEER_ITEM_ID"] ?? "";
// Names row: e.g. Sheet1!N2:P2 — engineer names header
const namesRange = process.env["EXCEL_ENGINEER_NAMES_RANGE"] ?? "Sheet1!N2:P2";
// KPI row: e.g. Sheet1!N29:P29 — monthly KPI per engineer
const countsRange = process.env["EXCEL_ENGINEER_COUNTS_RANGE"] ?? "Sheet1!N29:P29";

export interface EngineerStat {
  name: string;
  kpi: number;
}

let cachedStats: EngineerStat[] = [];
let cacheExpiry = 0;
let cacheTimestamp = "";

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function readRange(token: string, range: string): Promise<unknown[][]> {
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/items/${itemId}/workbook/worksheets/Sheet1/range(address='${encodeURIComponent(range)}')`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Excel range fetch failed ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { values: unknown[][] };
  return json.values ?? [];
}

// Fetch one or more comma-separated ranges and concatenate their first-row values
async function readRanges(token: string, rangesEnv: string): Promise<unknown[]> {
  const parts = rangesEnv.split(",").map((r) => r.trim()).filter(Boolean);
  const rows = await Promise.all(parts.map((r) => readRange(token, r)));
  return rows.flatMap((r) => r[0] ?? []);
}

export async function getEngineerStats(): Promise<{
  stats: EngineerStat[];
  lastFetched: string;
}> {
  const now = Date.now();
  if (cachedStats.length > 0 && now < cacheExpiry) {
    return { stats: cachedStats, lastFetched: cacheTimestamp };
  }

  try {
    const token = await getGraphToken();

    const [names_raw, kpis_raw] = await Promise.all([
      readRanges(token, namesRange),
      readRanges(token, countsRange),
    ]);

    const names = names_raw.map((v) => String(v).trim());
    const kpis = kpis_raw.map((v) => {
      const n = Number(v);
      return isNaN(n) ? 0 : n;
    });

    const stats: EngineerStat[] = names
      .map((name, i) => ({ name, kpi: kpis[i] ?? 0 }))
      .filter((s) => s.name !== "");

    cachedStats = stats;
    cacheExpiry = now + CACHE_TTL_MS;
    cacheTimestamp = new Date().toISOString();

    return { stats, lastFetched: cacheTimestamp };
  } catch (err) {
    logger.error({ err }, "Excel engineer stats fetch failed");
    return {
      stats: cachedStats,
      lastFetched: cacheTimestamp || new Date().toISOString(),
    };
  }
}
