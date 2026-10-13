export interface HubSpotLeadRaw {
  id: string;
  properties?: Record<string, string | null | undefined>;
}

export interface NormalizedHubSpotLead {
  id: string;
  name: string;
  label: string | null;
  type: string | null;
  createdAt: string | null;
}

export function normalizeHubSpotLead(raw: HubSpotLeadRaw): NormalizedHubSpotLead {
  const properties = raw.properties ?? {};
  return {
    id: raw.id,
    name: properties.hs_lead_name?.trim() || "(Unnamed lead)",
    label: properties.hs_lead_label?.trim() || null,
    type: properties.hs_lead_type?.trim() || null,
    createdAt: properties.createdate ?? null,
  };
}
