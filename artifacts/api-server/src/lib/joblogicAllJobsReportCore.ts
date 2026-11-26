export type AllJobsFtpFile = {
  name: string;
  type: number;
  modifiedAt?: Date | null;
  size?: number;
};

type LondonDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function getLondonDateParts(instant: Date): LondonDateParts {
  if (!Number.isFinite(instant.getTime())) {
    throw new Error("A valid instant is required for the London schedule");
  }

  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(instant).map(({ type, value }) => [type, value]),
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function calendarDateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getLondonDateKey(instant: Date): string {
  const local = getLondonDateParts(instant);
  return calendarDateKey(local.year, local.month, local.day);
}

export function isLondonAtOrAfterTime(
  instant: Date,
  hour: number,
  minute: number,
): boolean {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23
    || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("London schedule time must use a valid hour and minute");
  }

  const local = getLondonDateParts(instant);
  return local.hour > hour || (local.hour === hour && local.minute >= minute);
}

export function lastWorkingDateKeyForMonth(
  year: number,
  month: number,
  bankHolidayDates: ReadonlySet<string>,
): string {
  if (!Number.isInteger(year) || year < 1
    || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("A valid year and month are required");
  }

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = lastDay; day >= 1; day--) {
    const date = new Date(Date.UTC(year, month - 1, day));
    const dayOfWeek = date.getUTCDay();
    const key = calendarDateKey(year, month, day);
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !bankHolidayDates.has(key)) {
      return key;
    }
  }

  throw new Error("No working day exists in the requested month");
}

export function isLastWorkingDayOfLondonMonth(
  instant: Date,
  bankHolidayDates: ReadonlySet<string>,
): boolean {
  const local = getLondonDateParts(instant);
  return getLondonDateKey(instant) === lastWorkingDateKeyForMonth(
    local.year,
    local.month,
    bankHolidayDates,
  );
}

export function parseEnglandAndWalesBankHolidayDates(payload: unknown): Set<string> {
  if (!payload || typeof payload !== "object") {
    throw new Error("GOV.UK returned an invalid bank holiday calendar");
  }

  const region = (payload as Record<string, unknown>)["england-and-wales"];
  if (!region || typeof region !== "object") {
    throw new Error("GOV.UK bank holiday calendar did not include England and Wales");
  }

  const events = (region as Record<string, unknown>).events;
  if (!Array.isArray(events)) {
    throw new Error("GOV.UK bank holiday calendar did not include holiday dates");
  }

  const dates = events
    .map((event) => event && typeof event === "object"
      ? (event as Record<string, unknown>).date
      : null)
    .filter((date): date is string =>
      typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date),
    );

  if (dates.length === 0) {
    throw new Error("GOV.UK bank holiday calendar contained no valid dates");
  }

  return new Set(dates);
}

export function selectNewestAllJobsReport<T extends AllJobsFtpFile>(
  files: readonly T[],
): T | null {
  const candidates = files.filter(
    (file) => file.type === 1 && /^All Jobs_.*\.csv$/i.test(file.name),
  );
  if (candidates.length === 0) return null;

  if (candidates.some(
    (file) => !(file.modifiedAt instanceof Date)
      || !Number.isFinite(file.modifiedAt.getTime()),
  )) {
    throw new Error("Modified time was missing for an All Jobs report");
  }

  return candidates.reduce((newest, candidate) =>
    candidate.modifiedAt!.getTime() > newest.modifiedAt!.getTime()
      ? candidate
      : newest,
  );
}
