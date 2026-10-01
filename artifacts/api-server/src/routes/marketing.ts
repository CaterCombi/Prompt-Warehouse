import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { db, marketingRecommendationOverrides } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetMarketingOverviewQueryParams,
  GetMarketingOverviewResponse,
  ListMarketingRecommendationsResponse,
  UpdateMarketingRecommendationBody,
  UpdateMarketingRecommendationParams,
  UpdateMarketingRecommendationResponse,
} from "@workspace/api-zod";
import { fetchHubSpotSnapshot } from "../integrations/hubspot";
import { buildAcquisitionTrend, buildLiveChannelMix } from "../lib/marketingOverviewMetrics";
import {
  fetchGoogleMarketingSnapshot,
  marketingDateRangeForMonth,
  marketingDateRangeForRange,
  type GoogleMarketingSnapshot,
  type MarketingDateRange,
  type MarketingRange,
} from "../integrations/google-marketing";
import { fetchClaritySnapshot, unavailableClaritySnapshot } from "../integrations/microsoft-clarity";
import { workbookShopifySales } from "../integrations/shopify-sales";

const router: IRouter = Router();
router.use(requireAuth);

const referenceRecommendations = [
  {
    id: "seo-pricing-page",
    title: "Refresh the pricing page for high-intent search",
    description:
      "The page is already visible for a commercial query. Add proof points, clearer comparison copy, and stronger internal links to move it into the top 10.",
    category: "seo" as const,
    priority: "high" as const,
    impact: "Est. +120 qualified visits / month",
    effort: "2–3 days",
    status: "open" as const,
    metric: "Position 14 → target top 10",
    isSample: true,
  },
  {
    id: "seo-comparison-content",
    title: "Create a comparison page for the rising query",
    description:
      "A fast-growing keyword sits just outside page one with manageable difficulty. Build a focused comparison page and link it from the product hub.",
    category: "content" as const,
    priority: "high" as const,
    impact: "Est. +80 qualified visits / month",
    effort: "4–5 days",
    status: "in_progress" as const,
    metric: "Searches +28% month over month",
    isSample: true,
  },
  {
    id: "paid-branded-efficiency",
    title: "Protect paid budget on branded terms",
    description:
      "Branded paid traffic converts efficiently, but spend is rising faster than lead volume. Review query overlap and add negative terms before the next budget cycle.",
    category: "paid" as const,
    priority: "medium" as const,
    impact: "Potential 12% CPL reduction",
    effort: "Half day",
    status: "open" as const,
    metric: "Paid CPL £42 vs organic £18",
    isSample: true,
  },
  {
    id: "conversion-demo-form",
    title: "Shorten the demo form on the top landing page",
    description:
      "The highest-traffic organic landing page has strong engagement but under-indexes on form completion. Test a shorter form and surface the primary CTA earlier.",
    category: "conversion" as const,
    priority: "medium" as const,
    impact: "Potential +0.8pp conversion rate",
    effort: "1–2 days",
    metric: "Form completion 2.4%",
    status: "open" as const,
    isSample: true,
  },
  {
    id: "seo-technical-audit",
    title: "Resolve crawl issues before publishing new content",
    description:
      "A small set of technical issues could reduce the return from new content. Validate canonical tags, sitemap coverage, and indexability on priority templates.",
    category: "seo" as const,
    priority: "low" as const,
    impact: "Protects organic growth",
    effort: "1 day",
    status: "done" as const,
    metric: "92% technical health",
    isSample: true,
  },
];

const trend = [
  { date: "04 Aug", organicSessions: 3100, paidSessions: 1840, newContacts: 38, spend: 1180 },
  { date: "08 Aug", organicSessions: 3260, paidSessions: 1910, newContacts: 41, spend: 1230 },
  { date: "12 Aug", organicSessions: 3400, paidSessions: 2050, newContacts: 45, spend: 1310 },
  { date: "16 Aug", organicSessions: 3580, paidSessions: 2110, newContacts: 48, spend: 1350 },
  { date: "20 Aug", organicSessions: 3740, paidSessions: 2180, newContacts: 52, spend: 1420 },
  { date: "24 Aug", organicSessions: 3910, paidSessions: 2260, newContacts: 55, spend: 1460 },
  { date: "28 Aug", organicSessions: 4070, paidSessions: 2330, newContacts: 58, spend: 1510 },
  { date: "01 Sep", organicSessions: 4280, paidSessions: 2410, newContacts: 62, spend: 1550 },
];

