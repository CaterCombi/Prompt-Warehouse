import { marketingDateRangeForRange, type MarketingDateRange } from "./google-marketing";

type HubSpotRecord = {
  properties?: Record<string, string | null>;
  createdAt?: string;
};

type HubSpotPipeline = {
  id?: string;
  label?: string;
};

const CATERDIRECT_BUSINESS_UNIT_ID = "17577089";

type HubSpotResponse = {
  results?: HubSpotRecord[];
  paging?: { next?: { after?: string } };
};

const SOURCE_LABELS: Record<string, string> = {
  AI_ASSISTANT: "AI Assistant",
  DIRECT_TRAFFIC: "Direct",
  EMAIL_MARKETING: "Email",
  OFFLINE: "Offline",
  ORGANIC_SEARCH: "Organic Search",
  ORGANIC_SOCIAL: "Organic Social",
  PAID_SEARCH: "Paid Search",
  PAID_SOCIAL: "Paid Social",
  REFERRALS: "Referral",
};

function labelSource(value: string | null | undefined) {
  if (!value) return "Unknown";
  return SOURCE_LABELS[value] ?? value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase());
}

async function getJson(path: string) {
  const token = process.env.HUBSPOT_TOKEN ?? process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN environment variable is not set");
  const response = await fetch(`https://api.hubapi.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`HubSpot request failed (${response.status}) for ${path}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

async function getAllRecords(path: string, properties: string[]) {
  const records: HubSpotRecord[] = [];
  let after: string | undefined;

  do {
    const params = new URLSearchParams({ limit: "100", archived: "false", properties: properties.join(",") });
    if (after) params.set("after", after);
    const response = (await getJson(`${path}?${params.toString()}`)) as HubSpotResponse;
    records.push(...(response.results ?? []));
    after = response.paging?.next?.after;
  } while (after && records.length < 10000);

  return records;
}

function share(value: number, total: number) {
  return total ? Math.round((value / total) * 100) : 0;
}

function change(current: number, previous: number) {
  return previous ? Number((((current - previous) / previous) * 100).toFixed(1)) : 0;
}

function isCaterDirectContact(contact: HubSpotRecord) {
  return (contact.properties?.hs_all_assigned_business_unit_ids ?? "")
    .split(";")
    .map((value) => value.trim())
    .includes(CATERDIRECT_BUSINESS_UNIT_ID);
}

type HubSpotSnapshot = Awaited<ReturnType<typeof loadHubSpotSnapshot>>;

let snapshotCache: { value: HubSpotSnapshot; expiresAt: number; key: string } | null = null;
let inFlightSnapshot: { key: string; promise: Promise<HubSpotSnapshot> } | null = null;

async function loadHubSpotSnapshot(dateRange: MarketingDateRange) {
  const [contacts, deals, pipelineResponse] = await Promise.all([
    getAllRecords("/crm/v3/objects/contacts", ["hs_analytics_source", "hs_latest_source", "createdate", "hs_all_assigned_business_unit_ids"]),
    getAllRecords("/crm/v3/objects/deals", ["amount", "pipeline", "closedate", "createdate"]),
    getJson("/crm/v3/pipelines/deals"),
  ]);

  const day = 24 * 60 * 60 * 1000;
  const currentStart = Date.parse(`${dateRange.startDate}T00:00:00Z`);
  const currentEnd = Date.parse(`${dateRange.endDate}T00:00:00Z`) + day;
  const previousStart = Date.parse(`${dateRange.comparisonStartDate}T00:00:00Z`);
  const previousEnd = Date.parse(`${dateRange.comparisonEndDate}T00:00:00Z`) + day;
  const eligibleContacts = contacts.filter((contact) => !isCaterDirectContact(contact));
  const eligibleContactDates = eligibleContacts.map((contact) => new Date(contact.properties?.createdate ?? contact.createdAt ?? 0).getTime());
   const currentContacts = eligibleContactDates.filter((date) => date >= currentStart && date < currentEnd).length;
   const previousContacts = eligibleContactDates.filter((date) => date >= previousStart && date < previousEnd).length;
  const currentContactRecords = eligibleContacts.filter((contact) => {
    const date = new Date(contact.properties?.createdate ?? contact.createdAt ?? 0).getTime();
     return date >= currentStart && date < currentEnd;
  });
  const contactsForAttribution = currentContactRecords;
   const dailyNewContacts = [...currentContactRecords.reduce((counts, contact) => {
     const createdAt = new Date(contact.properties?.createdate ?? contact.createdAt ?? 0);
     if (Number.isNaN(createdAt.getTime())) return counts;
     const date = createdAt.toISOString().slice(0, 10);
     counts.set(date, (counts.get(date) ?? 0) + 1);
     return counts;
   }, new Map<string, number>())]
     .map(([date, count]) => ({ date, count }))
     .sort((first, second) => first.date.localeCompare(second.date));

  const sourceCounts = new Map<string, number>();
  for (const contact of contactsForAttribution) {
    const source = labelSource(contact.properties?.hs_latest_source ?? contact.properties?.hs_analytics_source);
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }
  const hubspotContactSources = [...sourceCounts.entries()]
    .sort(([, first], [, second]) => second - first)
    .map(([label, value]) => ({ label, value, share: share(value, contactsForAttribution.length) }));

  const pipelines = ((pipelineResponse.results ?? []) as HubSpotPipeline[]).reduce<Map<string, string>>((map, pipeline) => {
    if (pipeline.id) map.set(pipeline.id, pipeline.label ?? pipeline.id);
    return map;
  }, new Map());
  const excludedPipelineIds = new Set(
    [...pipelines.entries()]
      .filter(([, label]) => label.toLowerCase().includes("caterdirect"))
      .map(([id]) => id),
  );
  const eligibleDeals = deals.filter((deal) => !excludedPipelineIds.has(deal.properties?.pipeline ?? ""));
  const usableDeals = eligibleDeals.filter((deal) => !deal.properties?.closedate);
  const dealsCreated = eligibleDeals.filter((deal) => {
    const date = new Date(deal.properties?.createdate ?? deal.createdAt ?? 0).getTime();
     return date >= currentStart && date < currentEnd;
  }).length;
  const monthlyDeals = [...eligibleDeals.reduce((counts, deal) => {
    const createdAt = new Date(deal.properties?.createdate ?? deal.createdAt ?? 0);
    if (Number.isNaN(createdAt.getTime())) return counts;
    const month = createdAt.toISOString().slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + 1);
    return counts;
  }, new Map<string, number>())].map(([month, dealsCreated]) => ({ month, dealsCreated }));
  const boardTotals = new Map<string, number>();
  for (const deal of usableDeals) {
    const pipeline = pipelines.get(deal.properties?.pipeline ?? "") ?? "Unassigned";
    const amount = Number(deal.properties?.amount ?? 0);
    if (Number.isFinite(amount)) boardTotals.set(pipeline, (boardTotals.get(pipeline) ?? 0) + amount);
  }
  const pipelineBoards = [...boardTotals.entries()]
    .sort(([, first], [, second]) => second - first)
    .map(([label, value]) => ({ label, value, displayValue: `£${value.toLocaleString("en-GB", { maximumFractionDigits: 0 })}` }));
  const pipelineTotal = pipelineBoards.reduce((total, board) => total + board.value, 0);

  return {
    contactsTotal: eligibleContacts.length,
    newContacts: currentContacts,
    dailyNewContacts,
    contactsChange: change(currentContacts, previousContacts),
    dealsCreated,
    monthlyDeals,
    contactSources: hubspotContactSources,
    pipelineTotal,
    pipelineBoards,
  };
}

export async function fetchHubSpotSnapshot(dateRange: MarketingDateRange = marketingDateRangeForRange("30d")) {
  if (snapshotCache && snapshotCache.key === dateRange.key && snapshotCache.expiresAt > Date.now()) return snapshotCache.value;
  if (inFlightSnapshot?.key === dateRange.key) return inFlightSnapshot.promise;

  const promise = loadHubSpotSnapshot(dateRange);
  inFlightSnapshot = { key: dateRange.key, promise };
  try {
    const value = await promise;
    snapshotCache = { value, expiresAt: Date.now() + 5 * 60 * 1000, key: dateRange.key };
    return value;
  } finally {
    if (inFlightSnapshot?.key === dateRange.key) inFlightSnapshot = null;
  }
}