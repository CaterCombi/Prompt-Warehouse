import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateGa4ReportRows,
  buildAcquisitionTrend,
  buildLiveChannelMix,
} from "../src/lib/marketingOverviewMetrics.ts";

test("GA4 daily rows aggregate channel totals and split organic from paid sessions", () => {
  const snapshot = aggregateGa4ReportRows([
    { dimensionValues: [{ value: "20260929" }, { value: "Organic Search" }], metricValues: [{ value: "10" }, { value: "1" }] },
    { dimensionValues: [{ value: "20260929" }, { value: "Paid Search" }], metricValues: [{ value: "5" }, { value: "2" }] },
    { dimensionValues: [{ value: "20260929" }, { value: "Cross-network" }], metricValues: [{ value: "2" }, { value: "0" }] },
    { dimensionValues: [{ value: "20260929" }, { value: "Direct" }], metricValues: [{ value: "4" }, { value: "1" }] },
    { dimensionValues: [{ value: "20260930" }, { value: "Organic Search" }], metricValues: [{ value: "7" }, { value: "1" }] },
  ]);

  assert.equal(snapshot.sessionsTotal, 28);
  assert.equal(snapshot.organicSessions, 17);
  assert.equal(snapshot.conversionsTotal, 5);
  assert.deepEqual(snapshot.dailySessions, [
    { date: "2026-09-29", organicSessions: 10, paidSessions: 7 },
    { date: "2026-09-30", organicSessions: 7, paidSessions: 0 },
  ]);
  assert.equal(snapshot.channels.find((channel) => channel.label === "Organic Search")?.value, 17);
});

test("acquisition trend fills missing days and only includes HubSpot contacts when available", () => {
  const dateRange = { startDate: "2026-09-29", endDate: "2026-10-01" };
  const ga4 = [
    { date: "2026-09-29", organicSessions: 10, paidSessions: 4 },
    { date: "2026-10-01", organicSessions: 3, paidSessions: 0 },
  ];

  assert.deepEqual(
    buildAcquisitionTrend(dateRange, ga4, [{ date: "2026-09-29", count: 2 }]),
    [
      { date: "2026-09-29", organicSessions: 10, paidSessions: 4, newContacts: 2 },
      { date: "2026-09-30", organicSessions: 0, paidSessions: 0, newContacts: 0 },
      { date: "2026-10-01", organicSessions: 3, paidSessions: 0, newContacts: 0 },
    ],
  );

  const analyticsOnly = buildAcquisitionTrend(dateRange, ga4);
  assert.equal(analyticsOnly.length, 3);
  assert.equal("newContacts" in analyticsOnly[0], false);
  assert.deepEqual(buildAcquisitionTrend(dateRange, null), []);
});

test("GA4 channel sessions remain available without HubSpot CRM data", () => {
  const channels = buildLiveChannelMix([
    { label: "Organic Search", value: 25 },
    { label: "Paid Search", value: 10 },
  ]);

  assert.equal(channels.length, 2);
  assert.deepEqual(channels[0], {
    channel: "Organic Search",
    sessions: 25,
    color: "#1a8f77",
  });
  assert.equal("leads" in channels[1], false);
  assert.equal(channels[1].sessions, 10);
});

test("channel mix enriches GA4 sessions with matching HubSpot contacts and channel-specific paid cost", () => {
  const channels = buildLiveChannelMix(
    [
      { label: "Organic Search", value: 25 },
      { label: "Paid Search", value: 10 },
    ],
    [
      { label: "organic search", value: 5 },
      { label: "Paid Search", value: 2 },
    ],
    [{ channel: "Paid Search", spend: 50 }],
  );

  assert.deepEqual(channels[0], {
    channel: "Organic Search",
    sessions: 25,
    leads: 5,
    conversionRate: 20,
    color: "#1a8f77",
  });
  assert.deepEqual(channels[1], {
    channel: "Paid Search",
    sessions: 10,
    leads: 2,
    conversionRate: 20,
    costPerLead: 25,
    color: "#e98945",
  });
});