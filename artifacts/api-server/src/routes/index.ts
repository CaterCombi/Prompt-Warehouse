import { Router, type IRouter } from "express";
import marketingRouter from "./marketing";
import healthRouter from "./health";
import authRouter from "./auth";
import assetsRouter from "./assets";
import syncRouter from "./sync";
import serviceDeskRouter from "./serviceDesk";
import serviceDeskIntegrationsRouter from "./serviceDeskIntegrations";
import salesRouter from "./sales";
import engineerReportsRouter from "./engineerReports";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(assetsRouter);
router.use(syncRouter);
router.use("/service-desk", serviceDeskRouter);
router.use("/service-desk", serviceDeskIntegrationsRouter);
router.use("/engineer-reports", engineerReportsRouter);
router.use("/sales", salesRouter);
router.use(marketingRouter);

export default router;
