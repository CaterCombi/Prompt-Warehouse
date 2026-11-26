import { logger } from "./logger.js";
import { runServiceDeskFtpSync, runServiceDeskHubSpotSync } from "./serviceDeskIngestion.js";
import {
  JoblogicAllJobsUploadError,
  uploadNewestAllJobsReport,
} from "./joblogicAllJobsReport.js";
import {
  isLastWorkingDayOfLondonMonth,
  isLondonAtOrAfterTime,
  parseEnglandAndWalesBankHolidayDates,
} from "./joblogicAllJobsReportCore.js";
import {
  resolveFtpPollIntervalMs,
  startDailyPolling,
  startFtpPolling,
} from "./serviceDeskSchedulerCore.js";

const JOBLOGIC_REPORT_TIME_ZONE = "Europe/London";
const JOBLOGIC_REPORT_HOUR = 16;
const JOBLOGIC_REPORT_MINUTE = 0;
const UK_BANK_HOLIDAY_URL = "https://www.gov.uk/bank-holidays.json";
const BANK_HOLIDAY_CACHE_MS = 12 * 60 * 60 * 1000;
let cachedBankHolidayDates: { fetchedAt: number; dates: Set<string> } | null = null;

async function getEnglandAndWalesBankHolidayDates(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedBankHolidayDates && now - cachedBankHolidayDates.fetchedAt < BANK_HOLIDAY_CACHE_MS) {
    return cachedBankHolidayDates.dates;
  }

  const response = await fetch(UK_BANK_HOLIDAY_URL);
  if (!response.ok) {
    throw new Error(`GOV.UK bank holiday calendar returned HTTP ${response.status}`);
  }
  const dates = parseEnglandAndWalesBankHolidayDates(await response.json());
  cachedBankHolidayDates = { fetchedAt: now, dates };
  return dates;
}

async function runMonthlyAllJobsReportIfDue() {
  const now = new Date();
  if (!isLondonAtOrAfterTime(now, JOBLOGIC_REPORT_HOUR, JOBLOGIC_REPORT_MINUTE)) {
    return { status: "not_due" as const };
  }

  const bankHolidayDates = await getEnglandAndWalesBankHolidayDates();
  if (!isLastWorkingDayOfLondonMonth(now, bankHolidayDates)) {
    return { status: "not_due" as const };
  }

  return uploadNewestAllJobsReport();
}

