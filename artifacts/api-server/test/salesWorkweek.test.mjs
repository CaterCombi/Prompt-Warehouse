import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSalesWorkweek } from "../src/lib/salesWorkweek.ts";

test("counts Sold AMT assets by Date sold for the current Monday-to-Friday week", () => {
  const summary = summarizeSalesWorkweek([
    { status: "Sold", dateSold: "2026-10-12" },
    { status: " sold ", dateSold: "2026-10-12T15:30:00Z" },
    { status: "Sold", dateSold: "2026-10-13" },
    { status: "Booked", dateSold: "2026-10-13" },
    { status: "Sold", dateSold: "2026-10-16" },
    { status: "Sold", dateSold: "2026-10-17" },
    { status: "Available", dateSold: "2026-10-14" },
    { status: "Reserved", dateSold: "2026-10-14" },
    { status: "Sold", dateSold: "not a date" },
    { status: "Sold", dateSold: "" },
  ], new Date("2026-10-14T12:00:00Z"));

  assert.equal(summary.startDate, "2026-10-12");
  assert.equal(summary.endDate, "2026-10-16");
  assert.equal(summary.total, 5);
  assert.deepEqual(summary.days, [
    { weekday: "Monday", date: "2026-10-12", count: 2 },
    { weekday: "Tuesday", date: "2026-10-13", count: 2 },
    { weekday: "Wednesday", date: "2026-10-14", count: 0 },
    { weekday: "Thursday", date: "2026-10-15", count: 0 },
    { weekday: "Friday", date: "2026-10-16", count: 1 },
  ]);
});

test("uses the UK calendar date for timestamp Date sold values and keeps weekends out", () => {
  const summary = summarizeSalesWorkweek([
    { status: "Sold", dateSold: "2026-10-12T23:30:00Z" },
    { status: "Sold", dateSold: "2026-10-18T12:00:00Z" },
  ], new Date("2026-10-18T12:00:00Z"));

  assert.equal(summary.startDate, "2026-10-12");
  assert.equal(summary.endDate, "2026-10-16");
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.days.map((day) => day.count), [0, 1, 0, 0, 0]);
});