const overview = {
  asOf: "2026-09-01T09:00:00+01:00",
  dataMode: "sample" as const,
  kpis: [
    { key: "qualifiedLeads", label: "Qualified leads", value: "62", change: 18.4, trend: "up" as const, source: "HubSpot", isSample: true },
    { key: "organicSessions", label: "Organic sessions", value: "28.4k", change: 12.7, trend: "up" as const, source: "Analytics", isSample: true },
    { key: "costPerDeal", label: "Cost per deal", value: "£42", change: -8.6, trend: "up" as const, source: "PPC + HubSpot", isSample: true },
    { key: "costPerContact", label: "Cost per contact", value: "£24", change: 0, trend: "flat" as const, source: "PPC + HubSpot", isSample: true },
    { key: "visibility", label: "SEO visibility", value: "68", change: 6.2, trend: "up" as const, source: "SEO", isSample: true },
  ],
  trend,
  channels: [
    { channel: "Organic search", sessions: 28400, leads: 62, conversionRate: 3.1, costPerLead: 18, color: "#1a8f77" },
    { channel: "Paid search", sessions: 16800, leads: 41, conversionRate: 2.4, costPerLead: 42, color: "#e98945" },
    { channel: "Direct", sessions: 9800, leads: 24, conversionRate: 2.5, costPerLead: 0, color: "#6b7aa1" },
    { channel: "Referral", sessions: 5200, leads: 13, conversionRate: 2.5, costPerLead: 11, color: "#a896d8" },
  ],
  seoKeywords: [
    { keyword: "commercial kitchen planning", intent: "Commercial", position: 7, change: 4, volume: 880, difficulty: 42, opportunity: "high" as const, landingPage: "/solutions/planning" },
    { keyword: "restaurant equipment finance", intent: "Commercial", position: 14, change: 6, volume: 720, difficulty: 38, opportunity: "high" as const, landingPage: "/guides/equipment-finance" },
    { keyword: "best catering equipment", intent: "Research", position: 18, change: -2, volume: 1300, difficulty: 61, opportunity: "medium" as const, landingPage: "/guides/catering-equipment" },
    { keyword: "energy efficient kitchen", intent: "Research", position: 23, change: 9, volume: 590, difficulty: 34, opportunity: "high" as const, landingPage: "/insights/energy-efficiency" },
    { keyword: "commercial combi oven", intent: "Product", position: 31, change: 1, volume: 2400, difficulty: 72, opportunity: "low" as const, landingPage: "/products/combi-ovens" },
  ],
  sources: [
    { name: "hubspot", label: "HubSpot CRM", status: "sample" as const, lastSynced: "Live read pending" },
    { name: "analytics", label: "Google Analytics 4", status: "needs_connection" as const, lastSynced: "Connector unavailable" },
    { name: "ppc", label: "Google Ads / PPC", status: "needs_connection" as const, lastSynced: "Connector unavailable" },
    { name: "seo", label: "Google Search Console", status: "sample" as const, lastSynced: "Reference fallback · property unavailable" },
    { name: "clarity", label: "Microsoft Clarity", status: "needs_connection" as const, lastSynced: "API token pending" },
    { name: "shopify", label: "Shopify sales", status: "sample" as const, lastSynced: "Imported workbook · 17 Sep 2026" },
  ],
  recommendations: referenceRecommendations,
  sourceSnapshot: {
    capturedAt: "2026-09-01",
    headline: "Spend down 10.7%, conversions up 55.2% — efficiency improving",
    kpis: [
      { key: "spend", label: "Spend", value: "£2,777.84", change: -10.7, trend: "down" as const, comparison: "vs £3,109.34", targetPercent: 93, targetValue: "£3,000.00" },
      { key: "clicks", label: "Clicks", value: "1,205", change: -41.8, trend: "down" as const, comparison: "vs 2,070", targetPercent: 93, targetValue: "1,300" },
      { key: "impressions", label: "Impressions", value: "21,604", change: 0, trend: "flat" as const, comparison: "Reference report", targetPercent: 86, targetValue: "25,000" },
      { key: "sessions", label: "Sessions", value: "2,270", change: 45.8, trend: "up" as const, comparison: "vs 1,557", targetPercent: 91, targetValue: "2,500" },
      { key: "conversions", label: "Conversions", value: "90", change: 55.2, trend: "up" as const, comparison: "vs 58", targetPercent: 300, targetValue: "30" },
      { key: "newContacts", label: "New contacts (30d)", value: "95", change: 10.5, trend: "up" as const, comparison: "vs 86", targetPercent: 95, targetValue: "100" },
      { key: "dealsCreated", label: "Deals created (30d)", value: "47", change: 0, trend: "flat" as const, comparison: "Reference report", targetPercent: 94, targetValue: "50" },
      { key: "pipeline", label: "Pipeline", value: "£106,862.30", change: -34.2, trend: "down" as const, comparison: "vs £162,513.00", targetPercent: 71, targetValue: "£150,000.00" },
    ],
    ga4SessionsTotal: 2280,
    ga4Channels: [
      { label: "Direct", value: 1196, share: 52 },
      { label: "Organic Search", value: 328, share: 14 },
      { label: "Unassigned", value: 203, share: 9 },
      { label: "Cross-network", value: 175, share: 8 },
      { label: "Paid Social", value: 174, share: 8 },
      { label: "Paid Search", value: 138, share: 6 },
      { label: "Referral", value: 28, share: 1 },
      { label: "AI Assistant", value: 20, share: 1 },
      { label: "Organic Social", value: 7, share: 0 },
      { label: "Paid Other", value: 5, share: 0 },
      { label: "Organic Shopping", value: 3, share: 0 },
      { label: "Email", value: 2, share: 0 },
      { label: "Organic Video", value: 1, share: 0 },
    ],
    hubspotContactsTotal: 95,
    hubspotNewContacts: 95,
    hubspotDealsCreated: 47,
    hubspotContactSources: [
      { label: "Offline", value: 80, share: 84 },
      { label: "Direct", value: 7, share: 7 },
      { label: "Paid Search", value: 4, share: 4 },
      { label: "Organic Search", value: 3, share: 3 },
      { label: "Email", value: 1, share: 1 },
    ],
    pipelineTotal: 106862.3,
    pipelineBoards: [
      { label: "CaterCombi Sales", value: 72800, displayValue: "£72.8k" },
      { label: "Rental Pipeline", value: 34062.3, displayValue: "£34.1k" },
      { label: "CaterCombi PartEx", value: 0, displayValue: "£0" },
    ],
    sixMonthTrend: [],
    spendTotal: 2777.84,
    adsImpressionsTotal: 21604,
    spendByChannel: [
      { channel: "Paid Search", spend: 2126.21, spendShare: 76.5, impressions: 0, clicks: 689, conversions: 14, costPerConversion: 151.87 },
      { channel: "Performance Max", spend: 651.63, spendShare: 23.5, impressions: 0, clicks: 516, conversions: 13, costPerConversion: 50.13 },
    ],
    campaigns: [
      { name: "Vert | Search | Oven Brands | Rational", spend: 972.96, impressions: 0, clicks: 309, conversions: 5, costPerConversion: 194.59, costPerConversionLabel: "£194.59" },
      { name: "Vert | Performance Max | Generic", spend: 651.63, impressions: 0, clicks: 516, conversions: 13, costPerConversion: 50.13, costPerConversionLabel: "£50.13" },
      { name: "Vert | Search | Commercial Ovens", spend: 164.57, impressions: 0, clicks: 237, conversions: 0, costPerConversion: 0, costPerConversionLabel: "No conv." },
      { name: "Vert | Search | Oven Rental", spend: 295.69, impressions: 0, clicks: 41, conversions: 1, costPerConversion: 295.69, costPerConversionLabel: "£295.69" },
      { name: "Vert | Search | Refurb/Used", spend: 226.31, impressions: 0, clicks: 52, conversions: 0, costPerConversion: 0, costPerConversionLabel: "No conv." },
      { name: "Vert | Search | Brand", spend: 226.68, impressions: 0, clicks: 50, conversions: 8, costPerConversion: 2.08, costPerConversionLabel: "£2.08" },
    ],
    clarity: unavailableClaritySnapshot("Microsoft Clarity is not connected."),
    caveat: "Snapshot transcribed from the supplied CaterCombi dashboard screenshots. Pipeline board amounts and six-month chart points are visual reconstructions where the source did not display exact labels.",
  },
  shopifySales: workbookShopifySales,
  seoVisibility: {
    source: "reference" as const,
    property: null,
    startDate: "2026-08-02",
    endDate: "2026-08-31",
    comparisonStartDate: "2026-07-03",
    comparisonEndDate: "2026-08-01",
    clicks: 0,
    impressions: 0,
    ctr: 0,
    averagePosition: 0,
    clicksChange: 0,
    impressionsChange: 0,
    queryCount: 5,
    isSample: true,
    fallbackReason: "Google Search Console property unavailable; showing reference keyword values.",
  },
};

