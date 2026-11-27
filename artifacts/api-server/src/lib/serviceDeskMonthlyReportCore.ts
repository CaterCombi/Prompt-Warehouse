export const SERVICE_DESK_REPORT_TIME_ZONE = "Europe/London";
export const SERVICE_DESK_REPORT_HOUR = 16;
export const SERVICE_DESK_REPORT_MINUTE = 0;

export type ServiceDeskMonthRange = {
  start: Date;
  end: Date;
  startDate: string;
  endDate: string;
};

function validateMonth(month: string): { year: number; monthNumber: number } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("Service Desk report month must use YYYY-MM format");
  }
  const [year, monthNumber] = month.split("-").map(Number);
  return { year, monthNumber };
}

function londonParts(instant: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: SERVICE_DESK_REPORT_TIME_ZONE,
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
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function londonMidnightUtc(year: number, monthNumber: number, day: number): Date {
  const target = Date.UTC(year, monthNumber - 1, day);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: SERVICE_DESK_REPORT_TIME_ZONE,
        calendar: "gregory",
        numberingSystem: "latn",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(new Date(candidate)).map(({ type, value }) => [type, value]),
    );
    const representedAsUtc = Date.UTC(
      Number(local.year),
      Number(local.month) - 1,
      Number(local.day),
      Number(local.hour),
      Number(local.minute),
    );
    const adjustment = target - representedAsUtc;
    if (adjustment === 0) return new Date(candidate);
    candidate += adjustment;
  }
  return new Date(candidate);
}

export function serviceDeskReportMonthRange(month: string): ServiceDeskMonthRange {
  const { year, monthNumber } = validateMonth(month);
  const nextMonth = monthNumber === 12
    ? { year: year + 1, monthNumber: 1 }
    : { year, monthNumber: monthNumber + 1 };
  const start = londonMidnightUtc(year, monthNumber, 1);
  const end = londonMidnightUtc(nextMonth.year, nextMonth.monthNumber, 1);
  const lastDay = new Date(Date.UTC(nextMonth.year, nextMonth.monthNumber - 1, 0)).getUTCDate();
  return {
    start,
    end,
    startDate: `${month}-01`,
    endDate: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

export function serviceDeskReportMonthLabel(month: string): string {
  const { year, monthNumber } = validateMonth(month);
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

export function serviceDeskMonthlyReportFilename(month: string): string {
  validateMonth(month);
  return `Service Desk Report ${month}.pdf`;
}

function lastWorkingDateKeyForMonth(
  year: number,
  month: number,
  bankHolidayDates: ReadonlySet<string>,
): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = lastDay; day >= 1; day -= 1) {
    const date = new Date(Date.UTC(year, month - 1, day));
    const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !bankHolidayDates.has(key)) return key;
  }
  throw new Error("No working day exists in the requested month");
}

export function dueServiceDeskReportMonth(
  now: Date,
  bankHolidayDates: ReadonlySet<string>,
): string | null {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Service Desk report requires a valid current time");
  }
  const local = londonParts(now);
  if (
    local.hour < SERVICE_DESK_REPORT_HOUR
    || (local.hour === SERVICE_DESK_REPORT_HOUR && local.minute < SERVICE_DESK_REPORT_MINUTE)
  ) return null;
  const localDateKey = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  if (localDateKey !== lastWorkingDateKeyForMonth(local.year, local.month, bankHolidayDates)) {
    return null;
  }
  return `${local.year}-${String(local.month).padStart(2, "0")}`;
}
