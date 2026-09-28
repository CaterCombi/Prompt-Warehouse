import assert from "node:assert/strict";
import test from "node:test";
import {
  createNonOverlappingRunner,
  DEFAULT_FTP_POLL_INTERVAL_MINUTES,
  resolveFtpPollIntervalMs,
  startFtpPolling,
} from "../src/lib/serviceDeskSchedulerCore.ts";

const minute = 60_000;

test("FTP polling defaults to 15 minutes and accepts a configured interval", () => {
  assert.equal(DEFAULT_FTP_POLL_INTERVAL_MINUTES, 15);
  assert.equal(resolveFtpPollIntervalMs(undefined), 15 * minute);
  assert.equal(resolveFtpPollIntervalMs(" 30 "), 30 * minute);
});

test("FTP polling rejects invalid or unsafe intervals", () => {
  for (const value of ["0", "-2", "1.5", "abc", "1441"]) {
    assert.throws(() => resolveFtpPollIntervalMs(value), /SERVICE_DESK_FTP_POLL_INTERVAL_MINUTES/);
  }
});

test("the next FTP poll invokes the schedule importer runner", () => {
  let nextPoll;
  let configuredInterval;
  let unrefCalled = false;
  let imports = 0;

  startFtpPolling(
    async () => { imports += 1; },
    resolveFtpPollIntervalMs("5"),
    error => { throw error; },
    (callback, intervalMs) => {
      nextPoll = callback;
      configuredInterval = intervalMs;
      return { unref() { unrefCalled = true; } };
    },
  );

  assert.equal(configuredInterval, 5 * minute);
  assert.equal(unrefCalled, true);
  assert.equal(imports, 0);
  nextPoll();
  assert.equal(imports, 1);
});

test("FTP poll failures are handled and later polls can still run", async () => {
  let nextPoll;
  const errors = [];
  let attempts = 0;

  startFtpPolling(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary FTP failure");
    },
    minute,
    error => errors.push(error),
    callback => {
      nextPoll = callback;
      return { unref() {} };
    },
  );

  nextPoll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "temporary FTP failure");

  nextPoll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
});

test("shared ingestion runner prevents overlapping FTP and HubSpot syncs", async () => {
  const runWithLock = createNonOverlappingRunner();
  let releaseFirst;
  const first = runWithLock(() => new Promise(resolve => { releaseFirst = resolve; }));

  assert.deepEqual(await runWithLock(async () => "overlap"), { locked: true });
  releaseFirst("finished");
  assert.deepEqual(await first, { locked: false, value: "finished" });
  assert.deepEqual(await runWithLock(async () => "next"), { locked: false, value: "next" });
});