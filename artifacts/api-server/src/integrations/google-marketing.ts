import { aggregateGa4ReportRows } from "../lib/marketingOverviewMetrics";

type GoogleAuth = { getAccessToken(): Promise<{ token: string | null }> };

type Ga4Snapshot = {
  sessionsTotal: number;
  organicSessions: number;
  conversionsTotal: number;
  channels: Array<{ label: string; value: number; share: number }>;
  dailySessions: Array<{ date: string; organicSessions: number; paidSessions: number }>;
};

type AdsCampaign = {
  name: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  costPerConversion: number;
  costPerConversionLabel: string;
};

type AdsSnapshot = {
  spendTotal: number;
  impressionsTotal: number;
  clicksTotal: number;
  conversionsTotal: number;
  spendByChannel: Array<{
    channel: string;
    spend: number;
    spendShare: number;
    clicks: number;
    conversions: number;
    costPerConversion: number;
  }>;
  campaigns: AdsCampaign[];
  monthlySpend: Array<{ month: string; spend: number }>;
};

export type MarketingRange = "7d" | "30d" | "90d";
export type MarketingDateRange = {
  key: string;
  startDate: string;
  endDate: string;
  comparisonStartDate: string;
  comparisonEndDate: string;
};
export type MarketingPeriod = MarketingRange | MarketingDateRange;
export type GoogleMarketingSnapshot = {
  ga4: Ga4Snapshot | null;
  ads: AdsSnapshot | null;
  seo: SearchConsoleSnapshot | null;
  errors: { ga4?: string; ads?: string; seo?: string };
};

export function createGoogleAuth(): GoogleAuth {
  const configuredClientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientId = configuredClientId && /^\d+$/.test(configuredClientId)
    ? `${configuredClientId}.apps.googleusercontent.com`
    : configuredClientId;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google OAuth credentials are not configured");
  }

  return {
    async getAccessToken() {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, refresh_token: refreshToken!, grant_type: "refresh_token" }),
      });
      if (!response.ok) throw new Error(`Google OAuth token refresh failed (${response.status})`);
      const payload = await response.json() as { access_token?: string };
      return { token: payload.access_token ?? null };
    },
  };
}

function percentage(value: number, total: number) {
  return total ? Math.round((value / total) * 100) : 0;
}

function safeNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchGa4Snapshot(dateRange: MarketingDateRange): Promise<Ga4Snapshot> {
  const propertyId = process.env.GA4_PROPERTY_ID?.replace(/^properties\//, "");
  if (!propertyId) throw new Error("GA4 property ID is not configured");

  const accessToken = (await createGoogleAuth().getAccessToken()).token;
  if (!accessToken) throw new Error("Google OAuth access token could not be refreshed");
  const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: dateRange.startDate, endDate: dateRange.endDate }],
      dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "conversions" }],
      orderBys: [{ dimension: { dimensionName: "date" }, desc: false }],
      limit: "5000",
    }),
  });
  if (!response.ok) throw new Error(`GA4 request failed (${response.status})`);
  const responseData = await response.json() as { rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }> };
  return aggregateGa4ReportRows(responseData.rows ?? []);
}

function dateString(date: Date) {
  return date.toISOString().slice(0, 10);
}
function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function adsChannelLabel(value: string) {
  const labels: Record<string, string> = {
    DISPLAY: "Display",
    PERFORMANCE_MAX: "Performance Max",
    SEARCH: "Paid Search",
    SHOPPING: "Shopping",
    VIDEO: "Video",
  };
  return labels[value] ?? value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase());
}

