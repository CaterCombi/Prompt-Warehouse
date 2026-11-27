import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMonthlyServiceDeskReport,
  classifyServiceDeskReportJobType,
  parseServiceDeskReportAssetRefs,
} from "../src/lib/serviceDeskMonthlyReportDataCore.ts";

const generatedAt = new Date("2026-11-02T09:00:00Z");
const freshSource = {
  createdAt: new Date("2026-11-01T09:00:00Z"),
  metadata: {
    status: "fresh",
    filename: "All Jobs_2026-10.csv",
    sourceModifiedAt: "2026-10-31T16:00:00Z",
    maxAgeDays: 35,
  },
};
const jobRows = [
  {
    externalId: "joblogic:completed:100:earlier",
    jobRef: "100",
    jobType: "Rental full service",
    assetRef: "00123",
    site: "London Site",
    engineer: "Engineer A",
    completedAt: new Date("2026-10-15T10:00:00Z"),
  },
  {
    externalId: "joblogic:completed:100:latest",
    jobRef: "100",
    jobType: "Rental full service",
    assetRef: "00123",
    site: "London Site",
    engineer: "Engineer A",
    completedAt: new Date("2026-10-31T23:30:00Z"),
  },
  {
    externalId: "joblogic:completed:101",
    jobRef: "101",
    jobType: "Sale installation",
    assetRef: "00500",
    site: "Bristol Site",
    engineer: "Engineer B",
    completedAt: new Date("2026-10-10T08:00:00Z"),
  },
  {
    externalId: "joblogic:completed:102",
    jobRef: "102",
    jobType: "Unmapped inspection",
    assetRef: null,
    site: "Leeds Site",
    engineer: null,
    completedAt: new Date("2026-10-12T08:00:00Z"),
  },
  {
    externalId: "joblogic:completed:103",
    jobRef: "103",
    jobType: "Rental repair",
    assetRef: "123",
    site: "London Site",
    engineer: "Engineer A",
    completedAt: new Date("2026-10-18T08:00:00Z"),
  },
  {
    externalId: "joblogic:completed:104",
    jobRef: "104",
    jobType: "Rental installation",
    assetRef: "900",
    site: "Outside period",
    engineer: "Engineer C",
    completedAt: new Date("2026-11-01T00:30:00Z"),
  },
];

test("classifies job types without silently treating unknown types as repairs", () => {
  assert.equal(classifyServiceDeskReportJobType("Sale installation"), "Installation");
  assert.equal(classifyServiceDeskReportJobType("Rental full service"), "Service");
  assert.equal(classifyServiceDeskReportJobType("General call out"), "Repair");
  assert.equal(classifyServiceDeskReportJobType("Unmapped inspection"), "Other");
  assert.equal(classifyServiceDeskReportJobType(null), "Unclassified");
});

test("parses asset lists and ignores blank asset references", () => {
  assert.deepEqual(parseServiceDeskReportAssetRefs("1001, 1002; 1001"), ["1001", "1002"]);
  assert.deepEqual(parseServiceDeskReportAssetRefs(null), []);
});

test("monthly totals use distinct completed jobs and assets, with raw types retained", () => {
  const report = buildMonthlyServiceDeskReport("2026-10", jobRows, freshSource, generatedAt);
  assert.equal(report.totals.completedJobs, 4);
  assert.equal(report.totals.installations, 1);
  assert.equal(report.totals.services, 1);
  assert.equal(report.totals.repairs, 1);
  assert.equal(report.totals.otherJobs, 1);
  assert.equal(report.totals.distinctServiceAssets, 1);
  assert.equal(report.source.status, "fresh");
  assert.equal(report.jobs.find((job) => job.jobRef === "100")?.completedAt, "2026-10-31T23:30:00.000Z");
  assert.deepEqual(report.assets[0].jobRefs, ["100", "103"]);
  assert.equal(report.assets[0].assetRef, "123");
  assert.equal(report.jobTypeBreakdown.find((row) => row.jobType === "Unmapped inspection")?.jobs, 1);
  assert.equal(report.jobs.some((job) => job.jobRef === "104"), false);
});

test("stale Joblogic freshness stays visible in the report data", () => {
  const report = buildMonthlyServiceDeskReport(
    "2026-10",
    jobRows,
    { ...freshSource, metadata: { ...freshSource.metadata, sourceModifiedAt: "2026-09-01T00:00:00Z" } },
    generatedAt,
  );
  assert.equal(report.source.status, "stale");
  assert.match(report.notes.at(-1), /stale/i);
});
