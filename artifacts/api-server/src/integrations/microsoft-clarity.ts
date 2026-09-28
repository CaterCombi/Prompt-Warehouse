import { and, eq } from "drizzle-orm";
import { claritySnapshots, db } from "@workspace/db";

const CLARITY_EXPORT_URL = "https://www.clarity.ms/export-data/api/v1/project-live-insights";
const NUM_OF_DAYS = 3;

export type ClarityDimension = {
  value: string;
  sessions: number;
  users: number;
  botSessions: number;
  pagesPerSession: number;
};

export type ClarityBehaviorMetric = {
  sessions: number;
  rate: number;
  pages: number;
  events: number;
};

export type ClarityPage = {
  url: string;
  visits: number;
};

export type ClaritySnapshot = {
  source: "live" | "unavailable";
  capturedAt: string;
  windowStart: string;
  windowEnd: string;
  numOfDays: number;
  sessions: number;
  users: number;
  botSessions: number;
  pagesPerSession: number;
  dimension: string;
  dimensions: ClarityDimension[];
  behavior: {
    deadClicks: ClarityBehaviorMetric;
    excessiveScrolls: ClarityBehaviorMetric;
    rageClicks: ClarityBehaviorMetric;
    quickbacks: ClarityBehaviorMetric;
    scriptErrors: ClarityBehaviorMetric;
    errorClicks: ClarityBehaviorMetric;
  };
  scrollDepth: number;
  engagementTime: {
    activeTime: number;
    totalTime: number;
  };
  popularPages: ClarityPage[];
  enhancedMetricsAvailable: boolean;
  message: string;
};

type StoredClaritySnapshot = Omit<ClaritySnapshot, "behavior" | "scrollDepth" | "engagementTime" | "popularPages" | "enhancedMetricsAvailable"> & Partial<Pick<ClaritySnapshot, "behavior" | "scrollDepth" | "engagementTime" | "popularPages" | "enhancedMetricsAvailable">>;

type ClarityMetric = {
  metricName?: string;
  information?: Array<Record<string, unknown>>;
};

function safeNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metricValue(row: Record<string, unknown>, names: string[]) {
  const key = names.find((name) => row[name] !== undefined);
  return key ? safeNumber(row[key]) : 0;
}

function snapshotDate() {
  return new Date().toISOString().slice(0, 10);
}

function subtractDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function findMetric(metrics: ClarityMetric[], name: string) {
  return metrics.find((metric) => metric.metricName?.toLowerCase() === name.toLowerCase());
}

function parseBehaviorMetric(metrics: ClarityMetric[], name: string): ClarityBehaviorMetric {
  const row = findMetric(metrics, name)?.information?.[0] ?? {};
  return {
    sessions: metricValue(row, ["sessionsCount", "SessionsCount"]),
    rate: metricValue(row, ["sessionsWithMetricPercentage", "SessionsWithMetricPercentage"]),
    pages: metricValue(row, ["pagesViews", "PagesViews"]),
    events: metricValue(row, ["subTotal", "SubTotal"]),
  };
}

