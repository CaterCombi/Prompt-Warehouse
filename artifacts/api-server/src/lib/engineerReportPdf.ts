import { existsSync } from "node:fs";
import type { EngineerReportServiceRecord } from "@workspace/api-zod";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { formatServiceDate } from "./engineerReportData.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function printableValue(value: string | null | undefined, blank = false): string {
  if (value) return escapeHtml(value);
  return blank ? "" : '<span class="missing">Not recorded</span>';
}

function checkbox(label: string, checked = false): string {
  return `<span class="choice"><span class="box${checked ? " checked" : ""}">${checked ? "✓" : ""}</span><span>${escapeHtml(label)}</span></span>`;
}

function field(label: string, value: string | null | undefined, options: { blank?: boolean; choices?: string[]; selected?: string } = {}) {
  const content = options.choices
    ? `<div class="choices">${options.choices.map((choice) => checkbox(choice, options.selected === choice)).join("")}</div>`
    : `<div class="field-value">${printableValue(value, options.blank)}</div>`;
  return `<div class="field"><div class="field-label">${escapeHtml(label)}</div>${content}</div>`;
}

function renderCheckRows(checks: EngineerReportServiceRecord["checks"]): string {
  let previousCategory = "";
  return checks
    .map((check) => {
      const category =
        check.category !== previousCategory
          ? `<tr class="category-row"><th colspan="6">${escapeHtml(check.category)}</th></tr>`
          : "";
      previousCategory = check.category;
      return `${category}<tr class="check-row">
        <td class="check-number">${check.number}</td>
        <td class="check-label">${escapeHtml(check.label)}</td>
        <td class="check-box">${checkbox("", check.pass)}</td>
        <td class="check-box">${checkbox("", check.fail)}</td>
        <td class="check-box">${checkbox("", check.notApplicable)}</td>
        <td class="check-notes">${escapeHtml(check.notes)}</td>
      </tr>`;
    })
    .join("");
}

function checklistTable(checks: EngineerReportServiceRecord["checks"]): string {
  return `<table class="checklist">
    <colgroup><col style="width:5%"><col style="width:43%"><col style="width:7%"><col style="width:7%"><col style="width:7%"><col style="width:31%"></colgroup>
    <thead><tr><th>No.</th><th>Check</th><th>Pass</th><th>Fail</th><th>N/A</th><th>Notes / readings</th></tr></thead>
    <tbody>${renderCheckRows(checks)}</tbody>
  </table>`;
}

function readingsTable(record: EngineerReportServiceRecord): string {
  const readings: Array<[string, string, string, string]> = [
    ["Supply voltage (V)", "L1:", "L2:", "L3:"],
    ["Current draw under load (A)", "L1:", "L2:", "L3:"],
    ["Earth continuity (Ω)", "", "", ""],
    ["Insulation resistance (MΩ)", "", "", ""],
    ["Water pressure (bar)", "Static:", "Flow:", ""],
    ["Heat-up time to 200°C (min)", "", "", ""],
    ["Cavity temperature accuracy", "Set:", "Actual:", ""],
    ["Core probe accuracy", "Reference:", "Probe:", ""],
    ["Gas pressure (mbar), gas only", "Inlet:", "Burner:", ""],
    ["Operating hours", "", "", ""],
  ];
  return `<table class="readings">
    <thead><tr><th>Test</th><th>Reading</th><th>Reading</th><th>Reading</th></tr></thead>
    <tbody>${readings
      .map(([name, first, second, third]) => {
        const hoursValue = name === "Operating hours" ? printableValue(record.operatingHours) : "";
        return `<tr><td>${escapeHtml(name)}</td><td>${hoursValue ? hoursValue : escapeHtml(first)}</td><td>${escapeHtml(second)}</td><td>${escapeHtml(third)}</td></tr>`;
      })
      .join("")}</tbody>
  </table>`;
}

