import { logger } from "./logger.js";
import {
  SERVICE_DESK_REPORT_HOUR,
  SERVICE_DESK_REPORT_MINUTE,
  SERVICE_DESK_REPORT_TIME_ZONE,
} from "./serviceDeskMonthlyReportCore.js";
import { runMonthlyServiceDeskReportUploadIfDue } from "./serviceDeskMonthlyReportSharePoint.js";
import { startDailyPolling } from "./serviceDeskSchedulerCore.js";

export function scheduleMonthlyServiceDeskReportSharePointUpload(): void {
  if (process.env.NODE_ENV !== "production") {
    logger.info("Monthly Service Desk SharePoint upload is disabled outside production");
    return;
  }

  const runIfDue = async () => {
    const result = await runMonthlyServiceDeskReportUploadIfDue();
    if (result.status === "failed") {
      logger.error({
        reportMonth: result.reportMonth,
        filename: result.filename,
        stage: result.stage,
      }, "Monthly Service Desk report upload did not complete");
    }
  };
  void runIfDue().catch((error) => logger.error({
    errorType: error instanceof Error ? error.name : "UnknownError",
  }, "Startup monthly Service Desk report check failed"));
  startDailyPolling(
    runIfDue,
    SERVICE_DESK_REPORT_TIME_ZONE,
    SERVICE_DESK_REPORT_HOUR,
    SERVICE_DESK_REPORT_MINUTE,
    (error) => logger.error({
      errorType: error instanceof Error ? error.name : "UnknownError",
    }, "Scheduled monthly Service Desk report check failed"),
  );
  logger.info({
    hour: SERVICE_DESK_REPORT_HOUR,
    minute: SERVICE_DESK_REPORT_MINUTE,
    timeZone: SERVICE_DESK_REPORT_TIME_ZONE,
    dayOfMonth: 1,
    destination: "SharePoint",
  }, "Monthly Service Desk PDF upload scheduled");
}