function parseSnapshot(payload: unknown, pagePayload: unknown): ClaritySnapshot {
  const metrics = Array.isArray(payload) ? payload as ClarityMetric[] : [];
  const pageMetrics = Array.isArray(pagePayload) ? pagePayload as ClarityMetric[] : [];
  const traffic = findMetric(metrics, "Traffic");
  const rows = Array.isArray(traffic?.information) ? traffic.information : [];
  const dimensions = rows.map((row) => ({
    value: String(row.Device ?? row.device ?? row.OS ?? row.os ?? row.Browser ?? row.browser ?? "Unknown"),
    sessions: metricValue(row, ["totalSessionCount", "TotalSessionCount"]),
    users: metricValue(row, ["distantUserCount", "distinctUserCount", "DistinctUserCount"]),
    botSessions: metricValue(row, ["totalBotSessionCount", "TotalBotSessionCount"]),
    pagesPerSession: metricValue(row, ["pagesPerSessionPercentage", "PagesPerSessionPercentage", "pagesPerSession", "PagesPerSession"]),
  })).filter((row) => row.sessions > 0 || row.users > 0);

  const capturedAt = snapshotDate();
  const sessions = dimensions.reduce((total, row) => total + row.sessions, 0);
  const users = dimensions.reduce((total, row) => total + row.users, 0);
  const botSessions = dimensions.reduce((total, row) => total + row.botSessions, 0);
  const pagesPerSession = sessions
    ? Number((dimensions.reduce((total, row) => total + row.pagesPerSession * row.sessions, 0) / sessions).toFixed(2))
    : 0;
  const engagement = findMetric(metrics, "EngagementTime")?.information?.[0] ?? {};
  const popularPages = (findMetric(pageMetrics, "PopularPages")?.information ?? [])
    .map((row) => ({
      url: String(row.url ?? row.URL ?? ""),
      visits: metricValue(row, ["visitsCount", "VisitsCount"]),
    }))
    .filter((page) => page.url && page.visits > 0);

  return {
    source: "live",
    capturedAt,
    windowStart: subtractDays(capturedAt, NUM_OF_DAYS),
    windowEnd: subtractDays(capturedAt, 1),
    numOfDays: NUM_OF_DAYS,
    sessions,
    users,
    botSessions,
    pagesPerSession,
    dimension: "Device",
    dimensions,
    behavior: {
      deadClicks: parseBehaviorMetric(metrics, "DeadClickCount"),
      excessiveScrolls: parseBehaviorMetric(metrics, "ExcessiveScroll"),
      rageClicks: parseBehaviorMetric(metrics, "RageClickCount"),
      quickbacks: parseBehaviorMetric(metrics, "QuickbackClick"),
      scriptErrors: parseBehaviorMetric(metrics, "ScriptErrorCount"),
      errorClicks: parseBehaviorMetric(metrics, "ErrorClickCount"),
    },
    scrollDepth: metricValue(findMetric(metrics, "ScrollDepth")?.information?.[0] ?? {}, ["averageScrollDepth", "AverageScrollDepth"]),
    engagementTime: {
      activeTime: metricValue(engagement, ["activeTime", "ActiveTime"]),
      totalTime: metricValue(engagement, ["totalTime", "TotalTime"]),
    },
    popularPages,
    enhancedMetricsAvailable: true,
    message: "",
  };
}

export function unavailableClaritySnapshot(message: string): ClaritySnapshot {
  const capturedAt = snapshotDate();
  return {
    source: "unavailable",
    capturedAt,
    windowStart: "",
    windowEnd: "",
    numOfDays: NUM_OF_DAYS,
    sessions: 0,
    users: 0,
    botSessions: 0,
    pagesPerSession: 0,
    dimension: "Device",
    dimensions: [],
    behavior: {
      deadClicks: { sessions: 0, rate: 0, pages: 0, events: 0 },
      excessiveScrolls: { sessions: 0, rate: 0, pages: 0, events: 0 },
      rageClicks: { sessions: 0, rate: 0, pages: 0, events: 0 },
      quickbacks: { sessions: 0, rate: 0, pages: 0, events: 0 },
      scriptErrors: { sessions: 0, rate: 0, pages: 0, events: 0 },
      errorClicks: { sessions: 0, rate: 0, pages: 0, events: 0 },
    },
    scrollDepth: 0,
    engagementTime: { activeTime: 0, totalTime: 0 },
    popularPages: [],
    enhancedMetricsAvailable: false,
    message,
  };
}