async function fetchGoogleAdsSnapshot(dateRange: MarketingDateRange): Promise<AdsSnapshot> {
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID?.replace(/\D/g, "");
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!customerId) throw new Error("Google Ads customer ID is not configured");
  if (!developerToken) throw new Error("Google Ads developer token is not configured");

  const auth = createGoogleAuth();
  const accessToken = (await auth.getAccessToken()).token;
  if (!accessToken) throw new Error("Google OAuth access token could not be refreshed");

  const query = `
    SELECT
      campaign.name,
      campaign.advertising_channel_type,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions
    FROM campaign
    WHERE segments.date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'
      AND campaign.status = 'ENABLED'
  `;
  const response = await fetch(`https://googleads.googleapis.com/v23/customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "developer-token": developerToken,
      ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { "login-customer-id": process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/\D/g, "") } : {}),
    },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Google Ads request failed (${response.status}): ${detail}`);
  }

  const chunks = (await response.json()) as Array<{
    results?: Array<{
      campaign?: { name?: string; advertisingChannelType?: string };
      metrics?: { costMicros?: string; impressions?: string; clicks?: string; conversions?: string };
    }>;
  }>;
  const rows = chunks.flatMap((chunk) => chunk.results ?? []);
  const campaigns = new Map<string, AdsCampaign>();
  const channels = new Map<string, { spend: number; impressions: number; clicks: number; conversions: number }>();

  for (const row of rows) {
    const name = row.campaign?.name ?? "Unnamed campaign";
    const channel = adsChannelLabel(row.campaign?.advertisingChannelType ?? "Other");
    const spend = safeNumber(row.metrics?.costMicros) / 1_000_000;
    const impressions = safeNumber(row.metrics?.impressions);
    const clicks = safeNumber(row.metrics?.clicks);
    const conversions = safeNumber(row.metrics?.conversions);
    const existingCampaign = campaigns.get(name) ?? { name, spend: 0, impressions: 0, clicks: 0, conversions: 0, costPerConversion: 0, costPerConversionLabel: "No conv." };
    existingCampaign.spend += spend;
    existingCampaign.impressions += impressions;
    existingCampaign.clicks += clicks;
    existingCampaign.conversions += conversions;
    campaigns.set(name, existingCampaign);
    const existingChannel = channels.get(channel) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
    existingChannel.spend += spend;
    existingChannel.impressions += impressions;
    existingChannel.clicks += clicks;
    existingChannel.conversions += conversions;
    channels.set(channel, existingChannel);
  }

  const campaignRows = [...campaigns.values()]
    .map((campaign) => ({
      ...campaign,
      costPerConversion: campaign.conversions ? campaign.spend / campaign.conversions : 0,
      costPerConversionLabel: campaign.conversions ? `£${(campaign.spend / campaign.conversions).toFixed(2)}` : "No conv.",
    }))
    .sort((first, second) => second.spend - first.spend);
  const spendTotal = campaignRows.reduce((total, campaign) => total + campaign.spend, 0);
  const impressionsTotal = campaignRows.reduce((total, campaign) => total + campaign.impressions, 0);
  const clicksTotal = campaignRows.reduce((total, campaign) => total + campaign.clicks, 0);
  const conversionsTotal = campaignRows.reduce((total, campaign) => total + campaign.conversions, 0);
  let monthlySpend: Array<{ month: string; spend: number }> = [];
  try {
    monthlySpend = await fetchGoogleAdsMonthlySpend(accessToken, customerId, developerToken);
  } catch {
    // The current-period Ads snapshot remains usable if the supplemental month query is unavailable.
  }

  return {
    spendTotal,
    impressionsTotal,
    clicksTotal,
    conversionsTotal,
    spendByChannel: [...channels.entries()]
      .filter(([, values]) => values.spend > 0 || values.impressions > 0 || values.clicks > 0 || values.conversions > 0)
      .map(([channel, values]) => ({
        channel,
        ...values,
        spendShare: Number(((values.spend / (spendTotal || 1)) * 100).toFixed(1)),
        costPerConversion: values.conversions ? values.spend / values.conversions : 0,
      }))
      .sort((first, second) => second.spend - first.spend),
    campaigns: campaignRows,
    monthlySpend,
  };
}

function adsMonthlyDateRange() {
  const end = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1));
  return { start: toIsoDate(start), end: toIsoDate(end) };
}

