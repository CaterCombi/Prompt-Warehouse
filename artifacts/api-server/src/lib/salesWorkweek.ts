const timeZone = "Europe/London";
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;

function calendarDateInTimeZone(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function validDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? value : null;
}

function soldCalendarDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return validDateOnly(normalized);
  const dateOnly = validDateOnly(normalized);
  if (dateOnly) return dateOnly;

  const instant = new Date(normalized);
  return Number.isFinite(instant.getTime()) ? calendarDateInTimeZone(instant) : null;
}

export function summarizeSalesWorkweek(
  assets: Array<{ manufacturer?: unknown; dateSold?: unknown }>,
  now = new Date(),
) {
  const localToday = calendarDateInTimeZone(now);
  const [year, month, day] = localToday.split("-").map(Number);
  const monday = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = monday.getUTCDay();
  monday.setUTCDate(monday.getUTCDate() - ((dayOfWeek + 6) % 7));
  if (dayOfWeek === 0) monday.setUTCDate(monday.getUTCDate() + 7);

  const days = weekdays.map((weekday, index) => {
    const date = new Date(monday);
    date.setUTCDate(date.getUTCDate() + index);
    return { weekday, date: date.toISOString().slice(0, 10), count: 0 };
  });
  const countsByDate = new Map(days.map((item) => [item.date, item]));

  for (const asset of assets) {
    if (String(asset.manufacturer ?? "").trim().toLowerCase() === "catercombi accessory") continue;
    const date = soldCalendarDate(asset.dateSold);
    const day = date ? countsByDate.get(date) : undefined;
    if (day) day.count += 1;
  }

  return {
    startDate: days[0].date,
    endDate: days[days.length - 1].date,
    total: days.reduce((sum, day) => sum + day.count, 0),
    days,
  };
}
