import { logger } from "./logger.js";
import {
  MARKETING_REPORT_HOUR,
  MARKETING_REPORT_MINUTE,
  MARKETING_REPORT_TIME_ZONE,
} from "./marketingMonthlyReportCore.js";
import { runMonthlyMarketingReportSharePointUploadIfDue } from "./marketingMonthlyReportSharePoint.js";
import { startDailyPolling } from "./serviceDeskSchedulerCore.js";

export function scheduleMonthlyMarketingReportSharePointUpload() {
  if (process.env.NODE_ENV !== "production") {
    logger.info("Monthly Marketing SharePoint upload is disabled outside production");
    return;
  }

  const runIfDue = async () => {
    try {
      await runMonthlyMarketingReportSharePointUploadIfDue();
    } catch (error) {
      logger.error({
        errorType: error instanceof Error ? error.name : "UnknownError",
      }, "Monthly Marketing SharePoint check failed");
    }
  };
  void runIfDue().catch((error) => logger.error({
    errorType: error instanceof Error ? error.name : "UnknownError",
  }, "Startup monthly Marketing SharePoint check failed"));
  startDailyPolling(
    runIfDue,
    MARKETING_REPORT_TIME_ZONE,
    MARKETING_REPORT_HOUR,
    MARKETING_REPORT_MINUTE,
    (error) => logger.error({
      errorType: error instanceof Error ? error.name : "UnknownError",
    }, "Scheduled monthly Marketing SharePoint check failed"),
  );
  logger.info({
    hour: MARKETING_REPORT_HOUR,
    minute: MARKETING_REPORT_MINUTE,
    timeZone: MARKETING_REPORT_TIME_ZONE,
    dayOfMonth: 1,
  }, "Monthly Marketing SharePoint upload scheduled");
}
