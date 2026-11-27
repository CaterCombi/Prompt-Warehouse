import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMonthlyMarketingReportHtml, generateMonthlyMarketingReportPdf } from "../src/lib/marketingMonthlyReportPdf.ts";

const report = {
  month: "2026-10",
  monthLabel: "October 2026",
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  generatedAt: "2026-11-01T09:00:00.000Z",
  sources: [
    { label: "Google Ads", status: "live", detail: "Live campaign data for the reporting month." },
    { label: "Google Search Console", status: "unavailable", detail: "Reference values intentionally omitted." },
  ],
  metrics: [
    { label: "Cost per deal", value: "£71.00", detail: "Live Ads and CRM data.", sourceStatus: "live" },
    { label: "Cost per lead", value: "£35.50", detail: "Uses new HubSpot contacts as the lead count.", sourceStatus: "live" },
    { label: "Search clicks", value: "Unavailable", detail: "Search Console data unavailable.", sourceStatus: "unavailable" },
  ],
  campaigns: [
    { name: '<script>alert("x")</script> Brand campaign', spend: "£71.00", clicks: "10", conversions: "2", costPerConversion: "£35.50" },
  ],
  clarity: {
    status: "rolling",
    capturedAt: "2026-11-27",
    windowStart: "2026-11-24",
    windowEnd: "2026-11-26",
    numOfDays: 3,
    message: "",
    metrics: [
      { label: "Sessions", value: "120" },
      { label: "Users", value: "95" },
    ],
    behavior: [
      { label: "Dead clicks", events: "4", sessions: "3", rate: "2.5%" },
    ],
    popularPages: [
      { url: "https://catercombi.com/products", visits: "80" },
    ],
  },
  channels: [],
  searchQueries: [],
  notes: ["Sample and reference metrics are not included as live."],
};

test("monthly marketing PDF includes report metrics as extractable text on A4", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "marketing-report-pdf-"));
  try {
    const pdf = await generateMonthlyMarketingReportPdf(report);
    const pdfPath = join(temporaryDirectory, "marketing-report.pdf");
    writeFileSync(pdfPath, pdf);
    const metadata = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
    const text = execFileSync("pdftotext", [pdfPath, "-"], { encoding: "utf8" });
    const normalizedText = text.toLowerCase();

    assert.match(metadata, /Pages:\s+[1-9]/);
    assert.match(metadata, /Page size:.*A4/);
    for (const expected of [
      "Monthly performance report",
      "October 2026",
      "Cost per deal",
      "Cost per lead",
      "Campaign performance",
      "Clarity",
      "rolling snapshot",
      "2026-11-24 to 2026-11-26",
      "not monthly totals",
      "Dead clicks",
      "Unavailable",
      "Source status",
    ]) {
      assert.ok(normalizedText.includes(expected.toLowerCase()), `Expected generated PDF text to contain "${expected}".`);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("monthly marketing PDF escapes external report text before rendering", () => {
  const html = buildMonthlyMarketingReportHtml(report);
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.equal(html.includes('<script>alert("x")</script>'), false);
});

test("monthly marketing PDF labels unavailable Clarity instead of showing fake zero metrics", () => {
  const html = buildMonthlyMarketingReportHtml({
    ...report,
    clarity: {
      status: "unavailable",
      capturedAt: null,
      windowStart: null,
      windowEnd: null,
      numOfDays: null,
      message: "Live Clarity data is unavailable.",
      metrics: [],
      behavior: [],
      popularPages: [],
    },
  });

  assert.match(html, /Clarity was unavailable/);
  assert.match(html, /Live Clarity data is unavailable/);
  assert.doesNotMatch(html, /rolling 0-day window/);
});
