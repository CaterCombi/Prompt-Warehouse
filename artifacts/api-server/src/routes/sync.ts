import { Router } from "express";
import { getAssets } from "../lib/sharepoint.js";
import { getSyncOverview, runSync } from "../lib/shopify.js";
import { requireAuth } from "../middlewares/requireAuth.js";

const router = Router();

router.get("/sync/overview", requireAuth, async (req, res) => {
  try {
    const assets = await getAssets();
    res.json(await getSyncOverview(assets));
  } catch (error) {
    req.log.error({ err: error }, "Failed to build AMT and Shopify comparison");
    res.status(502).json({
      error: error instanceof Error ? error.message : "Failed to compare AMT and Shopify",
    });
  }
});

router.post("/sync/run", requireAuth, async (req, res) => {
  try {
    const assets = await getAssets();
    res.json(await runSync(assets));
  } catch (error) {
    req.log.error({ err: error }, "Failed to sync AMT availability to Shopify");
    res.status(502).json({
      error: error instanceof Error ? error.message : "Failed to sync Shopify",
    });
  }
});

export default router;