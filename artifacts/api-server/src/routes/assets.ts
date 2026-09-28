import { Router } from "express";
import { requireAuth } from "../middlewares/requireAuth.js";
import {
  getAssets,
  getAssetById,
  createAsset,
  updateAsset,
  getAssetStats,
} from "../lib/sharepoint.js";
import { buildLowStockProducts } from "../lib/shopify.js";

const router = Router();

router.get("/assets/stats", requireAuth, async (req, res) => {
  try {
    const stats = await getAssetStats();
    res.json(stats);
  } catch (err) {
    req.log.error({ err }, "Failed to get asset stats");
    res.status(500).json({ error: "Failed to fetch asset stats" });
  }
});

router.get("/assets/low-stock", requireAuth, async (req, res) => {
  try {
    const assets = await getAssets();
    res.json(buildLowStockProducts(assets));
  } catch (err) {
    req.log.error({ err }, "Failed to get low-stock products");
    res.status(500).json({ error: "Failed to check low-stock products" });
  }
});

router.get("/assets", requireAuth, async (req, res) => {
  try {
    const search = typeof req.query["search"] === "string" ? req.query["search"] : undefined;
    const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
    const assets = await getAssets(search, status);
    res.json(assets);
  } catch (err) {
    req.log.error({ err }, "Failed to get assets");
    res.status(500).json({ error: "Failed to fetch assets" });
  }
});

router.post("/assets", requireAuth, async (req, res) => {
  try {
    const { assetNumber, status, manufacturer, model, size, fuel, features, datePurchased, supplier, customer } = req.body as {
      assetNumber?: string;
      status?: string;
      manufacturer?: string;
      model?: string;
      size?: string;
      fuel?: string;
      features?: string;
      datePurchased?: string;
      supplier?: string;
      customer?: string;
    };

    if (!assetNumber || !status) {
      res.status(400).json({ error: "assetNumber and status are required" });
      return;
    }

    const asset = await createAsset({
      Title: assetNumber,
      Status: status,
      Manufacturer: manufacturer,
      "Manufacturer_x002e_": model,
      Size: size,
      Fuel: fuel,
      Features: features,
      DatePurchased: datePurchased,
      Supplier: supplier,
      Company: customer,
    });
    res.status(201).json(asset);
  } catch (err) {
    req.log.error({ err }, "Failed to create asset");
    res.status(500).json({ error: "Failed to create asset" });
  }
});

router.get("/assets/:id", requireAuth, async (req, res) => {
  try {
    const id = req.params["id"] as string;
    const asset = await getAssetById(id);
    res.json(asset);
  } catch (err) {
    req.log.error({ err }, "Failed to get asset");
    res.status(404).json({ error: "Asset not found" });
  }
});

router.patch("/assets/:id", requireAuth, async (req, res) => {
  try {
    const { assetNumber, status, manufacturer, model, size, fuel, features, datePurchased, supplier, customer } = req.body as {
      assetNumber?: string;
      status?: string;
      manufacturer?: string;
      model?: string;
      size?: string;
      fuel?: string;
      features?: string;
      datePurchased?: string;
      supplier?: string;
      customer?: string;
    };

    const id = req.params["id"] as string;
    const asset = await updateAsset(id, {
      ...(assetNumber !== undefined && { Title: assetNumber }),
      ...(status !== undefined && { Status: status }),
      ...(manufacturer !== undefined && { Manufacturer: manufacturer }),
      ...(model !== undefined && { "Manufacturer_x002e_": model }),
      ...(size !== undefined && { Size: size }),
      ...(fuel !== undefined && { Fuel: fuel }),
      ...(features !== undefined && { Features: features }),
      ...(datePurchased !== undefined && { DatePurchased: datePurchased }),
      ...(supplier !== undefined && { Supplier: supplier }),
      ...(customer !== undefined && { Company: customer }),
    });
    res.json(asset);
  } catch (err) {
    req.log.error({ err }, "Failed to update asset");
    res.status(500).json({ error: "Failed to update asset" });
  }
});

export default router;
