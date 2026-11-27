import { fetchHubSpotSnapshot } from "../integrations/hubspot.js";
import {
  fetchGoogleMarketingSnapshot,
  marketingDateRangeForMonth,
} from "../integrations/google-marketing.js";
import { fetchClaritySnapshot } from "../integrations/microsoft-clarity.js";
import { workbookShopifySales } from "../integrations/shopify-sales.js";
import { buildLiveChannelMix } from "./marketingOverviewMetrics.js";

export type MonthlyMarketingReport = {
  month: string;
  monthLabel: string;
  startDate: string;
  endDate: string;
  generatedAt: string;
  sources: Array<{
    label: string;
    status: "live" | "unavailable" | "rolling" | "reference";
    detail: string;
  }>;
  metrics: Array<{
    label: string;
    value: string;
    detail: string;
    sourceStatus: "live" | "unavailable";
  }>;
  campaigns: Array<{
    name: string;
    spend: string;
    clicks: string;
    conversions: string;
    costPerConversion: string;
  }>;
  clarity: {
    status: "rolling" | "unavailable";
    capturedAt: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    numOfDays: number | null;
    message: string;
    metrics: Array<{ label: string; value: string }>;
    behavior: Array<{ label: string; events: string; sessions: string; rate: string }>;
    popularPages: Array<{ url: string; visits: string }>;
  };
  channels: Array<{
    channel: string;
    sessions: string;
    leads: string;
    conversionRate: string;
    costPerLead: string;
  }>;
  searchQueries: Array<{
    keyword: string;
    clicks: string;
    impressions: string;
    ctr: string;
    averagePosition: string;
  }>;
  notes: string[];
};

function formatGBP(value: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits }).format(value);
}

