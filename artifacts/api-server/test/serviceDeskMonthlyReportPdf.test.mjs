import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMonthlyServiceDeskReportHtml, generateMonthlyServiceDeskReportPdf } from "../src/lib/serviceDeskMonthlyReportPdf.ts";

const report = {
  month: "2026-10",
  monthLabel: "October 2026",
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  generatedAt: "2026-11-02T09:00:00.000Z",
  source: {
    status: "fresh",
    filename: "All Jobs_2026-10.csv",
    modifiedAt: "2026-10-31T16:00:00.000Z",
    observedAt: "2026-11-01T09:00:00.000Z",
    ageDays: 1.7,
  },
  totals: {
    completedJobs: 3,
    installations: 1,
    services: 1,
    repairs: 1,
    otherJobs: 0,
    distinctServiceAssets: 1,
  },
  jobTypeBreakdown: [
    { jobType: "Rental full service", jobs: 1 },
    { jobType: "Sale installation", jobs: 1 },
    { jobType: "<script>alert('x')</script>", jobs: 1 },
  ],
  assets: [{
    assetRef: "00123",
    jobRefs: ["100", "101"],
    jobTypes: ["Rental full service"],
    sites: ["London Site"],
    engineers: ["Engineer A"],
    latestCompletedAt: "2026-10-31T23:30:00.000Z",
  }],
  jobs: [{
    jobRef: "100",
    jobType: "Rental full service",
    category: "Service",
    assetRef: "00123",
    site: "London Site",
    engineer: "Engineer A",
    completedAt: "2026-10-31T23:30:00.000Z",
  }],
  notes: ["The serviced-assets list includes assets linked to completed jobs."],
};

test("Service Desk PDF escapes Joblogic text and shows its source status", () => {
  const html = buildMonthlyServiceDeskReportHtml(report);
  assert.ok(html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"));
  assert.equal(html.includes("<script>alert('x')</script>"), false);
  assert.match(html, /Fresh All Jobs source/);
  assert.match(html, /Assets serviced or repaired/);
});

test("monthly Service Desk PDF contains extractable report data on A4", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "service-desk-report-pdf-"));
  try {
    const pdf = await generateMonthlyServiceDeskReportPdf(report);
    const pdfPath = join(temporaryDirectory, "service-desk-report.pdf");
    writeFileSync(pdfPath, pdf);
    const metadata = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
    const text = execFileSync("pdftotext", [pdfPath, "-"], { encoding: "utf8" }).toLowerCase();
    assert.match(metadata, /Pages:\s+[1-9]/);
    assert.match(metadata, /Page size:.*A4/);
    for (const expected of [
      "monthly activity report",
      "october 2026",
      "installations",
      "services",
      "assets serviced or repaired",
      "00123",
      "rental full service",
      "fresh all jobs source",
    ]) {
      assert.ok(text.includes(expected.toLowerCase()), `Expected generated PDF to contain "${expected}".`);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
