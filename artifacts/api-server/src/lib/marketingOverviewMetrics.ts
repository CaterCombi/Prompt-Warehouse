export type Ga4ReportRow = {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
};

export type Ga4DailySessions = {
  date: string;
  organicSessions: number;
  paidSessions: number;
};

export type Ga4ChannelSessions = {
  label: string;
  value: number;
  conversions: number;
  share: number;
};

function safeNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeGa4Date(value: string) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : value;
}

function isPaidChannel(label: string) {
  const normalized = label.trim().toLowerCase();
  return normalized.startsWith("paid ") || normalized === "cross-network" || normalized === "display";
}

export function aggregateGa4ReportRows(rows: Ga4ReportRow[]) {
  const channelTotals = new Map<string, { value: number; conversions: number }>();
  const dailyTotals = new Map<string, { organicSessions: number; paidSessions: number }>();

  for (const row of rows) {
    const date = normalizeGa4Date(row.dimensionValues?.[0]?.value ?? "");
    const label = row.dimensionValues?.[1]?.value ?? "Unassigned";
    const sessions = safeNumber(row.metricValues?.[0]?.value);
    const conversions = safeNumber(row.metricValues?.[1]?.value);
    const channel = channelTotals.get(label) ?? { value: 0, conversions: 0 };
    channel.value += sessions;
    channel.conversions += conversions;
    channelTotals.set(label, channel);

    if (!date) continue;
    const daily = dailyTotals.get(date) ?? { organicSessions: 0, paidSessions: 0 };
    if (label === "Organic Search") daily.organicSessions += sessions;
    if (isPaidChannel(label)) daily.paidSessions += sessions;
    dailyTotals.set(date, daily);
  }

  const channelRows = [...channelTotals.entries()]
    .map(([label, values]) => ({ label, ...values }))
    .filter((channel) => channel.value > 0)
    .sort((first, second) => second.value - first.value);
  const sessionsTotal = channelRows.reduce((total, channel) => total + channel.value, 0);
  const conversionsTotal = channelRows.reduce((total, channel) => total + channel.conversions, 0);
  const organicSessions = channelRows.find((channel) => channel.label === "Organic Search")?.value ?? 0;

  return {
    sessionsTotal,
    organicSessions,
    conversionsTotal,
    channels: channelRows.map(({ conversions, ...channel }) => ({
      ...channel,
      share: sessionsTotal ? Math.round((channel.value / sessionsTotal) * 100) : 0,
    })),
    dailySessions: [...dailyTotals.entries()]
      .map(([date, values]) => ({ date, ...values }))
      .sort((first, second) => first.date.localeCompare(second.date)),
  };
}

export function buildAcquisitionTrend(
  dateRange: { startDate: string; endDate: string },
  ga4DailySessions: Ga4DailySessions[] | null,
  dailyNewContacts?: Array<{ date: string; count: number }> | null,
) {
  if (!ga4DailySessions) return [];

  const sessionsByDate = new Map(ga4DailySessions.map((item) => [item.date, item]));
  const contactsByDate = new Map((dailyNewContacts ?? []).map((item) => [item.date, item.count]));
  const start = new Date(`${dateRange.startDate}T00:00:00Z`);
  const end = new Date(`${dateRange.endDate}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return [];

  const trend = [];
  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    const sessions = sessionsByDate.get(date);
    trend.push({
      date,
      organicSessions: sessions?.organicSessions ?? 0,
      paidSessions: sessions?.paidSessions ?? 0,
      ...(dailyNewContacts ? { newContacts: contactsByDate.get(date) ?? 0 } : {}),
    });
  }
  return trend;
}

export function buildLiveChannelMix(
  ga4Channels: Array<{ label: string; value: number }>,
  hubSpotContactSources?: Array<{ label: string; value: number }> | null,
  adsSpendByChannel?: Array<{ channel: string; spend: number }> | null,
) {
  const contactsByChannel = new Map(
    (hubSpotContactSources ?? []).map((item) => [item.label.trim().toLowerCase(), item.value]),
  );
  const spendByChannel = new Map(
    (adsSpendByChannel ?? []).map((item) => [item.channel.trim().toLowerCase(), item.spend]),
  );

  return ga4Channels.map((channel) => {
    const normalizedLabel = channel.label.trim().toLowerCase();
    const leads = hubSpotContactSources
      ? contactsByChannel.get(normalizedLabel) ?? 0
      : undefined;
    const spend = spendByChannel.get(normalizedLabel);
    const color = isPaidChannel(channel.label) ? "#e98945" : "#1a8f77";

    return {
      channel: channel.label,
      sessions: channel.value,
      ...(leads === undefined
        ? {}
        : {
            leads,
            conversionRate: channel.value ? Number(((leads / channel.value) * 100).toFixed(1)) : 0,
            ...(leads > 0 && spend !== undefined ? { costPerLead: Number((spend / leads).toFixed(2)) } : {}),
          }),
      color,
    };
  });
}