function partsTable(record: EngineerReportServiceRecord): string {
  const rows = record.parts.length
    ? record.parts
        .map(
          (part) =>
            `<tr><td>${escapeHtml(part.description)}</td><td>${escapeHtml(part.partNumber ?? "")}</td><td class="qty">${part.quantity}</td><td></td></tr>`,
        )
        .join("")
    : Array.from({ length: 5 }, () => "<tr><td></td><td></td><td></td><td></td></tr>").join("");
  return `<table class="parts">
    <thead><tr><th>Part description</th><th>Part number</th><th>Qty</th><th>Reason for replacement</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function warningPanel(record: EngineerReportServiceRecord): string {
  if (record.warnings.length === 0) {
    return `<aside class="report-warning report-warning-clear"><strong>Source data check:</strong> No missing fields or unmapped parts were found.</aside>`;
  }
  return `<aside class="report-warning" aria-label="Source data warnings">
    <strong>Source data warnings — review before sign-off</strong>
    <ul>${record.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
  </aside>`;
}

function reportHtml(
  assetNumber: string,
  record: EngineerReportServiceRecord,
  reportNumber: string,
): string {
  const formattedDate = formatServiceDate(record.serviceDate);
  const firstChecklistPage = record.checks.slice(0, 23);
  const secondChecklistPage = record.checks.slice(23);
  const partsTotal = record.parts.reduce((sum, part) => sum + part.quantity, 0);
  const workSummary = `Service carried out ${formattedDate} by ${record.engineer ?? "Not recorded"}. ${partsTotal} parts replaced (${record.parts.length} part types), as listed in section 5.`;
  const fuelType = record.fuelType?.toLocaleLowerCase("en-GB") ?? "";
  const fuelChoice = /^(electric|electricity)$/.test(fuelType)
    ? "Electric"
    : /^(gas|ng|lpg|natural gas|propane|butane)$/.test(fuelType)
      ? "Gas (NG / LPG)"
      : "";
  const yearOfManufacture: string | null = null;
  const size: string | null = null;
  const powerSupply: string | null = null;
  const softwareVersion: string | null = null;
  const ctuFitted: string | null = null;

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Engineer's Report — ${escapeHtml(assetNumber)}</title>
      <style>
        :root { color-scheme: light; }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; color: #0D1117; font-size: 8pt; line-height: 1.22; }
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        h1 { margin: 0; color: #04659B; font-size: 19pt; line-height: 1.05; font-weight: 700; }
        .subtitle { margin: 4px 0 3px; color: #5B6673; font-size: 10pt; }
        .intro { margin: 0 0 8px; color: #5B6673; font-size: 7.5pt; }
        .report-page { page-break-after: always; break-after: page; }
        .report-page:last-child { page-break-after: auto; break-after: auto; }
        .title-block { border-bottom: 1.5px solid #04659B; padding: 0 0 7px; margin: 0 0 8px; }
        .section { margin: 0 0 8px; break-inside: avoid; page-break-inside: avoid; }
        .section-title { display: flex; gap: 6px; align-items: baseline; margin: 0 0 5px; padding: 4px 6px; color: #04659B; background: #E8F2F8; border: 1px solid #C9D2DC; font-size: 9pt; font-weight: 700; }
        .section-title .number { min-width: 13px; }
        .section-hint { margin: -1px 0 5px; color: #5B6673; font-size: 7pt; }
        .section-continuation { margin-bottom: 5px; color: #5B6673; font-size: 7pt; font-style: italic; }
        .report-warning { margin: -2px 0 8px; padding: 5px 7px; border: 1px solid #D5A742; border-left: 3px solid #D5A742; background: #FFF8E8; color: #664A0B; font-size: 7pt; break-inside: avoid; page-break-inside: avoid; }
        .report-warning strong { display: block; margin-bottom: 2px; }
        .report-warning ul { margin: 0; padding-left: 15px; }
        .report-warning li { margin: 1px 0; }
        .report-warning-clear { border-color: #7AB89A; border-left-color: #26784F; background: #EFF8F2; color: #205A3D; }
        .field-grid { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid #C9D2DC; border-left: 1px solid #C9D2DC; }
        .field { min-height: 30px; padding: 4px 6px 3px; border-right: 1px solid #C9D2DC; border-bottom: 1px solid #C9D2DC; }
        .report-page:first-child .field-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .report-page:first-child .field { min-height: 26px; padding: 3px 4px 2px; }
        .report-page:first-child .field-label { font-size: 6.4pt; }
        .report-page:first-child .choice { font-size: 7pt; }
        .field-label { margin-bottom: 2px; color: #5B6673; font-size: 6.8pt; font-weight: 700; }
        .field-value { min-height: 11px; font-size: 8pt; }
        .missing { color: #7B8794; font-style: italic; }
        .choices { min-height: 11px; display: flex; flex-wrap: wrap; gap: 4px 10px; }
        .choice { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; font-size: 7.4pt; }
        .box { width: 9px; height: 9px; display: inline-flex; align-items: center; justify-content: center; border: 0.8px solid #5B6673; flex: 0 0 9px; font-size: 8px; line-height: 1; color: #04659B; }
        .box.checked { font-weight: 700; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        th, td { border: 1px solid #C9D2DC; padding: 2.5px 4px; vertical-align: middle; }
        thead { display: table-header-group; }
        tr { break-inside: avoid; page-break-inside: avoid; }
        th { background: #E8F2F8; color: #0D1117; text-align: left; font-size: 6.8pt; }
        .checklist { font-size: 6.8pt; line-height: 1.1; }
        .checklist thead th { padding: 3px 3px; text-align: center; }
        .checklist thead th:nth-child(2), .checklist thead th:nth-child(6) { text-align: left; }
        .checklist .category-row th { padding: 3px 4px; background: #E8F2F8; color: #04659B; font-size: 7pt; }
        .check-row td { padding-top: 2px; padding-bottom: 2px; }
        .check-number, .check-box { text-align: center; }
        .check-label { font-size: 6.8pt; }
        .check-box .choice { justify-content: center; min-width: 100%; }
        .check-box .choice > span:last-child { display: none; }
        .check-notes { color: #0D1117; font-size: 6.4pt; }
        .readings, .parts { font-size: 7pt; }
        .readings th, .parts th { padding: 3px 4px; }
        .readings td, .parts td { height: 18px; }
        .parts td:nth-child(3), .parts th:nth-child(3) { width: 8%; text-align: center; }
        .parts td:nth-child(1) { width: 41%; }
        .parts td:nth-child(2) { width: 20%; }
        .parts td:nth-child(4) { width: 31%; }
        .qty { text-align: center; }
        .fault-line { height: 25px; border-bottom: 1px solid #C9D2DC; }
        .work-summary { margin: 0 0 4px; padding: 5px 6px; background: #F5F8FA; border-left: 2px solid #04659B; font-size: 7.5pt; }
        .result-option { display: inline-flex; gap: 4px; align-items: center; margin-right: 12px; }
        .recommendations { display: flex; flex-wrap: wrap; gap: 5px 12px; padding: 5px 6px; border: 1px solid #C9D2DC; }
        .advisory-lines { height: 22px; border-bottom: 1px solid #C9D2DC; }
        .declaration { margin: 0 0 8px; padding: 6px; background: #F5F8FA; border: 1px solid #C9D2DC; color: #5B6673; font-size: 7.3pt; }
        .sign-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
        .sign-field { height: 36px; padding: 4px 2px; border-bottom: 1px solid #5B6673; }
        .sign-label { color: #5B6673; font-size: 7pt; }
        .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 4px; }
        .signature-box { height: 58px; border-bottom: 1px solid #5B6673; }
        .date-box { height: 28px; border-bottom: 1px solid #5B6673; }
        @page { size: A4 portrait; margin: 22mm 20mm 20mm 20mm; }
        @media screen { body { width: 170mm; margin: 12mm auto; } .report-page { min-height: 253mm; padding: 0; } }
      </style>
    </head>
    <body>
      <main>
        <section class="report-page">
          <div class="title-block">
            <h1>Engineer's Report</h1>
            <div class="subtitle">Combi oven refurbishment &amp; 57-point service check</div>
            <p class="intro">Complete one report per oven. Tick Pass, Fail or N/A for every check, and record readings and notes where relevant. Any Fail must be explained in section 6 and resolved before the oven is signed off for sale.</p>
          </div>

          <section class="section">
            <h2 class="section-title"><span class="number">1.</span><span>Job details</span></h2>
            <div class="field-grid">
              ${field("Report no.", reportNumber)}
              ${field("Date", formattedDate)}
              ${field("Engineer", record.engineer)}
              ${field("Gas Safe no. (gas ovens)", null)}
              ${field("Job type", null, { choices: ["Refurb for sale", "Service", "Repair"] })}
              ${field("Stock no. / SKU", `Asset no. ${assetNumber}`)}
              ${field("Customer (if applicable)", null)}
              ${field("Site / location", null)}
            </div>
          </section>

          <section class="section">
            <h2 class="section-title"><span class="number">2.</span><span>Oven details</span></h2>
            <div class="field-grid">
              ${field("Make", record.make, { blank: true })}
              ${field("Model", record.model, { blank: true })}
              ${field("Serial number", record.serialNumber)}
              ${field("Year of manufacture", yearOfManufacture)}
              ${field("Size", size, { choices: ["6", "10", "20", "40 grid", "other"] })}
              ${field("Fuel type", record.fuelType, { choices: ["Electric", "Gas (NG / LPG)"], selected: fuelChoice })}
              ${field("Power supply", powerSupply, { choices: ["1 phase", "3 phase"] })}
              ${field("Software version", softwareVersion)}
              ${field("Operating hours", record.operatingHours)}
              ${field("CTU / water softener", ctuFitted, { choices: ["Fitted", "Not fitted"] })}
            </div>
          </section>

          <section class="section">
            <h2 class="section-title"><span class="number">3.</span><span>57-point check</span></h2>
            <p class="section-hint">Pass = working to manufacturer specification. Fail = fault found (record in section 6). N/A = not fitted or not applicable to this model or fuel type.</p>
            ${checklistTable(firstChecklistPage)}
          </section>
        </section>

        <section class="report-page">
          <div class="section-continuation">3. 57-point check (continued)</div>
          ${checklistTable(secondChecklistPage)}
        </section>

        <section class="report-page">
          <section class="section">
            <h2 class="section-title"><span class="number">4.</span><span>Test readings</span></h2>
            ${readingsTable(record)}
          </section>
          <section class="section">
            <h2 class="section-title"><span class="number">5.</span><span>Parts replaced</span></h2>
            ${partsTable(record)}
          </section>
          <section class="section">
            <h2 class="section-title"><span class="number">6.</span><span>Faults found &amp; work carried out</span></h2>
            <p class="work-summary">${escapeHtml(workSummary)}</p>
            <div class="fault-line"></div><div class="fault-line"></div><div class="fault-line"></div>
          </section>
        </section>

        <section class="report-page">
          <section class="section">
            <h2 class="section-title"><span class="number">7.</span><span>Result &amp; recommendations</span></h2>
            <div class="field">
              <div class="field-label">Overall result</div>
              <div class="choices">
                ${checkbox("Passed – ready for sale / use")}
                ${checkbox("Passed with advisories")}
                ${checkbox("Failed – further work required")}
              </div>
            </div>
            <div class="field-grid">
              ${field("Cosmetic grade", null, { choices: ["Grade A – excellent", "Grade B – light marks", "Grade C – visible wear"] })}
              <div class="field"><div class="field-label">Recommended with this oven</div><div class="recommendations">${checkbox("CTU water softener")}${checkbox("Tundish & drain kit")}${checkbox("Drain pump")}${checkbox("Stand")}</div></div>
              ${field("Next service due", null)}
            </div>
            <div class="field" style="margin-top:5px">
              <div class="field-label">Advisories / notes for the customer</div>
              <div class="advisory-lines"></div><div class="advisory-lines"></div><div class="advisory-lines"></div>
            </div>
          </section>

          ${warningPanel(record)}

          <section class="section">
            <h2 class="section-title"><span class="number">8.</span><span>Sign-off</span></h2>
            <p class="declaration">I confirm the checks above have been carried out and the oven is safe to use when installed by a qualified catering engineer to manufacturer guidelines.</p>
            <div class="sign-grid">
              <div class="sign-field"><div class="sign-label">Engineer name</div></div>
              <div class="sign-field"><div class="sign-label">Checked by</div></div>
            </div>
            <div class="signatures">
              <div class="signature-box"><div class="sign-label">Signature</div></div>
              <div class="signature-box"><div class="sign-label">Signature</div></div>
            </div>
            <div class="sign-grid" style="margin-top:4px">
              <div class="date-box"><div class="sign-label">Date</div></div>
              <div class="date-box"><div class="sign-label">Date</div></div>
            </div>
          </section>
        </section>
      </main>
    </body>
  </html>`;
}

function headerTemplate(): string {
  return `<div style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:8px;color:#0D1117;padding:0 20mm 4px;display:flex;justify-content:space-between;border-bottom:1px solid #04659B;-webkit-print-color-adjust:exact;">
    <span style="font-weight:700">CaterCombi Ltd</span><span>Engineer's Report: Combi Oven</span>
  </div>`;
}

function footerTemplate(): string {
  return `<div style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:7px;color:#5B6673;padding:4px 20mm 0;display:flex;justify-content:space-between;border-top:1px solid #C9D2DC;-webkit-print-color-adjust:exact;">
    <span>CaterCombi Ltd · 6 Jackson Road, Wincheap Industrial Estate, Canterbury, Kent, CT1 3RF · Company No. 10072349</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;
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
  const args = localExecutable
    ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    : chromium.args;
  return puppeteer.launch({
    executablePath,
    headless: true,
    args,
  });
}

export async function generateEngineerReportPdf(
  assetNumber: string,
  record: EngineerReportServiceRecord,
  reportNumber: string,
): Promise<Uint8Array> {
  const browser = await launchPdfBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(reportHtml(assetNumber, record, reportNumber), { waitUntil: "load" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerTemplate(),
      footerTemplate: footerTemplate(),
      margin: { top: "22mm", right: "20mm", bottom: "20mm", left: "20mm" },
      preferCSSPageSize: true,
      timeout: 8_000,
    });
  } finally {
    await browser.close();
  }
}

export function buildEngineerReportHtml(
  assetNumber: string,
  record: EngineerReportServiceRecord,
  reportNumber: string,
): string {
  return reportHtml(assetNumber, record, reportNumber);
}