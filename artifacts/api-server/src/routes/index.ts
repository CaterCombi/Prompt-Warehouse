import { Router, type IRouter } from "express";
import healthRouter from "./health";
import upstreamHealthRouter from "./upstreamHealth";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(upstreamHealthRouter);
router.use(dashboardRouter);

export default router;
