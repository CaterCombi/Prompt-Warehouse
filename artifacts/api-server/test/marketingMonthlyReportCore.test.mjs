import assert from "node:assert/strict";
import test from "node:test";
import {
  dueMarketingReportMonth,
  monthlyMarketingReportFilename,
} from "../src/lib/marketingMonthlyReportCore.ts";

test("monthly report is due on the first at 09:00 London time and reports the previous month", () => {
  assert.equal(dueMarketingReportMonth(new Date("2026-11-01T08:59:00.000Z")), null);
  assert.equal(dueMarketingReportMonth(new Date("2026-11-01T09:00:00.000Z")), "2026-10");
  assert.equal(dueMarketingReportMonth(new Date("2026-11-01T12:00:00.000Z")), "2026-10");
});

test("monthly report timing follows London daylight saving time and never catches up on other dates", () => {
  assert.equal(dueMarketingReportMonth(new Date("2026-07-01T07:59:00.000Z")), null);
  assert.equal(dueMarketingReportMonth(new Date("2026-07-01T08:00:00.000Z")), "2026-06");
  assert.equal(dueMarketingReportMonth(new Date("2026-10-05T09:00:00.000Z")), null);
});

test("monthly report scheduling rejects invalid clock values", () => {
  assert.throws(() => dueMarketingReportMonth(new Date(Number.NaN)), /valid current time/);
});

test("monthly marketing report filenames use the reporting month end date", () => {
  assert.equal(monthlyMarketingReportFilename("2026-11"), "Marketing-2026-11-30.pdf");
  assert.equal(monthlyMarketingReportFilename("2024-02"), "Marketing-2024-02-29.pdf");
  assert.throws(() => monthlyMarketingReportFilename("November 2026"), /YYYY-MM/);
});
