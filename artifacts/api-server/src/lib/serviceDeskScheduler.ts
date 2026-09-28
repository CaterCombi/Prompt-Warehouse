import { logger } from "./logger.js";
import { runServiceDeskFtpSync, runServiceDeskHubSpotSync } from "./serviceDeskIngestion.js";
import { resolveFtpPollIntervalMs, startFtpPolling } from "./serviceDeskSchedulerCore.js";

/** Poll FTP frequently; keep HubSpot on its original daily 06:00 schedule. */
export function scheduleServiceDeskSync(): void {
  const hubspotReady = Boolean(process.env.HUBSPOT_TOKEN);
  const ftpReady = Boolean(process.env.FTP_HOST && process.env.FTP_USER && process.env.FTP_PASSWORD);
  if (!hubspotReady && !ftpReady) {
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
}