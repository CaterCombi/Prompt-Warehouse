export const MARKETING_REPORT_TIME_ZONE = "Europe/London";
export const MARKETING_REPORT_HOUR = 9;
export const MARKETING_REPORT_MINUTE = 0;

export function monthlyMarketingReportFilename(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("Marketing report month must use YYYY-MM format");
  }
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `Marketing-${year}-${String(monthNumber).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}.pdf`;
}

type LondonDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
};

function londonDateParts(instant: Date): LondonDateParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: MARKETING_REPORT_TIME_ZONE,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
    }).formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
  };
}

export function dueMarketingReportMonth(now: Date): string | null {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Monthly marketing report requires a valid current time");
  }

  const local = londonDateParts(now);
  if (local.day !== 1 || local.hour < MARKETING_REPORT_HOUR) return null;

  const previousMonth = new Date(Date.UTC(local.year, local.month - 2, 1));
  return `${previousMonth.getUTCFullYear()}-${String(previousMonth.getUTCMonth() + 1).padStart(2, "0")}`;
}
