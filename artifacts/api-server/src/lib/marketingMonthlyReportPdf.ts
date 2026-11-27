import { existsSync } from "node:fs";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import type { MonthlyMarketingReport } from "./marketingMonthlyReportData.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusLabel(status: MonthlyMarketingReport["sources"][number]["status"]) {
  if (status === "live") return "Live";
  if (status === "rolling") return "Live · rolling";
  if (status === "reference") return "Imported reference";
  return "Unavailable";
}

function reportHtml(report: MonthlyMarketingReport) {
  const metrics = report.metrics.map((metric) => `
    <article class="metric ${metric.sourceStatus}">
      <div class="metric-label">${escapeHtml(metric.label)}</div>
      <div class="metric-value">${escapeHtml(metric.value)}</div>
      <div class="metric-detail">${escapeHtml(metric.detail)}</div>
    </article>`).join("");
  const sourceRows = report.sources.map((source) => `
    <tr>
      <td>${escapeHtml(source.label)}</td>
      <td><span class="status ${escapeHtml(source.status)}">${escapeHtml(statusLabel(source.status))}</span></td>
      <td>${escapeHtml(source.detail)}</td>
    </tr>`).join("");
  const campaignRows = report.campaigns.map((campaign) => `
    <tr>
      <td>${escapeHtml(campaign.name)}</td>
      <td class="numeric">${escapeHtml(campaign.spend)}</td>
      <td class="numeric">${escapeHtml(campaign.clicks)}</td>
      <td class="numeric">${escapeHtml(campaign.conversions)}</td>
      <td class="numeric">${escapeHtml(campaign.costPerConversion)}</td>
    </tr>`).join("");
  const clarityMetricCards = report.clarity.metrics.map((metric) => `
    <article class="metric live">
      <div class="metric-label">${escapeHtml(metric.label)}</div>
      <div class="metric-value">${escapeHtml(metric.value)}</div>
    </article>`).join("");
  const clarityBehaviorRows = report.clarity.behavior.map((metric) => `
    <tr>
      <td>${escapeHtml(metric.label)}</td>
      <td class="numeric">${escapeHtml(metric.events)}</td>
      <td class="numeric">${escapeHtml(metric.sessions)}</td>
      <td class="numeric">${escapeHtml(metric.rate)}</td>
    </tr>`).join("");
  const clarityPageRows = report.clarity.popularPages.map((page) => `
    <tr>
      <td>${escapeHtml(page.url)}</td>
      <td class="numeric">${escapeHtml(page.visits)}</td>
    </tr>`).join("");
  const channelRows = report.channels.map((channel) => `
    <tr>
      <td>${escapeHtml(channel.channel)}</td>
      <td class="numeric">${escapeHtml(channel.sessions)}</td>
      <td class="numeric">${escapeHtml(channel.leads)}</td>
      <td class="numeric">${escapeHtml(channel.conversionRate)}</td>
      <td class="numeric">${escapeHtml(channel.costPerLead)}</td>
    </tr>`).join("");
  const queryRows = report.searchQueries.map((query) => `
    <tr>
      <td>${escapeHtml(query.keyword)}</td>
      <td class="numeric">${escapeHtml(query.clicks)}</td>
      <td class="numeric">${escapeHtml(query.impressions)}</td>
      <td class="numeric">${escapeHtml(query.ctr)}</td>
      <td class="numeric">${escapeHtml(query.averagePosition)}</td>
    </tr>`).join("");
  const notes = report.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Marketing performance report — ${escapeHtml(report.monthLabel)}</title>
      <style>
        @page { size: A4; margin: 14mm 14mm 16mm; }
        * { box-sizing: border-box; }
        body { margin: 0; color: #182536; font: 9pt/1.45 Arial, Helvetica, sans-serif; }
        .topline { height: 5px; margin: 0 0 16px; background: #1a8f77; }
        .brand { color: #1a8f77; font-size: 8pt; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
        h1 { margin: 6px 0 3px; color: #13273d; font-size: 24pt; line-height: 1.1; }
        .period { margin: 0; color: #5c6b7a; font-size: 11pt; }
        .generated { margin: 5px 0 18px; color: #6d7a86; font-size: 8pt; }
        h2 { margin: 20px 0 8px; padding-bottom: 5px; color: #13273d; border-bottom: 1px solid #d7e0e8; font-size: 13pt; }
        .metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
        .metric { min-height: 73px; padding: 10px 11px; border: 1px solid #d7e0e8; border-radius: 7px; break-inside: avoid; }
        .metric.live { border-top: 3px solid #1a8f77; }
        .metric.unavailable { border-top: 3px solid #aeb9c4; }
        .metric.clarity { min-height: 62px; }
        .metric-label { color: #5c6b7a; font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
        .metric-value { margin: 5px 0 2px; color: #13273d; font-size: 18pt; font-weight: 700; }
        .metric-detail { color: #6d7a86; font-size: 7.5pt; }
        table { width: 100%; border-collapse: collapse; font-size: 8pt; }
        th { padding: 7px 6px; background: #edf3f5; color: #314355; text-align: left; font-size: 7pt; text-transform: uppercase; letter-spacing: .04em; }
        td { padding: 6px; border-bottom: 1px solid #e1e7ec; vertical-align: top; }
        .numeric { text-align: right; white-space: nowrap; }
        .status { display: inline-block; padding: 2px 6px; border-radius: 10px; font-size: 7pt; font-weight: 700; white-space: nowrap; }
        .status.live { background: #e2f4ee; color: #176b57; }
        .status.rolling { background: #eef3f7; color: #536879; }
        .status.reference { background: #fff2d8; color: #795816; }
        .status.unavailable { background: #eef0f2; color: #596776; }
        .empty { padding: 10px 6px; color: #6d7a86; font-style: italic; }
        .clarity-window { margin: 0 0 9px; color: #536273; font-size: 8pt; }
        .notes { margin: 8px 0 0; padding-left: 18px; color: #536273; font-size: 8pt; }
        .notes li { margin: 4px 0; }
        .footer { margin-top: 18px; padding-top: 7px; border-top: 1px solid #d7e0e8; color: #778391; font-size: 7pt; }
      </style>
    </head>
    <body>
      <div class="topline"></div>
      <div class="brand">CaterCombi · Marketing</div>
      <h1>Monthly performance report</h1>
      <p class="period">${escapeHtml(report.monthLabel)} · ${escapeHtml(report.startDate)} to ${escapeHtml(report.endDate)}</p>
      <p class="generated">Generated ${escapeHtml(new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(report.generatedAt)))} UK time</p>
      <section>
        <h2>Key metrics</h2>
        <div class="metrics">${metrics}</div>
      </section>
      <section>
        <h2>Data source coverage</h2>
        <table>
          <thead><tr><th>Source</th><th>Status</th><th>Coverage and notes</th></tr></thead>
          <tbody>${sourceRows || '<tr><td class="empty" colspan="3">No source status is available.</td></tr>'}</tbody>
        </table>
      </section>
      <section>
        <h2>Campaign performance · Google Ads</h2>
        <table>
          <thead><tr><th>Campaign</th><th class="numeric">Spend</th><th class="numeric">Clicks</th><th class="numeric">Conversions</th><th class="numeric">Cost / conversion</th></tr></thead>
          <tbody>${campaignRows || '<tr><td class="empty" colspan="5">No live Google Ads campaign rows are available for this period.</td></tr>'}</tbody>
        </table>
      </section>
      <section>
        <h2>Microsoft Clarity · rolling snapshot</h2>
        ${report.clarity.status === "rolling"
          ? `<p class="clarity-window">Rolling ${escapeHtml(report.clarity.numOfDays)}-day window: ${escapeHtml(report.clarity.windowStart)} to ${escapeHtml(report.clarity.windowEnd)} · captured ${escapeHtml(report.clarity.capturedAt)}. These figures are not monthly totals.</p>
             <div class="metrics">${clarityMetricCards}</div>
             ${clarityBehaviorRows
               ? `<h3>Behaviour and friction</h3><table><thead><tr><th>Signal</th><th class="numeric">Events</th><th class="numeric">Sessions</th><th class="numeric">Rate</th></tr></thead><tbody>${clarityBehaviorRows}</tbody></table>`
               : `<p class="empty">${escapeHtml(report.clarity.message || "Enhanced behaviour metrics are unavailable for this snapshot.")}</p>`}
             ${clarityPageRows
               ? `<h3>Popular pages in the snapshot</h3><table><thead><tr><th>Page</th><th class="numeric">Visits</th></tr></thead><tbody>${clarityPageRows}</tbody></table>`
               : ""}`
          : `<p class="empty">Clarity was unavailable: ${escapeHtml(report.clarity.message)}</p>`}
      </section>
      <section>
        <h2>Acquisition channels</h2>
        <table>
          <thead><tr><th>Channel</th><th class="numeric">Sessions</th><th class="numeric">Leads</th><th class="numeric">Conversion</th><th class="numeric">Cost / lead</th></tr></thead>
          <tbody>${channelRows || '<tr><td class="empty" colspan="5">Channel attribution requires live GA4 and HubSpot data.</td></tr>'}</tbody>
        </table>
      </section>
      <section>
        <h2>Search queries</h2>
        <table>
          <thead><tr><th>Query</th><th class="numeric">Clicks</th><th class="numeric">Impressions</th><th class="numeric">CTR</th><th class="numeric">Avg. position</th></tr></thead>
          <tbody>${queryRows || '<tr><td class="empty" colspan="5">No live Search Console query rows are available for this period.</td></tr>'}</tbody>
        </table>
      </section>
      <section>
        <h2>Reporting notes</h2>
        <ul class="notes">${notes}</ul>
      </section>
      <div class="footer">CaterCombi · Internal marketing report · Source status is shown beside each data section.</div>
    </body>
  </html>`;
}

async function launchPdfBrowser() {
  const executableCandidates = [
    process.env["CHROMIUM_EXECUTABLE_PATH"],
    "/repl/tools/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const localExecutable = executableCandidates.find((candidate) => existsSync(candidate));
  const executablePath = localExecutable ?? (await chromium.executablePath());
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: localExecutable
      ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      : chromium.args,
  });
}

export async function generateMonthlyMarketingReportPdf(report: MonthlyMarketingReport): Promise<Uint8Array> {
  const browser = await launchPdfBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(reportHtml(report), { waitUntil: "load" });
    await page.evaluate("document.fonts.ready.then(() => true)");
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "14mm", right: "14mm", bottom: "16mm", left: "14mm" },
      timeout: 20_000,
    });
    if (!Buffer.from(pdf).includes(Buffer.from("/Font"))) {
      throw new Error("Chromium generated a PDF without font resources; report text would not be visible.");
    }
    return pdf;
  } finally {
    await browser.close();
  }
}

export function buildMonthlyMarketingReportHtml(report: MonthlyMarketingReport) {
  return reportHtml(report);
}