function normalizeStoredSnapshot(stored: StoredClaritySnapshot): ClaritySnapshot {
  if (stored.enhancedMetricsAvailable === true) return stored as ClaritySnapshot;
  return {
    source: stored.source,
    capturedAt: stored.capturedAt,
    windowStart: stored.windowStart,
    windowEnd: stored.windowEnd,
    numOfDays: stored.numOfDays,
    sessions: stored.sessions,
    users: stored.users,
    botSessions: stored.botSessions,
    pagesPerSession: stored.pagesPerSession,
    dimension: stored.dimension,
    dimensions: stored.dimensions,
    behavior: {
      deadClicks: { sessions: 0, rate: 0, pages: 0, events: 0 },
      excessiveScrolls: { sessions: 0, rate: 0, pages: 0, events: 0 },
      rageClicks: { sessions: 0, rate: 0, pages: 0, events: 0 },
      quickbacks: { sessions: 0, rate: 0, pages: 0, events: 0 },
      scriptErrors: { sessions: 0, rate: 0, pages: 0, events: 0 },
      errorClicks: { sessions: 0, rate: 0, pages: 0, events: 0 },
    },
    scrollDepth: 0,
    engagementTime: { activeTime: 0, totalTime: 0 },
    popularPages: [],
    enhancedMetricsAvailable: false,
    message: "Enhanced behaviour and page data will appear after the next successful Clarity export.",
  };
}

async function readStoredSnapshot(date: string) {
  const rows = await db
    .select({ payload: claritySnapshots.payload })
    .from(claritySnapshots)
    .where(and(eq(claritySnapshots.snapshotDate, date), eq(claritySnapshots.source, "microsoft_clarity")))
    .limit(1);
  return rows[0]?.payload as StoredClaritySnapshot | undefined;
}

async function requestExport(dimension: string) {
  const token = process.env.CLARITY_API_TOKEN?.trim();
  if (!token) throw new Error("Microsoft Clarity API token is not configured");

  const response = await fetch(`${CLARITY_EXPORT_URL}?numOfDays=${NUM_OF_DAYS}&dimension1=${encodeURIComponent(dimension)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Microsoft Clarity export failed with ${response.status}`);
  }
  return response.json();
}

let snapshotCache: { date: string; value: ClaritySnapshot } | null = null;
let snapshotInFlight: Promise<ClaritySnapshot> | null = null;

async function loadClaritySnapshot(): Promise<ClaritySnapshot> {
  const token = process.env.CLARITY_API_TOKEN?.trim();
  if (!token) throw new Error("Microsoft Clarity API token is not configured");

  const today = snapshotDate();
  const stored = await readStoredSnapshot(today);
  if (stored?.enhancedMetricsAvailable !== undefined) return stored as ClaritySnapshot;

  try {
    const [devicePayload, pagePayload] = await Promise.all([requestExport("Device"), requestExport("Page")]);
    const snapshot = parseSnapshot(devicePayload, pagePayload);
    await db.insert(claritySnapshots).values({
      snapshotDate: today,
      numOfDays: NUM_OF_DAYS,
      payload: snapshot,
      source: "microsoft_clarity",
    }).onConflictDoUpdate({
      target: claritySnapshots.snapshotDate,
      set: { numOfDays: NUM_OF_DAYS, payload: snapshot, source: "microsoft_clarity" },
    });
    return snapshot;
  } catch (error) {
    if (stored && error instanceof Error && error.message.includes("429")) {
      const fallback = normalizeStoredSnapshot(stored);
      await db.insert(claritySnapshots).values({
        snapshotDate: today,
        numOfDays: NUM_OF_DAYS,
        payload: fallback,
        source: "microsoft_clarity",
      }).onConflictDoUpdate({
        target: claritySnapshots.snapshotDate,
        set: { numOfDays: NUM_OF_DAYS, payload: fallback, source: "microsoft_clarity" },
      });
      return fallback;
    }
    throw error;
  }
}

export async function fetchClaritySnapshot(): Promise<ClaritySnapshot> {
  const today = snapshotDate();
  if (snapshotCache?.date === today) return snapshotCache.value;
  if (snapshotInFlight) return snapshotInFlight;

  snapshotInFlight = loadClaritySnapshot()
    .then((value) => {
      snapshotCache = { date: today, value };
      return value;
    })
    .finally(() => {
      snapshotInFlight = null;
    });
  return snapshotInFlight;
}