function formatGBP(value: number) {
  return `£${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCompact(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toLocaleString("en-GB");
}

function buildSixMonthDealTrend(ads: GoogleMarketingSnapshot["ads"], hubSpot: HubSpotSnapshot | null) {
  if (!ads?.monthlySpend.length || !hubSpot?.monthlyDeals.length) return [];
  const now = new Date();
  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + index, 1));
    const month = date.toISOString().slice(0, 7);
    const spend = ads.monthlySpend.find((item) => item.month === month)?.spend ?? 0;
    const dealsCreated = hubSpot.monthlyDeals.find((item) => item.month === month)?.dealsCreated ?? 0;
    return {
      date: date.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }),
      dealsCreated,
      adSpend: spend,
      costPerDeal: dealsCreated ? Number((spend / dealsCreated).toFixed(2)) : 0,
    };
  });
}

const sourceTargets = {
  spend: 3000,
  clicks: 1300,
  impressions: 25000,
  sessions: 2500,
  conversions: 30,
  newContacts: 100,
  dealsCreated: 50,
  pipeline: 150000,
} as const;

function targetPercentFor(key: string, value: number) {
  const target = sourceTargets[key as keyof typeof sourceTargets];
  return target ? Math.round((value / target) * 100) : 0;
}

function referenceSeoVisibility(dateRange: MarketingDateRange, reason?: string) {
  const end = new Date(`${dateRange.endDate}T00:00:00Z`);
  const start = new Date(`${dateRange.startDate}T00:00:00Z`);
  const comparisonEnd = new Date(`${dateRange.comparisonEndDate}T00:00:00Z`);
  const comparisonStart = new Date(`${dateRange.comparisonStartDate}T00:00:00Z`);
  const dateString = (date: Date) => date.toISOString().slice(0, 10);
  return {
    ...overview.seoVisibility,
    startDate: dateString(start),
    endDate: dateString(end),
    comparisonStartDate: dateString(comparisonStart),
    comparisonEndDate: dateString(comparisonEnd),
    fallbackReason: reason ? `Google Search Console unavailable: ${reason}. Showing reference keyword values.` : overview.seoVisibility.fallbackReason,
  };
}

function requestedMarketingDateRange(query: { period?: "rolling" | "month"; range: MarketingRange; month?: string }) {
  if (query.period === "month") {
    const month = query.month ?? new Date().toISOString().slice(0, 7);
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (month > currentMonth) throw new Error("Future months are not available");
    return marketingDateRangeForMonth(month);
  }
  return marketingDateRangeForRange(query.range);
}

type RecommendationStatus = "open" | "in_progress" | "done" | "dismissed";
type HubSpotSnapshot = Awaited<ReturnType<typeof fetchHubSpotSnapshot>>;
type SearchConsoleSnapshot = GoogleMarketingSnapshot["seo"];
type RecommendationRecord = {
  id: string;
  title: string;
  description: string;
  category: "seo" | "paid" | "content" | "conversion";
  priority: "high" | "medium" | "low";
  impact: string;
  effort: string;
  status: RecommendationStatus;
  metric: string;
  isSample: boolean;
};


function campaignSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

function buildLiveRecommendations(hubSpot: HubSpotSnapshot | null, ads: GoogleMarketingSnapshot["ads"], seo: SearchConsoleSnapshot) {
  const liveRecommendations: RecommendationRecord[] = [];
  if (ads) {
    const noConversionCampaign = ads.campaigns.find((campaign) => campaign.spend >= 100 && campaign.conversions === 0);
    if (noConversionCampaign) {
      liveRecommendations.push({
        id: `ads-no-conversions-${campaignSlug(noConversionCampaign.name)}`,
        title: `Review ${noConversionCampaign.name}`,
        description: "This campaign has meaningful spend but no recorded conversions in the current Google Ads window. Check search terms, landing-page intent, and conversion tracking before adding budget.",
        category: "paid",
        priority: "high",
        impact: `Protects ${formatGBP(noConversionCampaign.spend)} in spend`,
        effort: "Half day",
        status: "open",
        metric: `${formatGBP(noConversionCampaign.spend)} spend · 0 conversions`,
        isSample: false,
      });
    }

    const paidCpl = ads.conversionsTotal ? ads.spendTotal / ads.conversionsTotal : 0;
    const expensiveCampaign = ads.campaigns.find((campaign) => campaign.conversions > 0 && paidCpl > 0 && campaign.costPerConversion > paidCpl * 1.5);
    if (expensiveCampaign) {
      liveRecommendations.push({
        id: `ads-high-cpl-${campaignSlug(expensiveCampaign.name)}`,
        title: `Tighten ${expensiveCampaign.name}`,
        description: "This campaign is materially more expensive than the account average. Review its targeting and query mix, then compare lead quality in HubSpot before scaling it.",
        category: "paid",
        priority: "medium",
        impact: `Reduce paid CPL from ${formatGBP(expensiveCampaign.costPerConversion)}`,
        effort: "1 day",
        status: "open",
        metric: `${formatGBP(expensiveCampaign.costPerConversion)} / conversion vs ${formatGBP(paidCpl)} account average`,
        isSample: false,
      });
    }
  }

  if (seo) {
    seo.queries
      .filter((query) => query.opportunity === "high")
      .slice(0, 3)
      .forEach((query) => {
        liveRecommendations.push({
          id: `gsc-visibility-${campaignSlug(query.keyword)}`,
          title: `Improve visibility for “${query.keyword}”`,
          description: `Google Search Console shows ${query.impressions.toLocaleString("en-GB")} impressions for this query at an average position of ${query.averagePosition.toFixed(1)}. Refresh the matching page${query.landingPage ? ` (${query.landingPage})` : ""} to improve click-through and ranking.`,
          category: "seo",
          priority: "high",
          impact: `Capture more of ${query.impressions.toLocaleString("en-GB")} impressions`,
          effort: "1–2 days",
          status: "open",
          metric: `${query.clicks.toLocaleString("en-GB")} clicks · ${query.impressions.toLocaleString("en-GB")} impressions · ${query.ctr.toFixed(2)}% CTR · avg pos ${query.averagePosition.toFixed(1)} · ${seo.property} · ${seo.startDate}–${seo.endDate}`,
          isSample: false,
        });
      });
  }

  if (ads && hubSpot && hubSpot.newContacts > 0 && hubSpot.dealsCreated > 0) {
    liveRecommendations.push({
      id: "measurement-ads-to-crm",
      title: "Reconcile paid conversions with CRM outcomes",
      description: "Google Ads is reporting conversions while HubSpot records the actual contacts and deals. Compare campaign conversion actions with CRM-created contacts and deals before treating platform conversions as qualified leads.",
      category: "conversion",
      priority: "medium",
      impact: "Improves lead-quality reporting",
      effort: "1–2 days",
      status: "open",
      metric: `${ads.conversionsTotal.toLocaleString("en-GB", { maximumFractionDigits: 1 })} Ads conv. · ${hubSpot.newContacts} new contacts · ${hubSpot.dealsCreated} deals`,
      isSample: false,
    });
  }

  return liveRecommendations;
}

async function buildRecommendations(hubSpot: HubSpotSnapshot | null, ads: GoogleMarketingSnapshot["ads"], seo: SearchConsoleSnapshot) {
  return Promise.all(buildLiveRecommendations(hubSpot, ads, seo).map(async (recommendation) => ({
    ...recommendation,
    status: (await db.select().from(marketingRecommendationOverrides).where(eq(marketingRecommendationOverrides.recommendationId, recommendation.id)).limit(1))[0]?.status as RecommendationStatus ?? recommendation.status,
  })));
}

router.get("/marketing/overview", async (req, res): Promise<void> => {
  const parsed = GetMarketingOverviewQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  let dateRange: MarketingDateRange;
  try {
    dateRange = requestedMarketingDateRange(parsed.data);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid reporting period" });
    return;
  }

  const [hubSpotResult, googleResult, clarityResult] = await Promise.allSettled([
    fetchHubSpotSnapshot(dateRange),
    fetchGoogleMarketingSnapshot(dateRange),
    fetchClaritySnapshot(),
  ]);
  const hubSpot = hubSpotResult.status === "fulfilled" ? hubSpotResult.value : null;
  const googleMarketing = googleResult.status === "fulfilled" ? googleResult.value : null;
  const clarity = clarityResult.status === "fulfilled" ? clarityResult.value : null;
  const ga4 = googleMarketing?.ga4 ?? null;
  const ads = googleMarketing?.ads ?? null;
  const seo = googleMarketing?.seo ?? null;
  if (googleMarketing?.errors.ga4) req.log.warn({ error: googleMarketing.errors.ga4 }, "GA4 read unavailable");
  if (googleMarketing?.errors.ads) req.log.warn({ error: googleMarketing.errors.ads }, "Google Ads read unavailable");
  if (googleMarketing?.errors.seo) req.log.warn({ error: googleMarketing.errors.seo }, "Search Console read unavailable");
  if (hubSpotResult.status === "rejected") req.log.warn({ error: String(hubSpotResult.reason).slice(0, 200) }, "HubSpot read unavailable");
  if (googleResult.status === "rejected") req.log.warn({ error: String(googleResult.reason).slice(0, 200) }, "Google marketing read failed");
  if (clarityResult.status === "rejected") req.log.warn({ error: String(clarityResult.reason).slice(0, 200) }, "Microsoft Clarity read unavailable");

  if (!hubSpot && !ga4 && !ads && !seo && !clarity) {
    req.log.error({
      hubspot: hubSpotResult.status === "rejected" ? hubSpotResult.reason : undefined,
      google: googleResult.status === "rejected" ? googleResult.reason : undefined,
      clarity: clarityResult.status === "rejected" ? clarityResult.reason : undefined,
    }, "No live marketing source returned data");
    const emptySourceSnapshot = {
      ...overview.sourceSnapshot,
      kpis: [],
      ga4SessionsTotal: 0,
      ga4Channels: [],
      hubspotContactsTotal: 0,
      hubspotNewContacts: 0,
      hubspotDealsCreated: 0,
      hubspotContactSources: [],
      pipelineTotal: 0,
      pipelineBoards: [],
      sixMonthTrend: buildSixMonthDealTrend(ads, hubSpot),
      spendTotal: 0,
      adsImpressionsTotal: 0,
      spendByChannel: [],
      campaigns: [],
      clarity: unavailableClaritySnapshot("No live Microsoft Clarity data is available."),
      caveat: "No live source data is available; unavailable metrics are omitted.",
    };
    res.json(GetMarketingOverviewResponse.parse({
      ...overview,
       dataMode: "mixed" as const,
      kpis: [],
      trend: [],
      channels: [],
      seoKeywords: [],
      sources: overview.sources.map((source) => ({ ...source, status: "needs_connection" as const, lastSynced: "No live data — omitted" })),
      recommendations: [],
      sourceSnapshot: emptySourceSnapshot,
      shopifySales: workbookShopifySales,
      seoVisibility: { ...referenceSeoVisibility(dateRange), fallbackReason: "No live Search Console data is available; SEO metrics are omitted." },
    }));
    return;
  }

  try {
    const liveSourceNames = [hubSpot ? "HubSpot" : "", ga4 ? "Google Analytics" : "", ads ? "Google Ads" : "", seo ? "Google Search Console" : "", clarity ? "Microsoft Clarity" : ""].filter(Boolean);
    const liveSourceSummary = liveSourceNames.length
      ? `${liveSourceNames.join(", ")} ${liveSourceNames.length === 1 ? "is" : "are"} live through official APIs`
      : "No live sources are currently available";
    const monthlyReport = dateRange.key.startsWith("month:");
    const reportLabel = monthlyReport ? `month of ${dateRange.startDate.slice(0, 7)}` : `last ${parsed.data.range.replace("d", " days")}`;
    const sourceSnapshot = {
      ...overview.sourceSnapshot,
      kpis: overview.sourceSnapshot.kpis.map((kpi) => {
        if (kpi.key === "spend" && ads) {
          return { ...kpi, value: formatGBP(ads.spendTotal), change: 0, trend: "flat" as const, comparison: "Live Google Ads data", targetPercent: targetPercentFor(kpi.key, ads.spendTotal) };
        }
        if (kpi.key === "clicks" && ads) {
          return { ...kpi, value: ads.clicksTotal.toLocaleString("en-GB"), change: 0, trend: "flat" as const, comparison: "Live Google Ads data", targetPercent: targetPercentFor(kpi.key, ads.clicksTotal) };
        }
        if (kpi.key === "impressions" && ads) {
          return { ...kpi, value: ads.impressionsTotal.toLocaleString("en-GB"), change: 0, trend: "flat" as const, comparison: "Live Google Ads data", targetPercent: targetPercentFor(kpi.key, ads.impressionsTotal) };
        }
        if (kpi.key === "sessions" && ga4) {
          return { ...kpi, value: ga4.sessionsTotal.toLocaleString("en-GB"), change: 0, trend: "flat" as const, comparison: "Live Google Analytics data", targetPercent: targetPercentFor(kpi.key, ga4.sessionsTotal) };
        }
        if (kpi.key === "conversions" && ads) {
          return { ...kpi, value: ads.conversionsTotal.toLocaleString("en-GB", { maximumFractionDigits: 1 }), change: 0, trend: "flat" as const, comparison: "Live Google Ads data", targetPercent: targetPercentFor(kpi.key, ads.conversionsTotal) };
        }
        if (kpi.key === "newContacts" && hubSpot) {
          return {
            ...kpi,
             label: `New contacts (${monthlyReport ? "month" : parsed.data.range})`,
            value: hubSpot.newContacts.toLocaleString("en-GB"),
            change: hubSpot.contactsChange,
            trend: hubSpot.contactsChange >= 0 ? ("up" as const) : ("down" as const),
            comparison: `vs previous ${monthlyReport ? "month" : "period"}`,
            targetPercent: targetPercentFor(kpi.key, hubSpot.newContacts),
          };
        }
        if (kpi.key === "dealsCreated" && hubSpot) {
          return { ...kpi, label: `Deals created (${monthlyReport ? "month" : parsed.data.range})`, value: hubSpot.dealsCreated.toLocaleString("en-GB"), change: 0, trend: "flat" as const, comparison: "Live HubSpot data", targetPercent: targetPercentFor(kpi.key, hubSpot.dealsCreated) };
        }
        if (kpi.key === "pipeline" && hubSpot) {
          return {
            ...kpi,
            value: formatGBP(hubSpot.pipelineTotal),
            change: 0,
            trend: "flat" as const,
            comparison: "Live HubSpot data",
            targetPercent: targetPercentFor(kpi.key, hubSpot.pipelineTotal),
          };
        }
        return kpi;
      }),
      capturedAt: new Date().toISOString().slice(0, 10),
      headline: ads && ga4 && hubSpot
        ? monthlyReport ? "Live monthly acquisition, paid media, and CRM reporting" : "Live acquisition, paid media, CRM, and pipeline reporting"
        : overview.sourceSnapshot.headline,
      ga4SessionsTotal: ga4?.sessionsTotal ?? overview.sourceSnapshot.ga4SessionsTotal,
      ga4Channels: ga4?.channels ?? overview.sourceSnapshot.ga4Channels,
      hubspotContactsTotal: hubSpot?.contactsTotal ?? overview.sourceSnapshot.hubspotContactsTotal,
      hubspotNewContacts: hubSpot?.newContacts ?? overview.sourceSnapshot.hubspotNewContacts,
      hubspotDealsCreated: hubSpot?.dealsCreated ?? overview.sourceSnapshot.hubspotDealsCreated,
      hubspotContactSources: hubSpot?.contactSources ?? overview.sourceSnapshot.hubspotContactSources,
       pipelineTotal: monthlyReport ? 0 : hubSpot?.pipelineTotal ?? overview.sourceSnapshot.pipelineTotal,
       pipelineBoards: monthlyReport ? [] : hubSpot?.pipelineBoards ?? overview.sourceSnapshot.pipelineBoards,
      spendTotal: ads?.spendTotal ?? overview.sourceSnapshot.spendTotal,
      adsImpressionsTotal: ads?.impressionsTotal ?? overview.sourceSnapshot.adsImpressionsTotal,
      spendByChannel: ads?.spendByChannel ?? overview.sourceSnapshot.spendByChannel,
      campaigns: ads?.campaigns ?? overview.sourceSnapshot.campaigns,
      clarity: clarity ?? unavailableClaritySnapshot("Microsoft Clarity is unavailable."),
      caveat: seo
        ? `${liveSourceSummary}. Search visibility and SEO recommendations use Google Search Console for ${seo.property} from ${seo.startDate} through ${seo.endDate}; reference SEO values are used only when this property is unavailable.`
        : `${liveSourceSummary}. Search Console is unavailable, so SEO rankings are omitted; paid-media recommendations are generated from live Google Ads campaigns when available.`,
    };
    const ga4LastSynced = ga4 ? "Live via Google Analytics" : "API read unavailable";
    const adsLastSynced = ads ? "Live via Google Ads" : "API read unavailable";
    const seoLastSynced = seo ? `Live via Google Search Console · ${seo.property}` : `Reference fallback · ${googleMarketing?.errors.seo ?? "property unavailable"}`;
    const referenceVisibility = referenceSeoVisibility(dateRange, googleMarketing?.errors.seo);
    const liveSourceKpis = sourceSnapshot.kpis.filter((kpi) =>
      (["spend", "clicks", "impressions", "conversions"].includes(kpi.key) && Boolean(ads))
      || (kpi.key === "sessions" && Boolean(ga4))
      || (["newContacts", "dealsCreated"].includes(kpi.key) && Boolean(hubSpot))
      || (kpi.key === "pipeline" && Boolean(hubSpot) && !monthlyReport),
    );
    const liveChannels = buildLiveChannelMix(
      ga4?.channels ?? [],
      hubSpot?.contactSources,
      ads?.spendByChannel,
    );
    const liveSourceSnapshot = {
      ...sourceSnapshot,
      kpis: liveSourceKpis,
      ga4SessionsTotal: ga4?.sessionsTotal ?? 0,
      ga4Channels: ga4?.channels ?? [],
      hubspotContactsTotal: hubSpot?.contactsTotal ?? 0,
      hubspotNewContacts: hubSpot?.newContacts ?? 0,
      hubspotDealsCreated: hubSpot?.dealsCreated ?? 0,
      hubspotContactSources: hubSpot?.contactSources ?? [],
      pipelineTotal: hubSpot?.pipelineTotal ?? 0,
      pipelineBoards: hubSpot?.pipelineBoards ?? [],
      sixMonthTrend: buildSixMonthDealTrend(ads, hubSpot),
      spendTotal: ads?.spendTotal ?? 0,
      adsImpressionsTotal: ads?.impressionsTotal ?? 0,
      spendByChannel: ads?.spendByChannel ?? [],
      campaigns: ads?.campaigns ?? [],
      clarity: clarity ?? unavailableClaritySnapshot("Microsoft Clarity is unavailable."),
       caveat: monthlyReport
         ? `Live API data for the ${reportLabel}. Pipeline is omitted because HubSpot exposes current open pipeline rather than historical monthly pipeline snapshots; Microsoft Clarity remains a rolling export.`
         : "Live API data only. Sections are omitted when the underlying source is unavailable.",
    };
    const liveOverview = {
      ...overview,
      asOf: new Date().toISOString(),
      dataMode: hubSpot && ga4 && ads && seo && clarity ? "connected" as const : "mixed" as const,
      kpis: overview.kpis.map((kpi) => {
        if (kpi.key === "organicSessions" && ga4) {
          return { ...kpi, value: formatCompact(ga4.organicSessions), change: 0, source: "Analytics", isSample: false };
        }
        if (kpi.key === "costPerDeal" && ads && hubSpot) {
          const costPerDeal = hubSpot.dealsCreated ? ads.spendTotal / hubSpot.dealsCreated : 0;
          return { ...kpi, label: "Cost per deal", value: hubSpot.dealsCreated ? formatGBP(costPerDeal) : "No deals", change: 0, source: "PPC + HubSpot", isSample: false };
        }
        if (kpi.key === "costPerContact" && ads && hubSpot) {
          const costPerContact = hubSpot.newContacts ? ads.spendTotal / hubSpot.newContacts : 0;
          return { ...kpi, label: "Cost per contact", value: hubSpot.newContacts ? formatGBP(costPerContact) : "No contacts", change: 0, source: "PPC + HubSpot", isSample: false };
        }
        if (kpi.key === "visibility" && seo) {
          return { ...kpi, label: "Search impressions", value: formatCompact(seo.impressions), change: seo.impressionsChange, trend: seo.impressionsChange >= 0 ? ("up" as const) : ("down" as const), source: "Search Console", isSample: false };
        }
        return kpi;
      }).filter((kpi) => !kpi.isSample),
      trend: buildAcquisitionTrend(dateRange, ga4?.dailySessions ?? null, hubSpot?.dailyNewContacts),
      channels: liveChannels,
      sources: overview.sources.map((source) => {
        if (source.name === "hubspot") return hubSpot ? { ...source, status: "connected" as const, lastSynced: "Live via HubSpot" } : { ...source, status: "needs_connection" as const, lastSynced: "No live data — omitted" };
        if (source.name === "analytics") return ga4 ? { ...source, status: "connected" as const, lastSynced: ga4LastSynced } : { ...source, status: "needs_connection" as const, lastSynced: "No live data — omitted" };
        if (source.name === "ppc") return ads ? { ...source, status: "connected" as const, lastSynced: adsLastSynced } : { ...source, status: "needs_connection" as const, lastSynced: "No live data — omitted" };
        if (source.name === "seo") return seo ? { ...source, status: "connected" as const, lastSynced: seoLastSynced } : { ...source, status: "needs_connection" as const, lastSynced: "No live data — omitted" };
        if (source.name === "clarity") return clarity ? { ...source, status: "connected" as const, lastSynced: `Live via Microsoft Clarity · ${clarity.windowStart} to ${clarity.windowEnd}` } : { ...source, status: "needs_connection" as const, lastSynced: "No live data — omitted" };
        return source;
      }),
      seoKeywords: seo
        ? seo.queries.map((query) => ({
            keyword: query.keyword,
            intent: query.intent,
            position: query.averagePosition,
            change: query.positionChange,
            volume: query.impressions,
            difficulty: 0,
            opportunity: query.opportunity,
            landingPage: query.landingPage,
            clicks: query.clicks,
            impressions: query.impressions,
            ctr: query.ctr,
            averagePosition: query.averagePosition,
          }))
        : [],
      seoVisibility: seo
        ? { ...seo, source: "live" as const, isSample: false, fallbackReason: "" }
        : referenceVisibility,
      recommendations: await buildRecommendations(hubSpot, ads, seo),
      sourceSnapshot: liveSourceSnapshot,
      shopifySales: workbookShopifySales,
    };
    res.json(GetMarketingOverviewResponse.parse(liveOverview));
  } catch (error) {
    req.log.error({ error: String(error).slice(0, 200) }, "Failed to map live marketing data");
    res.status(502).json({ error: "Live marketing data could not be mapped." });
  }
});

router.get("/marketing/recommendations", async (_req, res): Promise<void> => {
  const [hubSpotResult, googleResult] = await Promise.allSettled([fetchHubSpotSnapshot(), fetchGoogleMarketingSnapshot("30d")]);
  const hubSpot = hubSpotResult.status === "fulfilled" ? hubSpotResult.value : null;
  const googleMarketing = googleResult.status === "fulfilled" ? googleResult.value : null;
  res.json(ListMarketingRecommendationsResponse.parse(await buildRecommendations(hubSpot, googleMarketing?.ads ?? null, googleMarketing?.seo ?? null)));
});

router.patch("/marketing/recommendations/:id", async (req, res): Promise<void> => {
  const params = UpdateMarketingRecommendationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateMarketingRecommendationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [hubSpotResult, googleResult] = await Promise.allSettled([fetchHubSpotSnapshot(), fetchGoogleMarketingSnapshot("30d")]);
  const hubSpot = hubSpotResult.status === "fulfilled" ? hubSpotResult.value : null;
  const googleMarketing = googleResult.status === "fulfilled" ? googleResult.value : null;
  const recommendation = (await buildRecommendations(hubSpot, googleMarketing?.ads ?? null, googleMarketing?.seo ?? null)).find((item) => item.id === params.data.id);
  if (!recommendation) {
    res.status(404).json({ error: "Recommendation not found" });
    return;
  }

  await db.insert(marketingRecommendationOverrides).values({ recommendationId: recommendation.id, status: body.data.status }).onConflictDoUpdate({ target: marketingRecommendationOverrides.recommendationId, set: { status: body.data.status, updatedAt: new Date() } });
  res.json(UpdateMarketingRecommendationResponse.parse({ ...recommendation, status: body.data.status }));
});

export default router;