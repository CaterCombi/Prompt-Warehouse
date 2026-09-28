import { logger } from "./logger";

export const RENTAL_PIPELINE_ID = "338850771";
export const SALE_PIPELINE_ID = "default";
export const RENTAL_QUOTES_STAGE_ID = "535130848";
export const RENTAL_INVOICE_SENT_STAGE_ID = "4416731336";
export const SALES_QUOTES_STAGE_ID = "decisionmakerboughtin";
export const SALES_INVOICE_SENT_STAGE_ID = "contractsent";
export const SALES_DEPOSIT_PAID_STAGE_ID = "535130846";
export const ASSET_PROPERTY = "asset";
export const ASSET_DESCRIPTION_PROPERTY = "asset_description";
export const INVOICE_NUMBER_PROPERTY = "rental_invoice";

export interface HubSpotDeal { id: string; properties: Record<string, string | null | undefined>; }
export interface NormalizedDeal {
  id: string; name: string; stage: "quotes" | "invoice_sent" | "deposit_paid";
  customerName: string | null; companyName: string | null; asset: string | null;
  assetDescription: string | null; priority: "low" | "medium" | "high" | null;
  dealScore: number | null; saleRental: "sale" | "rental" | null;
  invoiceNumber: string | null; createdAt: string | null; closingDate: string | null;
}

const stageMap: Record<string, NormalizedDeal["stage"]> = {
  [RENTAL_QUOTES_STAGE_ID]: "quotes", [SALES_QUOTES_STAGE_ID]: "quotes",
  [RENTAL_INVOICE_SENT_STAGE_ID]: "invoice_sent", [SALES_INVOICE_SENT_STAGE_ID]: "invoice_sent",
  [SALES_DEPOSIT_PAID_STAGE_ID]: "deposit_paid",
};
function token(): string {
  const value = process.env.HUBSPOT_TOKEN ?? process.env.HUBSPOT_ACCESS_TOKEN;
  if (!value) throw new Error("HUBSPOT_TOKEN environment variable is not set");
  return value;
}
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.hubapi.com${path}`, {
    method, headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    // Do not include upstream bodies, which can contain customer data.
    logger.warn({ upstream: "hubspot", method, path, status: response.status }, "HubSpot request failed");
    throw new Error(`HubSpot ${method} ${path} returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}
