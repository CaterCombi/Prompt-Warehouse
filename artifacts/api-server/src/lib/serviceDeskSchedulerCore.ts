export const DEFAULT_FTP_POLL_INTERVAL_MINUTES = 15;
const MAX_FTP_POLL_INTERVAL_MINUTES = 24 * 60;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function getZonedDateParts(instant: Date, timeZone: string): ZonedDateParts {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function getTimeZoneOffsetMs(instantMs: number, timeZone: string): number {
  const local = getZonedDateParts(new Date(instantMs), timeZone);
  return Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  ) - instantMs;
}

function resolveZonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute);
  let instantMs = localAsUtcMs - getTimeZoneOffsetMs(localAsUtcMs, timeZone);
  instantMs = localAsUtcMs - getTimeZoneOffsetMs(instantMs, timeZone);
  return new Date(instantMs);
}

export function nextDailyRunAt(
  now: Date,
  timeZone: string,
  hour: number,
  minute: number,
): Date {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Daily refresh requires a valid current time");
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23
    || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("Daily refresh time must use a valid hour and minute");
  }

  const localNow = getZonedDateParts(now, timeZone);
  let target = resolveZonedTime(
    localNow.year,
    localNow.month,
    localNow.day,
    hour,
    minute,
    timeZone,
  );
  if (target.getTime() <= now.getTime()) {
    const tomorrow = new Date(
      Date.UTC(localNow.year, localNow.month - 1, localNow.day) + DAY_MS,
    );
    target = resolveZonedTime(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
  }
  return target;
}

export function startDailyPolling(
  run: () => Promise<unknown>,
  timeZone: string,
  hour: number,
  minute: number,
  onError: (error: unknown) => void,
  scheduleTimeout: typeof setTimeout = setTimeout,
  getNow: () => Date = () => new Date(),
): ReturnType<typeof setTimeout> {
  const scheduleNext = (): ReturnType<typeof setTimeout> => {
    const now = getNow();
    const nextRunAt = nextDailyRunAt(now, timeZone, hour, minute);
    const timer = scheduleTimeout(() => {
      void Promise.resolve()
        .then(run)
        .catch(onError)
        .finally(scheduleNext);
    }, Math.max(1, nextRunAt.getTime() - now.getTime()));
    timer.unref?.();
    return timer;
  };

  return scheduleNext();
}

export function resolveFtpPollIntervalMs(configuredValue: string | undefined): number {
  const value = configuredValue?.trim();
  if (!value) return DEFAULT_FTP_POLL_INTERVAL_MINUTES * MINUTE_MS;

  if (!/^\d+$/.test(value)) {
    throw new Error("SERVICE_DESK_FTP_POLL_INTERVAL_MINUTES must be a whole number of minutes");
  }

  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_FTP_POLL_INTERVAL_MINUTES) {
    throw new Error(`SERVICE_DESK_FTP_POLL_INTERVAL_MINUTES must be between 1 and ${MAX_FTP_POLL_INTERVAL_MINUTES}`);
  }

  return minutes * MINUTE_MS;
}

export function startFtpPolling(
  run: () => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
  scheduleInterval: typeof setInterval = setInterval,
): ReturnType<typeof setInterval> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("FTP polling interval must be a positive integer number of milliseconds");
  }

  const timer = scheduleInterval(() => {
    try {
      void Promise.resolve(run()).catch(onError);
    } catch (error) {
      onError(error);
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export function createNonOverlappingRunner() {
  let inFlight = false;

  return async function runNonOverlapping<T>(
    operation: () => Promise<T>,
  ): Promise<{ locked: true } | { locked: false; value: T }> {
    if (inFlight) return { locked: true };
    inFlight = true;
    try {
      return { locked: false, value: await operation() };
    } finally {
      inFlight = false;
    }
  };
}