import { Router } from "express";
import { db } from "@workspace/db";
import { serviceDeskIngestionLog } from "@workspace/db/schema";
import { requireAuth } from "../middlewares/requireAuth.js";
import { runServiceDeskSync } from "../lib/serviceDeskIngestion.js";

const router = Router();
router.use(requireAuth);
const candidates = ["catercombi_asset_number", "asset_number", "caterdirect_asset_number__if_available_", "machine_details__model_number_"];
let syncInFlight = false;

router.get("/hubspot/properties", async (req, res) => {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) { res.json({ properties: [], candidates, error: "HUBSPOT_TOKEN environment variable is not set" }); return; }
  try {
    const response = await fetch("https://api.hubapi.com/crm/v3/properties/tickets", { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json() as { results?: unknown[]; message?: string };
    if (!response.ok) { res.json({ properties: [], candidates, error: `HubSpot API error ${response.status}: ${body.message ?? "request failed"}` }); return; }
    res.json({ properties: body.results ?? [], candidates, error: null });
  } catch (error) { req.log.error({ error }, "HubSpot property discovery failed"); res.json({ properties: [], candidates, error: "HubSpot property request failed" }); }
});

router.post("/sync", async (req, res) => {
  if (syncInFlight) { res.status(409).json({ success: false, message: "A Service Desk sync is already running" }); return; }
  syncInFlight = true;
  try {
    const result = await runServiceDeskSync();
    if (result.locked) { res.status(409).json({ success: false, message: "A Service Desk sync is already running" }); return; }
    const { hubspot, ftps } = result;
    const skipped = "skipped" in ftps;
    const success = !hubspot.error && !ftps.error && !skipped;
    const error = [hubspot.error, ftps.error, skipped ? "FTP feed not configured; engineer schedule was not refreshed" : null].filter(Boolean).join("; ");
    await db.insert(serviceDeskIngestionLog).values({ source: "sync", status: success ? "success" : "error", errorMessage: success ? null : error });
    res.status(success ? 200 : 503).json({ success, message: success ? "Sync complete" : error, hubspot: { success: !hubspot.error, count: hubspot.count, error: hubspot.error }, ftps: { success: !ftps.error && !skipped, skipped, count: ftps.filesProcessed, error: ftps.error } });
  } finally { syncInFlight = false; }
});

export default router;