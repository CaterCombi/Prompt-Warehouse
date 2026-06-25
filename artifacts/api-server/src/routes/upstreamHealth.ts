import { Router, type Request, type Response } from "express";
import { getGraphToken, getPowerBiToken, isAzureConfigured } from "../lib/auth";

const router = Router();

router.get("/health", async (req: Request, res: Response) => {
  if (!isAzureConfigured()) {
    res.json({
      graph: { ok: false, message: "Azure credentials not configured (TENANT_ID, CLIENT_ID, CLIENT_SECRET)" },
      powerBi: { ok: false, message: "Azure credentials not configured" },
    });
    return;
  }

  const [graphResult, powerBiResult] = await Promise.allSettled([
    getGraphToken(),
    getPowerBiToken(),
  ]);

  res.json({
    graph: {
      ok: graphResult.status === "fulfilled",
      message:
        graphResult.status === "fulfilled"
          ? "Graph token acquired successfully"
          : String((graphResult as PromiseRejectedResult).reason),
    },
    powerBi: {
      ok: powerBiResult.status === "fulfilled",
      message:
        powerBiResult.status === "fulfilled"
          ? "Power BI token acquired successfully"
          : String((powerBiResult as PromiseRejectedResult).reason),
    },
  });
});

export default router;
