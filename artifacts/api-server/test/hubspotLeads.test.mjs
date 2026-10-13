import assert from "node:assert/strict";
import test from "node:test";
import { isCaterDirectLead, normalizeHubSpotLead } from "../src/lib/hubspotLeadCore.ts";

test("normalizes HubSpot Lead name, label, stage, company, and creation date", () => {
  assert.deepEqual(normalizeHubSpotLead({
    id: "lead-123",
    properties: {
      hs_lead_name: "  Jane Doe  ",
      hs_lead_label: "HOT",
      hs_pipeline_stage: "connected",
      createdate: "2026-10-13T10:00:00.000Z",
    },
  }, "Example Catering Ltd", { connected: "Connected" }), {
    id: "lead-123",
    name: "Jane Doe",
    label: "HOT",
    stage: "Connected",
    companyName: "Example Catering Ltd",
    createdAt: "2026-10-13T10:00:00.000Z",
  });
});

test("keeps HubSpot Leads with missing display values usable", () => {
  assert.deepEqual(normalizeHubSpotLead({ id: "lead-456", properties: {} }), {
    id: "lead-456",
    name: "(Unnamed lead)",
    label: null,
    stage: null,
    companyName: null,
    createdAt: null,
  });
});

test("excludes a lead assigned to the CaterDirect brand without matching partial IDs", () => {
  assert.equal(isCaterDirectLead({
    id: "direct-lead",
    properties: { hs_all_assigned_business_unit_ids: "123; 17577089 " },
  }), true);
  assert.equal(isCaterDirectLead({
    id: "combi-lead",
    properties: { hs_all_assigned_business_unit_ids: "12345" },
  }), false);
  assert.equal(isCaterDirectLead({ id: "unassigned-lead", properties: {} }), false);
});

