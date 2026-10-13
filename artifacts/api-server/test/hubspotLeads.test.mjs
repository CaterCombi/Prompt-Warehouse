import assert from "node:assert/strict";
import test from "node:test";
import { isCaterDirectLead, normalizeHubSpotLead } from "../src/lib/hubspotLeadCore.ts";

test("normalizes HubSpot Lead name, label, lead status, company, and creation date", () => {
  assert.deepEqual(normalizeHubSpotLead({
    id: "lead-123",
    properties: {
      hs_lead_name: "  Jane Doe  ",
      hs_lead_label: "HOT",
      hs_lead_status: "NEW",
      createdate: "2026-10-13T10:00:00.000Z",
    },
  }, "Example Catering Ltd"), {
    id: "lead-123",
    name: "Jane Doe",
    label: "HOT",
    stage: "New",
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

test("shows only the requested New, Connected, and Attempted lead statuses", () => {
  const normalizeStatus = (status) =>
    normalizeHubSpotLead({ id: status, properties: { hs_lead_status: status } }).stage;

  const stageLabels = {
    new: "N",
    connected: "C",
    attempting: "Attempting",
    attempted: "A",
    qualified: "Q",
    disqualified: "D",
  };
  const normalizePipelineStage = (id) =>
    normalizeHubSpotLead({ id, properties: { hs_pipeline_stage: id } }, null, stageLabels).stage;

  assert.equal(normalizeStatus("CONNECTED"), "Connected");
  assert.equal(normalizeStatus("ATTEMPTING"), "Attempted");
  assert.equal(normalizeStatus("ATTEMPTED_TO_CONNECT"), "Attempted");
  assert.equal(normalizeStatus("QUALIFIED"), null);
  assert.equal(normalizeStatus("DISQUALIFIED"), null);
  assert.equal(normalizePipelineStage("new"), "New");
  assert.equal(normalizePipelineStage("connected"), "Connected");
  assert.equal(normalizePipelineStage("attempting"), "Attempted");
  assert.equal(normalizePipelineStage("attempted"), "Attempted");
  assert.equal(normalizePipelineStage("qualified"), null);
  assert.equal(normalizePipelineStage("disqualified"), null);
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

