import assert from "node:assert/strict";
import test from "node:test";
import {
  getLondonDateKey,
  isLastWorkingDayOfLondonMonth,
  isLondonAtOrAfterTime,
  lastWorkingDateKeyForMonth,
  parseEnglandAndWalesBankHolidayDates,
  selectNewestAllJobsReport,
} from "../src/lib/joblogicAllJobsReportCore.ts";
import { nextDailyRunAt } from "../src/lib/serviceDeskSchedulerCore.ts";

test("selects the newest matching All Jobs CSV by modified time", () => {
  const selected = selectNewestAllJobsReport([
    { name: "All Jobs_old.csv", type: 1, modifiedAt: new Date("2026-09-01T10:00:00Z") },
    { name: "All Jobs_new.csv", type: 1, modifiedAt: new Date("2026-10-15T08:01:26Z") },
    { name: "All Jobs_folder.csv", type: 2, modifiedAt: new Date("2026-11-01T10:00:00Z") },
    { name: "All Sites_new.csv", type: 1, modifiedAt: new Date("2026-11-01T10:00:00Z") },
  ]);

  assert.equal(selected?.name, "All Jobs_new.csv");
});

test("returns null when the FTP root has no matching report", () => {
  assert.equal(
    selectNewestAllJobsReport([
      { name: "All Jobs.csv", type: 1, modifiedAt: new Date("2026-11-01T10:00:00Z") },
      { name: "All Jobs_new.csv", type: 2, modifiedAt: new Date("2026-11-02T10:00:00Z") },
    ]),
    null,
  );
});

test("refuses to choose a newest file if a matching report lacks its modified time", () => {
  assert.throws(
    () => selectNewestAllJobsReport([
      { name: "All Jobs_known.csv", type: 1, modifiedAt: new Date("2026-11-01T10:00:00Z") },
      { name: "All Jobs_unknown.csv", type: 1, modifiedAt: null },
    ]),
    /Modified time was missing/,
  );
});

test("parses only the England and Wales bank holiday dates", () => {
  const dates = parseEnglandAndWalesBankHolidayDates({
    "england-and-wales": { events: [{ date: "2026-12-25" }, { date: "2026-12-28" }] },
    scotland: { events: [{ date: "2026-11-30" }] },
  });

  assert.deepEqual([...dates], ["2026-12-25", "2026-12-28"]);
  assert.throws(() => parseEnglandAndWalesBankHolidayDates({}), /England and Wales/);
});

test("finds the last working date after a weekend and bank holiday", () => {
  assert.equal(
    lastWorkingDateKeyForMonth(2026, 8, new Set(["2026-08-31", "2026-08-28"])),
    "2026-08-27",
  );
});

test("uses Europe/London local dates and handles British Summer Time", () => {
  const beforeSixteenLondon = new Date("2026-03-31T14:59:00Z");
  const atSixteenLondon = new Date("2026-03-31T15:00:00Z");

  assert.equal(getLondonDateKey(atSixteenLondon), "2026-03-31");
  assert.equal(isLondonAtOrAfterTime(beforeSixteenLondon, 16, 0), false);
  assert.equal(isLondonAtOrAfterTime(atSixteenLondon, 16, 0), true);
  assert.equal(
    isLastWorkingDayOfLondonMonth(atSixteenLondon, new Set()),
    true,
  );
});

test("treats a month-ending bank holiday as non-working", () => {
  assert.equal(
    isLastWorkingDayOfLondonMonth(
      new Date("2026-08-28T15:00:00Z"),
      new Set(["2026-08-31"]),
    ),
    true,
  );
  assert.equal(
    isLastWorkingDayOfLondonMonth(
      new Date("2026-08-27T15:00:00Z"),
      new Set(["2026-08-31"]),
    ),
    false,
  );
});

test("schedules the next 4pm London run on the correct side of daylight-saving time", () => {
  assert.equal(
    nextDailyRunAt(
      new Date("2026-03-31T14:00:00Z"),
      "Europe/London",
      16,
      0,
    ).toISOString(),
    "2026-03-31T15:00:00.000Z",
  );
  assert.equal(
    nextDailyRunAt(
      new Date("2026-10-25T01:30:00Z"),
      "Europe/London",
      16,
      0,
    ).toISOString(),
    "2026-10-25T16:00:00.000Z",
  );
});