/** Poll FTP frequently; keep HubSpot on its original daily 06:00 schedule. */
export function scheduleServiceDeskSync(): void {
  const hubspotReady = Boolean(process.env.HUBSPOT_TOKEN);
  const ftpReady = Boolean(process.env.FTP_HOST && process.env.FTP_USER && process.env.FTP_PASSWORD);
  const monthlyAllJobsReportReady = Boolean(
    process.env.FTP_HOST
    && process.env.FTP_USER
    && process.env.FTP_PASSWORD
    && process.env.AZURE_TENANT_ID
    && process.env.AZURE_CLIENT_ID
    && process.env.AZURE_CLIENT_SECRET,
  );
  if (!hubspotReady && !ftpReady && !monthlyAllJobsReportReady) {
    logger.info("Service Desk scheduler disabled because integration credentials are incomplete");
    return;
  }

  if (ftpReady) {
    try {
      const intervalMs = resolveFtpPollIntervalMs(process.env.SERVICE_DESK_FTP_POLL_INTERVAL_MINUTES);
      logger.info({ intervalMinutes: intervalMs / 60_000 }, "Service Desk FTP polling enabled");
      startFtpPolling(
        runServiceDeskFtpSync,
        intervalMs,
        error => logger.error({ error }, "Scheduled Service Desk FTP poll failed"),
      );
    } catch (error) {
      logger.error({ error }, "Service Desk FTP polling disabled because its interval configuration is invalid");
    }
  }

  if (hubspotReady) {
    let hubspotRetryScheduled = false;
    const runHubSpotSync = () => {
      if (hubspotRetryScheduled) return;
      void runServiceDeskHubSpotSync().then(result => {
        if (result.locked) {
          logger.warn("Scheduled HubSpot sync delayed because another Service Desk sync is in progress");
          hubspotRetryScheduled = true;
          setTimeout(() => {
            hubspotRetryScheduled = false;
            runHubSpotSync();
          }, 60_000).unref();
        }
      }).catch(error => logger.error({ error }, "Scheduled Service Desk HubSpot sync failed"));
    };
    const now = new Date();
    const next = new Date(now);
    next.setHours(6, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => {
      runHubSpotSync();
      setInterval(runHubSpotSync, 24 * 60 * 60 * 1000).unref();
    }, next.getTime() - now.getTime()).unref();
  }

  const isRailwayProduction = process.env.RAILWAY_ENVIRONMENT_NAME === "production";
  if (monthlyAllJobsReportReady && isRailwayProduction) {
    let inFlight = false;
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await runMonthlyAllJobsReportIfDue();
        if (result.status === "not_due") return;
        if (result.status === "no_report") {
          logger.error(
            { stage: "ftp_list" },
            "Monthly Joblogic All Jobs upload failed: no All Jobs_*.csv file was found in the FTP login folder",
          );
          return;
        }
        if (result.status === "already_uploaded") {
          const fields = {
            filename: result.filename,
            sourceModifiedAt: result.sourceModifiedAt,
            sourceSizeBytes: result.sourceSizeBytes,
            sharePointSizeBytes: result.sharePointSizeBytes,
            sizeMatches: result.sizeMatches,
          };
          if (result.sizeMatches) {
            logger.info(
              fields,
              "Monthly Joblogic All Jobs report already exists in SharePoint; it was not replaced",
            );
          } else {
            logger.warn(
              fields,
              "A same-name Joblogic All Jobs file exists in SharePoint with a different size; it was not replaced",
            );
          }
          return;
        }
        logger.info({
          filename: result.filename,
          sourceModifiedAt: result.sourceModifiedAt,
          sourceSizeBytes: result.sourceSizeBytes,
          sharePointSizeBytes: result.sharePointSizeBytes,
        }, "Monthly Joblogic All Jobs report uploaded and verified in SharePoint");
      } catch (error) {
        if (error instanceof JoblogicAllJobsUploadError) {
          logger.error({
            stage: error.stage,
            httpStatus: error.httpStatus,
            error: error.message,
          }, "Monthly Joblogic All Jobs report transfer failed");
        } else {
          logger.error({
            error: error instanceof Error ? error.message : "Unknown scheduled transfer error",
          }, "Monthly Joblogic All Jobs schedule check failed");
        }
      } finally {
        inFlight = false;
      }
    };

    void run();
    startDailyPolling(
      run,
      JOBLOGIC_REPORT_TIME_ZONE,
      JOBLOGIC_REPORT_HOUR,
      JOBLOGIC_REPORT_MINUTE,
      error => logger.error(
        { error: error instanceof Error ? error.message : "Unknown scheduled transfer error" },
        "Monthly Joblogic All Jobs schedule timer failed",
      ),
    );
    logger.info({
      hour: JOBLOGIC_REPORT_HOUR,
      minute: JOBLOGIC_REPORT_MINUTE,
      timeZone: JOBLOGIC_REPORT_TIME_ZONE,
      rule: "last working day of each month; England and Wales bank holidays excluded",
    }, "Monthly Joblogic All Jobs report upload scheduled");
  } else if (monthlyAllJobsReportReady) {
    logger.info("Monthly Joblogic All Jobs report upload is disabled outside Railway production");
  } else if (isRailwayProduction) {
    logger.error(
      "Monthly Joblogic All Jobs report upload is disabled because FTP or SharePoint credentials are not configured",
    );
  }
}