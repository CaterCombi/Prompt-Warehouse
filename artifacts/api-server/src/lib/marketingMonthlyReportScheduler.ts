import { logger } from "./logger.js";
import {
  MARKETING_REPORT_HOUR,
  MARKETING_REPORT_MINUTE,
  MARKETING_REPORT_TIME_ZONE,
} from "./marketingMonthlyReportCore.js";
import { runMonthlyMarketingReportEmailIfDue } from "./marketingMonthlyReportEmails.js";
import { runMonthlyMarketingReportSharePointUploadIfDue } from "./marketingMonthlyReportSharePoint.js";
import { startDailyPolling } from "./serviceDeskSchedulerCore.js";

export function scheduleMarketingMonthlyReportEmails() {
  if (process.env.NODE_ENV !== "production") {
    logger.info("Monthly marketing report emails are disabled outside production");
    return;
  }

  const runIfDue = async () => {
    const [emailResult, sharePointResult] = await Promise.allSettled([
      runMonthlyMarketingReportEmailIfDue(),
      runMonthlyMarketingReportSharePointUploadIfDue(),
    ]);
    if (emailResult.status === "rejected") {
      logger.error({
        errorType: emailResult.reason instanceof Error ? emailResult.reason.name : "UnknownError",
      }, "Monthly Marketing email check failed");
    }
    if (sharePointResult.status === "rejected") {
      logger.error({
        errorType: sharePointResult.reason instanceof Error ? sharePointResult.reason.name : "UnknownError",
      }, "Monthly Marketing SharePoint check failed");
    }
  };
  void runIfDue().catch((error) => logger.error({ error }, "Startup monthly marketing report check failed"));
  startDailyPolling(
    runIfDue,
    MARKETING_REPORT_TIME_ZONE,
    MARKETING_REPORT_HOUR,
    MARKETING_REPORT_MINUTE,
    (error) => logger.error({ error }, "Scheduled monthly marketing report check failed"),
  );
  logger.info({
    hour: MARKETING_REPORT_HOUR,
    minute: MARKETING_REPORT_MINUTE,
    timeZone: MARKETING_REPORT_TIME_ZONE,
    dayOfMonth: 1,
  }, "Monthly marketing report email and SharePoint checks scheduled");
}
