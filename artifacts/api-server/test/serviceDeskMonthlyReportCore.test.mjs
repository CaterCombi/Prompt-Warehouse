import assert from "node:assert/strict";
import test from "node:test";
import {
  dueServiceDeskReportMonth,
  serviceDeskMonthlyReportFilename,
  serviceDeskReportMonthRange,
} from "../src/lib/serviceDeskMonthlyReportCore.ts";

test("Service Desk reporting periods use London calendar-month boundaries", () => {
  const march = serviceDeskReportMonthRange("2026-03");
  assert.equal(march.start.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(march.end.toISOString(), "2026-03-31T23:00:00.000Z");
  assert.equal(march.startDate, "2026-03-01");
  assert.equal(march.endDate, "2026-03-31");

  const october = serviceDeskReportMonthRange("2026-10");
  assert.equal(october.start.toISOString(), "2026-09-30T23:00:00.000Z");
  assert.equal(october.end.toISOString(), "2026-11-01T00:00:00.000Z");
});

test("Service Desk reports run after 09:00 London time on the first", () => {
  assert.equal(dueServiceDeskReportMonth(new Date("2026-12-01T08:59:00Z")), null);
  assert.equal(dueServiceDeskReportMonth(new Date("2026-12-01T09:00:00Z")), "2026-11");
  assert.equal(dueServiceDeskReportMonth(new Date("2026-04-01T08:00:00Z")), "2026-03");
  assert.equal(dueServiceDeskReportMonth(new Date("2026-12-02T09:00:00Z")), null);
  assert.equal(serviceDeskMonthlyReportFilename("2026-11"), "Service Desk Report 2026-11.pdf");
  assert.throws(() => serviceDeskMonthlyReportFilename("2026-13"), /YYYY-MM/);
});
