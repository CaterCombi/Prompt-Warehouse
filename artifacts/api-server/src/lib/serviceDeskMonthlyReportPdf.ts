import { existsSync } from "node:fs";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import type { MonthlyServiceDeskReport } from "./serviceDeskMonthlyReportDataCore.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeZone: "Europe/London",
      }).format(date)
    : "Not recorded";
}

function reportHtml(report: MonthlyServiceDeskReport): string {
  const generatedAt = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/London",
  }).format(new Date(report.generatedAt));
  const sourceLabel = report.source.status === "fresh"
    ? "Fresh"
    : report.source.status === "stale" ? "Stale" : "Unavailable";
  const metricCards = [
    ["Completed jobs", report.totals.completedJobs],
    ["Installations", report.totals.installations],
    ["Services", report.totals.services],
    ["Repairs", report.totals.repairs],
    ["Other / unclassified", report.totals.otherJobs],
    ["Distinct service or repair assets", report.totals.distinctServiceAssets],
  ].map(([label, value]) => `
    <article class="metric">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
    </article>`).join("");
  const breakdownRows = report.jobTypeBreakdown.map((row) => `
    <tr><td>${escapeHtml(row.jobType)}</td><td class="numeric">${escapeHtml(row.jobs)}</td></tr>`).join("");
  const assetRows = report.assets.map((asset) => `
    <tr>
      <td>${escapeHtml(asset.assetRef)}</td>
      <td>${escapeHtml(asset.jobTypes.join(", ") || "Not recorded")}</td>
      <td>${escapeHtml(asset.jobRefs.join(", ") || "Not recorded")}</td>
      <td>${escapeHtml(asset.sites.join(", ") || "Not recorded")}</td>
      <td>${escapeHtml(asset.engineers.join(", ") || "Not recorded")}</td>
      <td>${escapeHtml(displayDate(asset.latestCompletedAt))}</td>
    </tr>`).join("");
  const jobRows = report.jobs.map((job) => `
    <tr>
      <td>${escapeHtml(job.jobRef || "Not recorded")}</td>
      <td>${escapeHtml(job.jobType || "Not specified")}</td>
      <td>${escapeHtml(job.category)}</td>
      <td>${escapeHtml(job.assetRef || "Asset not identified")}</td>
      <td>${escapeHtml(job.site || "Not recorded")}</td>
      <td>${escapeHtml(job.engineer || "Not recorded")}</td>
      <td>${escapeHtml(displayDate(job.completedAt))}</td>
    </tr>`).join("");
  const notes = report.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  const sourceDetails = report.source.filename
    ? `${report.source.filename} · modified ${displayDate(report.source.modifiedAt ?? "")}${report.source.ageDays === null ? "" : ` · ${report.source.ageDays.toFixed(1)} days old`}`
    : "No successful All Jobs freshness observation is available.";

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Service Desk activity report — ${escapeHtml(report.monthLabel)}</title>
      <style>
        @page { size: A4; margin: 14mm 12mm 16mm; }
        * { box-sizing: border-box; }
        body { margin: 0; color: #182536; font: 8.5pt/1.45 Arial, Helvetica, sans-serif; }
        .topline { height: 5px; margin-bottom: 16px; background: #1a8f77; }
        .brand { color: #1a8f77; font-size: 8pt; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
        h1 { margin: 6px 0 3px; color: #13273d; font-size: 24pt; line-height: 1.1; }
        .period { margin: 0; color: #5c6b7a; font-size: 11pt; }
        .generated { margin: 5px 0 18px; color: #6d7a86; font-size: 8pt; }
        h2 { margin: 19px 0 8px; padding-bottom: 5px; color: #13273d; border-bottom: 1px solid #d7e0e8; font-size: 13pt; }
        .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
        .metric { min-height: 66px; padding: 9px 10px; border: 1px solid #d7e0e8; border-top: 3px solid #1a8f77; border-radius: 6px; break-inside: avoid; }
        .metric-label { color: #5c6b7a; font-size: 7.3pt; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
        .metric-value { margin-top: 5px; color: #13273d; font-size: 18pt; font-weight: 700; }
        .source { padding: 9px 10px; border-radius: 5px; background: #f0f4f6; }
        .source.fresh { border-left: 4px solid #1a8f77; }
        .source.stale { border-left: 4px solid #c88518; }
        .source.missing { border-left: 4px solid #8996a3; }
        .source strong { color: #13273d; }
        table { width: 100%; border-collapse: collapse; font-size: 7.5pt; }
        thead { display: table-header-group; }
        th { padding: 6px 5px; background: #edf3f5; color: #314355; text-align: left; font-size: 6.7pt; text-transform: uppercase; letter-spacing: .03em; }
        td { padding: 5px; border-bottom: 1px solid #e1e7ec; vertical-align: top; overflow-wrap: anywhere; }
        tr { break-inside: avoid; }
        .numeric { text-align: right; white-space: nowrap; }
        .empty { padding: 10px 6px; color: #6d7a86; font-style: italic; }
        .notes { margin: 8px 0 0; padding-left: 18px; color: #536273; font-size: 7.5pt; }
        .notes li { margin: 4px 0; }
        .footer { margin-top: 18px; padding-top: 7px; border-top: 1px solid #d7e0e8; color: #778391; font-size: 7pt; }
      </style>
    </head>
    <body>
      <div class="topline"></div>
      <div class="brand">CaterCombi · Service Desk</div>
      <h1>Monthly activity report</h1>
      <p class="period">${escapeHtml(report.monthLabel)} · ${escapeHtml(displayDate(`${report.startDate}T12:00:00Z`))} to ${escapeHtml(displayDate(`${report.endDate}T12:00:00Z`))}</p>
      <p class="generated">Generated ${escapeHtml(generatedAt)} UK time</p>

      <section>
        <h2>Monthly summary</h2>
        <div class="metrics">${metricCards}</div>
      </section>

      <section>
        <h2>Joblogic data coverage</h2>
        <div class="source ${escapeHtml(report.source.status)}">
          <strong>${escapeHtml(sourceLabel)} All Jobs source</strong><br>
          ${escapeHtml(sourceDetails)}
        </div>
      </section>

      <section>
        <h2>Job-type breakdown</h2>
        <table>
          <thead><tr><th>Joblogic job type</th><th class="numeric">Completed jobs</th></tr></thead>
          <tbody>${breakdownRows || '<tr><td class="empty" colspan="2">No completed jobs were recorded for this month.</td></tr>'}</tbody>
        </table>
      </section>

      <section>
        <h2>Assets serviced or repaired</h2>
        <table>
          <thead><tr><th>Asset</th><th>Job type</th><th>Job refs</th><th>Site</th><th>Engineer</th><th>Latest completion</th></tr></thead>
          <tbody>${assetRows || '<tr><td class="empty" colspan="6">No completed service or repair jobs with an asset reference were recorded for this month.</td></tr>'}</tbody>
        </table>
      </section>

      <section>
        <h2>Completed Joblogic jobs</h2>
        <table>
          <thead><tr><th>Job ref</th><th>Joblogic type</th><th>Group</th><th>Asset ref</th><th>Site</th><th>Engineer</th><th>Completed</th></tr></thead>
          <tbody>${jobRows || '<tr><td class="empty" colspan="7">No completed Joblogic jobs were recorded for this month.</td></tr>'}</tbody>
        </table>
      </section>

      <section>
        <h2>Reporting notes</h2>
        <ul class="notes">${notes}</ul>
      </section>
      <div class="footer">CaterCombi · Internal Service Desk report · Completed jobs are based on Joblogic completion dates.</div>
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

export function buildMonthlyServiceDeskReportHtml(report: MonthlyServiceDeskReport): string {
  return reportHtml(report);
}

export async function generateMonthlyServiceDeskReportPdf(
  report: MonthlyServiceDeskReport,
): Promise<Uint8Array> {
  const browser = await launchPdfBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(reportHtml(report), { waitUntil: "load" });
    await page.evaluate("document.fonts.ready.then(() => true)");
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "14mm", right: "12mm", bottom: "16mm", left: "12mm" },
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