async function fetchGoogleAdsMonthlySpend(accessToken: string, customerId: string, developerToken: string) {
  const { start, end } = adsMonthlyDateRange();
  const query = `
    SELECT
      segments.month,
      metrics.cost_micros
    FROM campaign
    WHERE segments.date BETWEEN '${start}' AND '${end}'
      AND campaign.status = 'ENABLED'
  `;
  const response = await fetch(`https://googleads.googleapis.com/v23/customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "developer-token": developerToken,
      ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { "login-customer-id": process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/\D/g, "") } : {}),
    },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    throw new Error(`Google Ads monthly spend request failed (${response.status})`);
  }

  const chunks = (await response.json()) as Array<{
    results?: Array<{
      segments?: { month?: string };
      metrics?: { costMicros?: string };
    }>;
  }>;
  const monthly = new Map<string, number>();
  for (const row of chunks.flatMap((chunk) => chunk.results ?? [])) {
    const month = row.segments?.month?.slice(0, 7);
    if (!month) continue;
    monthly.set(month, (monthly.get(month) ?? 0) + safeNumber(row.metrics?.costMicros) / 1_000_000);
  }
  return [...monthly.entries()]
    .map(([month, spend]) => ({ month, spend: Number(spend.toFixed(2)) }))
    .sort((first, second) => first.month.localeCompare(second.month));
}

let cache: { value: GoogleMarketingSnapshot; expiresAt: number; key: string } | null = null;
const inFlight = new Map<string, Promise<GoogleMarketingSnapshot>>();

export function marketingDateRangeForRange(range: MarketingRange): MarketingDateRange {
  const end = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 1));
  const days = Number.parseInt(range, 10);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const comparisonEnd = new Date(start);
  comparisonEnd.setUTCDate(comparisonEnd.getUTCDate() - 1);
  const comparisonStart = new Date(comparisonEnd);
  comparisonStart.setUTCDate(comparisonStart.getUTCDate() - days + 1);
  return {
    key: `rolling:${range}`,
    startDate: toIsoDate(start),
    endDate: toIsoDate(end),
    comparisonStartDate: toIsoDate(comparisonStart),
    comparisonEndDate: toIsoDate(comparisonEnd),
  };
}

export function marketingDateRangeForMonth(month: string): MarketingDateRange {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error("Month must use YYYY-MM format");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const nextStart = new Date(Date.UTC(year, monthIndex + 1, 1));
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const isCurrentMonth = year === now.getUTCFullYear() && monthIndex === now.getUTCMonth();
  const endExclusive = isCurrentMonth ? new Date(yesterday.getTime() + 24 * 60 * 60 * 1000) : nextStart;
  const previousStart = new Date(Date.UTC(year, monthIndex - 1, 1));
  const previousEnd = isCurrentMonth
    ? new Date(previousStart.getTime() + (endExclusive.getTime() - start.getTime()) - 24 * 60 * 60 * 1000)
    : new Date(start.getTime() - 24 * 60 * 60 * 1000);
  return {
    key: `month:${month}`,
    startDate: toIsoDate(start),
    endDate: toIsoDate(new Date(endExclusive.getTime() - 24 * 60 * 60 * 1000)),
    comparisonStartDate: toIsoDate(previousStart),
    comparisonEndDate: toIsoDate(previousEnd),
  };
}

function resolveMarketingDateRange(period: MarketingPeriod) {
  return typeof period === "string" ? marketingDateRangeForRange(period) : period;
}

export async function fetchGoogleMarketingSnapshot(period: MarketingPeriod = "30d") {
  const dateRange = resolveMarketingDateRange(period);
  if (cache && cache.key === dateRange.key && cache.expiresAt > Date.now()) return cache.value;
  const existingInFlight = inFlight.get(dateRange.key);
  if (existingInFlight) return existingInFlight;

  const request = Promise.allSettled([fetchGa4Snapshot(dateRange), fetchGoogleAdsSnapshot(dateRange), fetchSearchConsoleSnapshot(dateRange)]).then(([ga4Result, adsResult, seoResult]) => {
    const value: GoogleMarketingSnapshot = {
      ga4: ga4Result.status === "fulfilled" ? ga4Result.value : null,
      ads: adsResult.status === "fulfilled" ? adsResult.value : null,
      seo: seoResult.status === "fulfilled" ? seoResult.value : null,
      errors: {
        ...(ga4Result.status === "rejected" ? { ga4: ga4Result.reason instanceof Error ? ga4Result.reason.message : "GA4 request failed" } : {}),
        ...(adsResult.status === "rejected" ? { ads: adsResult.reason instanceof Error ? adsResult.reason.message : "Google Ads request failed" } : {}),
        ...(seoResult.status === "rejected" ? { seo: seoResult.reason instanceof Error ? seoResult.reason.message : "Google Search Console request failed" } : {}),
      },
    };
    return value;
  });
  inFlight.set(dateRange.key, request);

  try {
    const value = await request;
    if (value.ga4 || value.ads || value.seo) cache = { value, expiresAt: Date.now() + 5 * 60 * 1000, key: dateRange.key };
    return value;
  } finally {
    inFlight.delete(dateRange.key);
  }
}

function searchConsoleQueryOpportunity(impressions: number, position: number, ctr: number) {
  if ((position > 10 && position <= 20 && impressions >= 30) || (position > 3 && position <= 10 && impressions >= 50 && ctr < 5)) return "high" as const;
  if (position <= 30 && impressions >= 10) return "medium" as const;
  return "low" as const;
}

function searchConsoleDateRanges(dateRange: MarketingDateRange) {
  // Search Console data can lag by a couple of days, so use finalized data
  // through three days ago rather than presenting a partial current day.
  const latestDate = dateString(subtractDays(new Date(), 3));
  const endDate = dateRange.endDate < latestDate ? dateRange.endDate : latestDate;
  const comparisonEndDate = dateRange.comparisonEndDate < latestDate ? dateRange.comparisonEndDate : latestDate;
  return {
    startDate: dateRange.startDate,
    endDate,
    comparisonStartDate: dateRange.comparisonStartDate,
    comparisonEndDate,
  };
}

function aggregateSearchConsoleRows(rows: SearchConsoleRow[]) {
  const byQuery = new Map<string, { clicks: number; impressions: number; positionTotal: number; pages: Map<string, number> }>();
  for (const row of rows) {
    const keyword = row.keys?.[0]?.trim();
    if (!keyword) continue;
    const clicks = safeNumber(row.clicks);
    const impressions = safeNumber(row.impressions);
    const position = safeNumber(row.position);
    const page = row.keys?.[1] ?? "";
    const current = byQuery.get(keyword) ?? { clicks: 0, impressions: 0, positionTotal: 0, pages: new Map<string, number>() };
    current.clicks += clicks;
    current.impressions += impressions;
    current.positionTotal += position * impressions;
    if (page) current.pages.set(page, (current.pages.get(page) ?? 0) + clicks);
    byQuery.set(keyword, current);
  }
  return byQuery;
}

async function fetchSearchConsoleSnapshot(dateRange: MarketingDateRange): Promise<SearchConsoleSnapshot> {
  const configuredProperty = process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL?.trim();
  const property = configuredProperty;
  if (!property) throw new Error("GOOGLE_SEARCH_CONSOLE_SITE_URL is not configured");
  const accessToken = (await createGoogleAuth().getAccessToken()).token;
  if (!accessToken) throw new Error("Google OAuth access token could not be refreshed");
  const ranges = searchConsoleDateRanges(dateRange);
  const request = async (startDate: string, endDate: string) => {
    const response = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
      startDate,
      endDate,
      dimensions: ["query", "page"],
      searchType: "web",
      aggregationType: "auto",
      dataState: "final",
      rowLimit: 5000,
      }),
    });
    if (!response.ok) throw new Error(`Search Console request failed (${response.status})`);
    return response.json() as Promise<{ rows?: SearchConsoleRow[] }>;
  };
  const [currentResponse, previousResponse] = await Promise.all([
    request(ranges.startDate, ranges.endDate),
    request(ranges.comparisonStartDate, ranges.comparisonEndDate),
  ]);
  const currentRows = currentResponse.rows ?? [];
  const previousRows = previousResponse.rows ?? [];
  const queries = toSearchConsoleQueries(currentRows, previousRows);
  const clicks = currentRows.reduce((total, row) => total + safeNumber(row.clicks), 0);
  const impressions = currentRows.reduce((total, row) => total + safeNumber(row.impressions), 0);
  const weightedPosition = currentRows.reduce((total, row) => total + safeNumber(row.position) * safeNumber(row.impressions), 0);
  const previousClicks = previousRows.reduce((total, row) => total + safeNumber(row.clicks), 0);
  const previousImpressions = previousRows.reduce((total, row) => total + safeNumber(row.impressions), 0);
  const changePercent = (value: number, previousValue: number) => previousValue ? Number((((value - previousValue) / previousValue) * 100).toFixed(1)) : 0;

  return {
    property: property ?? "",
    ...ranges,
    clicks: Math.round(clicks * 100) / 100,
    impressions: Math.round(impressions * 100) / 100,
    ctr: impressions ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
    averagePosition: impressions ? Number((weightedPosition / impressions).toFixed(2)) : 0,
    clicksChange: changePercent(clicks, previousClicks),
    impressionsChange: changePercent(impressions, previousImpressions),
    queryCount: queries.length,
    queries,
  };
}

type SearchConsoleRow = {
  keys?: string[] | null;
  clicks?: number | null;
  impressions?: number | null;
  ctr?: number | null;
  position?: number | null;
};

function toSearchConsoleQueries(currentRows: SearchConsoleRow[], previousRows: SearchConsoleRow[]) {
  const current = aggregateSearchConsoleRows(currentRows);
  const previous = aggregateSearchConsoleRows(previousRows);
  return [...current.entries()]
    .map(([keyword, values]) => {
      const averagePosition = values.impressions ? values.positionTotal / values.impressions : 0;
      const previousValues = previous.get(keyword);
      const previousPosition = previousValues?.impressions ? previousValues.positionTotal / previousValues.impressions : averagePosition;
      const ctr = values.impressions ? (values.clicks / values.impressions) * 100 : 0;
      const landingPage = [...values.pages.entries()].sort((first, second) => second[1] - first[1])[0]?.[0] ?? "";
      return {
        keyword,
        clicks: Math.round(values.clicks * 100) / 100,
        impressions: Math.round(values.impressions * 100) / 100,
        ctr: Math.round(ctr * 100) / 100,
        averagePosition: Math.round(averagePosition * 100) / 100,
        positionChange: Math.round((previousPosition - averagePosition) * 100) / 100,
        landingPage,
        intent: "Search Console",
        opportunity: searchConsoleQueryOpportunity(values.impressions, averagePosition, ctr),
      };
    })
    .sort((first, second) => second.impressions - first.impressions)
    .slice(0, 100);
}

export type SearchConsoleSnapshot = {
  property: string;
  startDate: string;
  endDate: string;
  comparisonStartDate: string;
  comparisonEndDate: string;
  clicks: number;
  impressions: number;
  ctr: number;
  averagePosition: number;
  clicksChange: number;
  impressionsChange: number;
  queryCount: number;
  queries: SearchConsoleQuery[];
};

function subtractDays(date: Date, days: number) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

type SearchConsoleQuery = {
  keyword: string;
  clicks: number;
  impressions: number;
  ctr: number;
  averagePosition: number;
  positionChange: number;
  landingPage: string;
  intent: string;
  opportunity: "high" | "medium" | "low";
};
