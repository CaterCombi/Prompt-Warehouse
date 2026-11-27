import { logger } from "./logger.js";
import {
  SERVICE_DESK_REPORT_HOUR,
  SERVICE_DESK_REPORT_MINUTE,
  SERVICE_DESK_REPORT_TIME_ZONE,
} from "./serviceDeskMonthlyReportCore.js";
import { runMonthlyServiceDeskReportUploadIfDue } from "./serviceDeskMonthlyReportSharePoint.js";
import { getEnglandAndWalesBankHolidayDates } from "./serviceDeskScheduler.js";
import { startDailyPolling } from "./serviceDeskSchedulerCore.js";

const RETRY_INTERVAL_MS = 15 * 60 * 1000;
const MAX_SAME_DAY_RETRIES = 4;

export function scheduleMonthlyServiceDeskReportSharePointUpload(): void {
  if (process.env.NODE_ENV !== "production") {
    logger.info("Monthly Service Desk SharePoint upload is disabled outside production");
    return;
  }

  let inFlight = false;
  const runAttempt = async (attempt: number): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const bankHolidayDates = await getEnglandAndWalesBankHolidayDates();
      const result = await runMonthlyServiceDeskReportUploadIfDue(bankHolidayDates, new Date());
      if (result.status === "failed") {
        logger.error({
          reportMonth: result.reportMonth,
          filename: result.filename,
          stage: result.stage,
        }, "Monthly Service Desk report upload did not complete");
      } else if (result.status === "skipped") {
        if (attempt < MAX_SAME_DAY_RETRIES) {
          logger.info({
            reportMonth: result.reportMonth,
            filename: result.filename,
            sourceStatus: result.reason,
            nextRetryInMinutes: RETRY_INTERVAL_MS / 60_000,
            retryNumber: attempt + 1,
          }, "Monthly Service Desk report is waiting for a fresh Joblogic source");
          const timer = setTimeout(() => {
            void runAttempt(attempt + 1).catch((error) => logger.error({
              errorType: error instanceof Error ? error.name : "UnknownError",
            }, "Monthly Service Desk report retry failed"));
          }, RETRY_INTERVAL_MS);
          timer.unref?.();
        } else {
          logger.warn({
            reportMonth: result.reportMonth,
            filename: result.filename,
            sourceStatus: result.reason,
            retries: MAX_SAME_DAY_RETRIES,
          }, "Monthly Service Desk report was not uploaded because the Joblogic source is not fresh");
        }
      }
    } catch (error) {
      logger.error({
        errorType: error instanceof Error ? error.name : "UnknownError",
      }, "Monthly Service Desk report check failed");
    } finally {
      inFlight = false;
    }
  };
  const runIfDue = () => runAttempt(0);
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
    rule: "last working day of each month; England and Wales bank holidays excluded",
    retriesAfterFreshnessSkip: MAX_SAME_DAY_RETRIES,
    destination: "SharePoint",
  }, "Monthly Service Desk PDF upload scheduled");
}
