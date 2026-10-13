export interface HubSpotLeadRaw {
  id: string;
  properties?: Record<string, string | null | undefined>;
}

export const CATERDIRECT_BUSINESS_UNIT_ID = "17577089";

export function isCaterDirectLead(raw: HubSpotLeadRaw): boolean {
  return (raw.properties?.hs_all_assigned_business_unit_ids ?? "")
    .split(";")
    .map((id) => id.trim())
    .includes(CATERDIRECT_BUSINESS_UNIT_ID);
}

export interface NormalizedHubSpotLead {
  id: string;
  name: string;
  label: string | null;
  stage: string | null;
  companyName: string | null;
  createdAt: string | null;
}

export function normalizeHubSpotLead(
  raw: HubSpotLeadRaw,
  companyName: string | null = null,
  stageLabels: Record<string, string> = {},
): NormalizedHubSpotLead {
  const properties = raw.properties ?? {};
  const stageId = properties.hs_pipeline_stage?.trim() || null;
  return {
    id: raw.id,
    name: properties.hs_lead_name?.trim() || "(Unnamed lead)",
    label: properties.hs_lead_label?.trim() || null,
    stage: stageId ? stageLabels[stageId] ?? stageId : null,
    companyName,
    createdAt: properties.createdate ?? null,
  };
}
