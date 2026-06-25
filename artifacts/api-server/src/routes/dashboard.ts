import { Router, type Request, type Response } from "express";
import { getShippingToday, getPriorityOvens, getTotalTestedOKThisMonth } from "../lib/graph";
import { getEngineerStats, type EngineerStat } from "../lib/powerbi";
import { logger } from "../lib/logger";

const router = Router();

interface CachedData {
  shippingToday: Awaited<ReturnType<typeof getShippingToday>>;
  priorityOvens: Awaited<ReturnType<typeof getPriorityOvens>>;
  engineerStats: EngineerStat[];
  totalOvensFixed: number;
  lastUpdated: string;
  engineerLastFetched: string;
}

let graphCache: {
  data: { shippingToday: CachedData["shippingToday"]; priorityOvens: CachedData["priorityOvens"] } | null;
  expiry: number;
} = { data: null, expiry: 0 };

let lastGoodData: CachedData | null = null;

const GRAPH_CACHE_TTL = 30 * 1000; // 30 seconds

router.get("/dashboard", async (req: Request, res: Response) => {
  try {
    const now = Date.now();

    // Graph: use cache if still fresh
    let shippingToday: CachedData["shippingToday"];
    let priorityOvens: CachedData["priorityOvens"];

    if (graphCache.data && now < graphCache.expiry) {
      shippingToday = graphCache.data.shippingToday;
      priorityOvens = graphCache.data.priorityOvens;
    } else {
      [shippingToday, priorityOvens] = await Promise.all([
        getShippingToday(),
        getPriorityOvens(),
      ]);
      graphCache = {
        data: { shippingToday, priorityOvens },
        expiry: now + GRAPH_CACHE_TTL,
      };
    }

    const [
      { stats: engineerStats, lastFetched: engineerLastFetched },
      totalOvensFixed,
    ] = await Promise.all([
      getEngineerStats(),
      getTotalTestedOKThisMonth(),
    ]);

    const result: CachedData = {
      shippingToday,
      priorityOvens,
      engineerStats,
      totalOvensFixed,
      lastUpdated: new Date().toISOString(),
      engineerLastFetched,
    };

    lastGoodData = result;
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Dashboard fetch failed");

    if (lastGoodData) {
      res.json(lastGoodData);
    } else {
      res.json({
        shippingToday: [],
        priorityOvens: [],
        engineerStats: [],
        totalOvensFixed: 0,
        lastUpdated: new Date().toISOString(),
        engineerLastFetched: new Date().toISOString(),
      });
    }
  }
});

export default router;
