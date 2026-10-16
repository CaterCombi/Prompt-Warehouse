import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSalesWorkweek } from "../src/lib/salesWorkweek.ts";

test("counts non-accessory AMT assets by Date sold regardless of current status", () => {
  const summary = summarizeSalesWorkweek([
    { manufacturer: "Rational", status: "On Hire", dateSold: "2026-10-12" },
    { manufacturer: "Rational", status: "On Hire", dateSold: "2026-10-12T15:30:00Z" },
    { manufacturer: "Rational", status: "On Hire", dateSold: "2026-10-12" },
    { manufacturer: "CaterCombi Accessory", status: "Sold", dateSold: "2026-10-12" },
    { manufacturer: "CaterCombi Accessory", status: "Sold", dateSold: "2026-10-12" },
    { manufacturer: "Rational", status: "Sold", dateSold: "2026-10-13" },
    { manufacturer: "Rational", status: "Booked", dateSold: "2026-10-13" },
    { manufacturer: "Rational", status: "Available", dateSold: "2026-10-16" },
    { manufacturer: "Rational", status: "Sold", dateSold: "2026-10-17" },
    { status: "Sold", dateSold: "not a date" },
    { status: "Sold", dateSold: "" },
  ], new Date("2026-10-14T12:00:00Z"));

  assert.equal(summary.startDate, "2026-10-12");
  assert.equal(summary.endDate, "2026-10-16");
  assert.equal(summary.total, 6);
  assert.deepEqual(summary.days, [
    { weekday: "Monday", date: "2026-10-12", count: 3 },
    { weekday: "Tuesday", date: "2026-10-13", count: 2 },
    { weekday: "Wednesday", date: "2026-10-14", count: 0 },
    { weekday: "Thursday", date: "2026-10-15", count: 0 },
    { weekday: "Friday", date: "2026-10-16", count: 1 },
  ]);
});

test("resets to the upcoming Monday-Friday workweek on Sunday", () => {
  const summary = summarizeSalesWorkweek([
    { status: "Sold", dateSold: "2026-10-12T23:30:00Z" },
    { status: "Sold", dateSold: "2026-10-18T12:00:00Z" },
    { status: "Booked", dateSold: "2026-10-19" },
  ], new Date("2026-10-18T12:00:00Z"));

  assert.equal(summary.startDate, "2026-10-19");
  assert.equal(summary.endDate, "2026-10-23");
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.days.map((day) => day.count), [1, 0, 0, 0, 0]);
});