function props(raw: HubSpotDeal) { return raw.properties ?? {}; }
function associations(tokenValue: string, ids: string[]) {
  const inputs = ids.map((id) => ({ id }));
  return Promise.all([
    request<{ results: Array<{ from: { id: string }; to: Array<{ id: string }> }> }>("POST", "/crm/v3/associations/deals/contacts/batch/read", { inputs }).catch(() => ({ results: [] })),
    request<{ results: Array<{ from: { id: string }; to: Array<{ id: string }> }> }>("POST", "/crm/v3/associations/deals/companies/batch/read", { inputs }).catch(() => ({ results: [] })),
  ]).then(async ([ca, co]) => {
    const contactIds = ca.results.flatMap((x) => x.to[0]?.id ?? []);
    const companyIds = co.results.flatMap((x) => x.to[0]?.id ?? []);
    const [contacts, companies] = await Promise.all([
      contactIds.length ? request<{ results: Array<{ id: string; properties: Record<string, string | null> }> }>("POST", "/crm/v3/objects/contacts/batch/read", { inputs: contactIds.map((id) => ({ id })), properties: ["firstname", "lastname"] }).catch(() => ({ results: [] })) : { results: [] },
      companyIds.length ? request<{ results: Array<{ id: string; properties: Record<string, string | null> }> }>("POST", "/crm/v3/objects/companies/batch/read", { inputs: companyIds.map((id) => ({ id })), properties: ["name"] }).catch(() => ({ results: [] })) : { results: [] },
    ]);
    const cn = new Map<string, string>(contacts.results.map((x) => [x.id, [x.properties.firstname, x.properties.lastname].filter(Boolean).join(" ")] as [string, string]));
    const con = new Map<string, string>(companies.results.map((x) => [x.id, x.properties.name ?? ""] as [string, string]));
    const contactNames = new Map<string, string>(), companyNames = new Map<string, string>();
    (ca.results as Array<{ from: { id: string }; to: Array<{ id: string }> }>).forEach((x) => { const n = cn.get(x.to[0]?.id ?? ""); if (n) contactNames.set(x.from.id, n); });
    (co.results as Array<{ from: { id: string }; to: Array<{ id: string }> }>).forEach((x) => { const n = con.get(x.to[0]?.id ?? ""); if (n) companyNames.set(x.from.id, n); });
    return { contactNames, companyNames };
  });
}
export function normalizeDeal(raw: HubSpotDeal, customerName: string | null = null, companyName: string | null = null): NormalizedDeal | null {
  const p = props(raw), stage = stageMap[String(p.dealstage ?? "")];
  if (!stage) return null;
  const score = Number.parseFloat(String(p.hs_deal_score ?? ""));
  return { id: raw.id, name: p.dealname ?? "(Unnamed deal)", stage, customerName, companyName,
    asset: p[ASSET_PROPERTY] ?? null, assetDescription: p[ASSET_DESCRIPTION_PROPERTY] ?? null,
    priority: p.hs_priority === "low" || p.hs_priority === "medium" || p.hs_priority === "high" ? p.hs_priority : null,
    dealScore: Number.isFinite(score) ? score : null,
    saleRental: p.pipeline === RENTAL_PIPELINE_ID ? "rental" : p.pipeline ? "sale" : null,
    invoiceNumber: p[INVOICE_NUMBER_PROPERTY] ?? null, createdAt: p.createdate ?? null, closingDate: p.closedate ?? null };
}
const properties = ["dealname", "dealstage", "pipeline", "hs_object_id", ASSET_PROPERTY, ASSET_DESCRIPTION_PROPERTY, INVOICE_NUMBER_PROPERTY, "hs_priority", "hs_deal_score", "createdate", "closedate"];
export async function fetchDealsFromHubSpot(): Promise<NormalizedDeal[]> {
  const all: HubSpotDeal[] = []; let after: string | undefined;
  do {
    const body = { filterGroups: [{ filters: [{ propertyName: "dealstage", operator: "IN", values: Object.keys(stageMap) }] }], properties, limit: 200, ...(after ? { after } : {}) };
    const page = await request<{ results: HubSpotDeal[]; paging?: { next?: { after?: string } } }>("POST", "/crm/v3/objects/deals/search", body);
    all.push(...(page.results ?? [])); after = page.paging?.next?.after;
  } while (after);
  const names = await associations(token(), all.map((x) => x.id));
  return all.map((x) => normalizeDeal(x, names.contactNames.get(x.id) ?? null, names.companyNames.get(x.id) ?? null)).filter((x): x is NormalizedDeal => x !== null);
}
export async function patchDealOnHubSpot(dealId: string, fields: { asset?: string | null; saleRental?: "sale" | "rental" | null; invoiceNumber?: string | null; closingDate?: string | null }): Promise<NormalizedDeal> {
  const patch: Record<string, string | null> = {};
  if (fields.asset !== undefined) patch[ASSET_PROPERTY] = fields.asset;
  if (fields.invoiceNumber !== undefined) patch[INVOICE_NUMBER_PROPERTY] = fields.invoiceNumber;
  if (fields.saleRental !== undefined) patch.pipeline = fields.saleRental === "rental" ? RENTAL_PIPELINE_ID : SALE_PIPELINE_ID;
  if (fields.closingDate !== undefined) patch.closedate = fields.closingDate ? String(new Date(fields.closingDate).getTime()) : null;
  const raw = await request<HubSpotDeal>("PATCH", `/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties: patch });
  const full = await request<HubSpotDeal>("GET", `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${properties.join(",")}`).catch(() => raw);
  const names = await associations(token(), [dealId]);
  const deal = normalizeDeal(full, names.contactNames.get(dealId) ?? null, names.companyNames.get(dealId) ?? null);
  if (!deal) throw new Error("Updated deal is not in a supported stage");
  return deal;
}