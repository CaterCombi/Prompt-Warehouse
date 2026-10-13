import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHubSpotLead } from "../src/lib/hubspotLeadCore.ts";

test("normalizes HubSpot Lead name, label, company, and creation date", () => {
  assert.deepEqual(normalizeHubSpotLead({
    id: "lead-123",
    properties: {
      hs_lead_name: "  Jane Doe  ",
      hs_lead_label: "HOT",
      createdate: "2026-10-13T10:00:00.000Z",
    },
  }, "Example Catering Ltd"), {
    id: "lead-123",
    name: "Jane Doe",
    label: "HOT",
    companyName: "Example Catering Ltd",
    createdAt: "2026-10-13T10:00:00.000Z",
  });
});

test("keeps HubSpot Leads with missing display values usable", () => {
  assert.deepEqual(normalizeHubSpotLead({ id: "lead-456", properties: {} }), {
    id: "lead-456",
    name: "(Unnamed lead)",
    label: null,
    companyName: null,
    createdAt: null,
  });
});