function monthLabel(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function reportMetric(
  label: string,
  value: string,
  detail: string,
  sourceStatus: "live" | "unavailable",
) {
  return { label, value, detail, sourceStatus };
}

export async function loadMonthlyMarketingReport(
  month: string,
  generatedAt = new Date(),
): Promise<MonthlyMarketingReport> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("Marketing report month must use YYYY-MM format");
  }

  const dateRange = marketingDateRangeForMonth(month);
  const [hubSpotResult, googleResult, clarityResult] = await Promise.allSettled([
    fetchHubSpotSnapshot(dateRange),
    fetchGoogleMarketingSnapshot(dateRange),
    fetchClaritySnapshot(),
  ]);
  const hubSpot = hubSpotResult.status === "fulfilled" ? hubSpotResult.value : null;
  const google = googleResult.status === "fulfilled" ? googleResult.value : null;
  const clarity = clarityResult.status === "fulfilled" ? clarityResult.value : null;
  const ads = google?.ads ?? null;
  const ga4 = google?.ga4 ?? null;
  const seo = google?.seo ?? null;
  const costsLive = ads !== null && hubSpot !== null;
  const adSpend = ads?.spendTotal ?? 0;
  const dealCount = hubSpot?.dealsCreated ?? 0;
  const newContactCount = hubSpot?.newContacts ?? 0;

  const sources: MonthlyMarketingReport["sources"] = [
    {
      label: "Google Ads",
      status: ads ? "live" : "unavailable",
      detail: ads ? "Live campaign data for the reporting month." : "Live data unavailable; reference values are not used.",
    },
    {
      label: "HubSpot CRM",
      status: hubSpot ? "live" : "unavailable",
      detail: hubSpot ? "Live contacts and deals created in the reporting month." : "Live data unavailable; reference values are not used.",
    },
    {
      label: "Google Analytics 4",
      status: ga4 ? "live" : "unavailable",
      detail: ga4 ? "Live acquisition data for the reporting month." : "Live data unavailable; reference values are not used.",
    },
    {
      label: "Google Search Console",
      status: seo ? "live" : "unavailable",
      detail: seo
        ? `Live search data for ${seo.property}.`
        : "Live data unavailable; reference SEO values are intentionally omitted.",
    },
    {
      label: "Microsoft Clarity",
      status: clarity?.source === "live" ? "rolling" : "unavailable",
      detail: clarity?.source === "live"
        ? `Live rolling window ${clarity.windowStart} to ${clarity.windowEnd}; not included in month totals.`
        : "No live Clarity data; this source is not included in month totals.",
    },
    {
      label: "Shopify sales",
      status: "reference",
      detail: `Imported workbook captured ${workbookShopifySales.capturedAt}; not a live, month-scoped source and excluded from month totals.`,
    },
  ];

  const claritySection: MonthlyMarketingReport["clarity"] = clarity?.source === "live"
    ? {
        status: "rolling",
        capturedAt: clarity.capturedAt,
        windowStart: clarity.windowStart,
        windowEnd: clarity.windowEnd,
        numOfDays: clarity.numOfDays,
        message: clarity.enhancedMetricsAvailable
          ? ""
          : clarity.message || "Enhanced behaviour and page details are not available in this snapshot.",
        metrics: [
          { label: "Sessions", value: formatNumber(clarity.sessions) },
          { label: "Users", value: formatNumber(clarity.users) },
          { label: "Bot sessions", value: formatNumber(clarity.botSessions) },
          { label: "Pages per session", value: formatNumber(clarity.pagesPerSession, 2) },
          { label: "Average scroll depth", value: `${formatNumber(clarity.scrollDepth, 1)}%` },
        ],
        behavior: clarity.enhancedMetricsAvailable
          ? [
              ["Dead clicks", clarity.behavior.deadClicks],
              ["Excessive scrolls", clarity.behavior.excessiveScrolls],
              ["Rage clicks", clarity.behavior.rageClicks],
              ["Quickbacks", clarity.behavior.quickbacks],
              ["Script errors", clarity.behavior.scriptErrors],
              ["Error clicks", clarity.behavior.errorClicks],
            ].map(([label, metric]) => ({
              label: label as string,
              events: formatNumber((metric as typeof clarity.behavior.deadClicks).events),
              sessions: formatNumber((metric as typeof clarity.behavior.deadClicks).sessions),
              rate: `${formatNumber((metric as typeof clarity.behavior.deadClicks).rate, 1)}%`,
            }))
          : [],
        popularPages: clarity.enhancedMetricsAvailable
          ? clarity.popularPages.slice(0, 10).map((page) => ({
              url: page.url,
              visits: formatNumber(page.visits),
            }))
          : [],
      }
    : {
        status: "unavailable",
        capturedAt: null,
        windowStart: null,
        windowEnd: null,
        numOfDays: null,
        message: clarity?.message || "No live Clarity snapshot was available when this report was generated.",
        metrics: [],
        behavior: [],
        popularPages: [],
      };

  const metrics: MonthlyMarketingReport["metrics"] = [
    reportMetric(
      "Cost per deal",
      costsLive
        ? dealCount > 0
          ? formatGBP(adSpend / dealCount)
          : "No deals"
        : "Unavailable",
      costsLive
        ? dealCount > 0
          ? `Google Ads spend divided by ${formatNumber(dealCount)} new HubSpot deals created.`
          : "No HubSpot deals were created in this period."
        : "Requires live Google Ads and HubSpot data.",
      costsLive ? "live" : "unavailable",
    ),
    reportMetric(
      "Cost per lead",
      costsLive
        ? newContactCount > 0
          ? formatGBP(adSpend / newContactCount)
          : "No leads"
        : "Unavailable",
      costsLive
        ? newContactCount > 0
          ? `Google Ads spend divided by ${formatNumber(newContactCount)} new HubSpot contacts, used as the lead count.`
          : "No new HubSpot contacts were recorded in this period."
        : "Requires live Google Ads and HubSpot data.",
      costsLive ? "live" : "unavailable",
    ),
    reportMetric("Google Ads spend", ads ? formatGBP(ads.spendTotal) : "Unavailable", ads ? "Live Google Ads campaign spend." : "Google Ads data unavailable.", ads ? "live" : "unavailable"),
    reportMetric("Google Ads clicks", ads ? formatNumber(ads.clicksTotal) : "Unavailable", ads ? "Live Google Ads clicks." : "Google Ads data unavailable.", ads ? "live" : "unavailable"),
    reportMetric("Google Ads conversions", ads ? formatNumber(ads.conversionsTotal, 1) : "Unavailable", ads ? "Live Google Ads conversions." : "Google Ads data unavailable.", ads ? "live" : "unavailable"),
    reportMetric("New HubSpot contacts", hubSpot ? formatNumber(hubSpot.newContacts) : "Unavailable", hubSpot ? "Contacts created in the reporting month." : "HubSpot data unavailable.", hubSpot ? "live" : "unavailable"),
    reportMetric("HubSpot deals created", hubSpot ? formatNumber(hubSpot.dealsCreated) : "Unavailable", hubSpot ? "Deals created in the reporting month." : "HubSpot data unavailable.", hubSpot ? "live" : "unavailable"),
    reportMetric("GA4 sessions", ga4 ? formatNumber(ga4.sessionsTotal) : "Unavailable", ga4 ? "Live Google Analytics 4 sessions." : "Google Analytics 4 data unavailable.", ga4 ? "live" : "unavailable"),
    reportMetric("Search clicks", seo ? formatNumber(seo.clicks) : "Unavailable", seo ? "Live Google Search Console clicks." : "Search Console data unavailable.", seo ? "live" : "unavailable"),
    reportMetric("Search impressions", seo ? formatNumber(seo.impressions) : "Unavailable", seo ? "Live Google Search Console impressions." : "Search Console data unavailable.", seo ? "live" : "unavailable"),
  ];

  return {
    month,
    monthLabel: monthLabel(month),
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    generatedAt: generatedAt.toISOString(),
    sources,
    metrics,
    clarity: claritySection,
    campaigns: (ads?.campaigns ?? []).map((campaign) => ({
      name: campaign.name,
      spend: formatGBP(campaign.spend),
      clicks: formatNumber(campaign.clicks),
      conversions: formatNumber(campaign.conversions, 1),
      costPerConversion: campaign.costPerConversionLabel,
    })),
    channels: ga4 && hubSpot
      ? buildLiveChannelMix(ga4.channels, hubSpot.contactSources, ads?.spendByChannel).map((channel) => ({
          channel: channel.channel,
          sessions: formatNumber(channel.sessions),
          leads: channel.leads === undefined ? "Unavailable" : formatNumber(channel.leads),
          conversionRate: channel.conversionRate === undefined ? "Unavailable" : `${formatNumber(channel.conversionRate, 1)}%`,
          costPerLead: channel.costPerLead === undefined ? "Unavailable" : formatGBP(channel.costPerLead),
        }))
      : [],
    searchQueries: (seo?.queries ?? [])
      .slice()
      .sort((first, second) => second.impressions - first.impressions)
      .slice(0, 10)
      .map((query) => ({
        keyword: query.keyword,
        clicks: formatNumber(query.clicks),
        impressions: formatNumber(query.impressions),
        ctr: `${formatNumber(query.ctr, 1)}%`,
        averagePosition: formatNumber(query.averagePosition, 1),
      })),
    notes: [
      "Only live API data is shown as live. Sample dashboard values and reference SEO values are not included.",
      "Cost per lead uses new HubSpot contacts as the lead count. Cost per deal uses HubSpot deals created during the month.",
      "Clarity is shown as a separate rolling snapshot with its own dates, not as a monthly total. The Shopify workbook is imported reference data and is excluded from live month totals.",
    ],
  };
}
