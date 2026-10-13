export interface HubSpotLeadRaw {
  id: string;
  properties?: Record<string, string | null | undefined>;
  associations?: {
    companies?: {
      results?: Array<{ id: string }>;
    };
  };
}

export interface NormalizedHubSpotLead {
  id: string;
  name: string;
  label: string | null;
  companyName: string | null;
  createdAt: string | null;
}

export function firstAssociatedCompanyId(raw: HubSpotLeadRaw): string | null {
  return raw.associations?.companies?.results?.[0]?.id ?? null;
}

export function normalizeHubSpotLead(raw: HubSpotLeadRaw, companyName: string | null = null): NormalizedHubSpotLead {
  const properties = raw.properties ?? {};
  return {
    id: raw.id,
    name: properties.hs_lead_name?.trim() || "(Unnamed lead)",
    label: properties.hs_lead_label?.trim() || null,
    companyName,
    createdAt: properties.createdate ?? null,
  };
}
