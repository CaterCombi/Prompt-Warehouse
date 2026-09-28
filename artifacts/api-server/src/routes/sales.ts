import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { fetchDealsFromHubSpot, patchDealOnHubSpot, type NormalizedDeal } from "../lib/hubspot";
import { getCache, setCache, getHiddenDealIds, getHiddenDeals, hideDeal, unhideDeal, getOrder, saveOrder } from "../lib/sales-store";
import { getAssets } from "../lib/sharepoint";

const router: IRouter = Router();
router.use(requireAuth);
function updateBody(input: unknown): { success: true; data: { asset?: string | null; saleRental?: "sale" | "rental" | null; invoiceNumber?: string | null; closingDate?: string | null } } | { success: false; error: { message: string } } {
  if (!input || typeof input !== "object") return { success: false, error: { message: "Body must be an object" } };
  const value = input as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const key of ["asset", "saleRental", "invoiceNumber", "closingDate"]) if (key in value) {
    if (value[key] !== null && typeof value[key] !== "string") return { success: false, error: { message: `${key} must be a string or null` } };
    if (key === "saleRental" && value[key] !== null && value[key] !== "sale" && value[key] !== "rental") return { success: false, error: { message: "saleRental must be sale or rental" } };
    out[key] = value[key];
  }
  if (Object.keys(value).some((key) => !["asset", "saleRental", "invoiceNumber", "closingDate"].includes(key))) return { success: false, error: { message: "Unknown field in body" } };
  return { success: true, data: out as { asset?: string | null; saleRental?: "sale" | "rental" | null; invoiceNumber?: string | null; closingDate?: string | null } };
}
function orderBody(input: unknown): { success: true; data: { salesQuotes: string[]; salesInvoice: string[]; salesDeposit: string[]; rentalDeals: string[] } } | { success: false; error: { message: string } } {
  if (!input || typeof input !== "object") return { success: false, error: { message: "Body must be an object" } };
  const value = input as Record<string, unknown>, keys = ["salesQuotes", "salesInvoice", "salesDeposit", "rentalDeals"];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Array.isArray(value[key]) || (value[key] as unknown[]).some((x) => typeof x !== "string"))) return { success: false, error: { message: "Order must contain four string arrays" } };
  return { success: true, data: value as { salesQuotes: string[]; salesInvoice: string[]; salesDeposit: string[]; rentalDeals: string[] } };
}
function response(deals: NormalizedDeal[], hidden: Set<string>, lastUpdated: string | null) {
  const visible = deals.filter((d) => !hidden.has(d.id));
  const quotes = visible.filter((d) => d.stage === "quotes"), invoiceSent = visible.filter((d) => d.stage === "invoice_sent"), depositPaid = visible.filter((d) => d.stage === "deposit_paid");
  return { quotes, invoiceSent, depositPaid, lastUpdated, quotesCount: quotes.length, invoiceSentCount: invoiceSent.length, depositPaidCount: depositPaid.length };
}
async function freshDeals(force = false) {
  const cached = await getCache();
  if (!force && cached && Date.now() - Date.parse(cached.cachedAt) < 5 * 60_000) return cached;
  const deals = await fetchDealsFromHubSpot();
  await setCache(deals);
  return { deals, cachedAt: new Date().toISOString() };
}
router.get("/deals", async (req, res): Promise<void> => {
  try { const data = await freshDeals(); res.json(response(data.deals, await getHiddenDealIds(), data.cachedAt)); }
  catch (err) { req.log.error({ err: String(err).slice(0, 200) }, "Sales deals fetch failed"); const cached = await getCache(); if (cached) { res.json(response(cached.deals, await getHiddenDealIds(), cached.cachedAt)); return; } res.status(502).json({ error: "HubSpot is unavailable and no cached data exists" }); }
});
router.post("/deals/refresh", async (req, res): Promise<void> => {
  try { const data = await freshDeals(true); res.json(response(data.deals, await getHiddenDealIds(), data.cachedAt)); }
  catch (err) { req.log.error({ err: String(err).slice(0, 200) }, "Sales refresh failed"); res.status(502).json({ error: "HubSpot refresh failed; no changes were saved" }); }
});
router.patch("/deals/:dealId", async (req, res): Promise<void> => {
  const body = updateBody(req.body), dealId = Array.isArray(req.params.dealId) ? req.params.dealId[0] : req.params.dealId;
  if (!body.success || !dealId) { res.status(400).json({ error: body.success ? "Invalid deal ID" : body.error.message }); return; }
  try { const updated = await patchDealOnHubSpot(dealId, body.data); const cached = await getCache(); if (cached) await setCache(cached.deals.map((d) => d.id === updated.id ? updated : d)); res.json(updated); }
  catch (err) { req.log.error({ dealId, err: String(err).slice(0, 200) }, "Sales deal update failed"); res.status(502).json({ error: "Failed to save changes to HubSpot" }); }
});
router.get("/hidden", async (_req, res): Promise<void> => { res.json(await getHiddenDeals()); });
router.post("/deals/:dealId/hide", async (req, res): Promise<void> => { const id = Array.isArray(req.params.dealId) ? req.params.dealId[0] : req.params.dealId; const cached = await getCache(); await hideDeal(id, cached?.deals.find((d) => d.id === id)?.name ?? "(Unknown deal)"); res.sendStatus(204); });
router.delete("/deals/:dealId/hide", async (req, res): Promise<void> => { const id = Array.isArray(req.params.dealId) ? req.params.dealId[0] : req.params.dealId; await unhideDeal(id); res.sendStatus(204); });
router.get("/order", async (_req, res): Promise<void> => { res.json(await getOrder()); });
router.put("/order", async (req, res): Promise<void> => { const parsed = orderBody(req.body); if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; } await saveOrder(parsed.data); res.sendStatus(204); });
router.get("/summary", async (req, res): Promise<void> => {
  try {
    const assets = await getAssets();
    const available = new Set(["available", "refurbishment", "cleaning", "on the bay", "priority assets", "reserved"]);
    const now = Date.now(), year = 365 * 24 * 60 * 60 * 1000;
    const relevantAssets = assets.filter((asset) => asset.manufacturer.trim().toLowerCase() !== "catercombi accessory");
    const totalSales = relevantAssets.filter((asset) => {
      if (asset.status.trim().toLowerCase() !== "sold" || !asset.dateSold) return false;
      const soldAt = Date.parse(asset.dateSold);
      return Number.isFinite(soldAt) && soldAt >= now - year && soldAt <= now;
    }).length;
    res.json({
      activeRentals: relevantAssets.filter((asset) => asset.status.trim().toLowerCase() === "on hire").length,
      totalSales,
      availableAssets: relevantAssets.filter((asset) => available.has(asset.status.trim().toLowerCase())).length,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) { req.log.error({ err: String(err).slice(0, 200) }, "Sales summary fetch failed"); res.status(502).json({ error: "Failed to fetch sales summary" }); }
});
export default router;