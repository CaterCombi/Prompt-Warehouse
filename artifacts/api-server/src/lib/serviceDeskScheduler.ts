import { logger } from "./logger.js";
import { runServiceDeskSync } from "./serviceDeskIngestion.js";

/** Schedule one run at the next local 06:00; never starts when credentials are absent. */
export function scheduleServiceDeskSync(): void {
  const hubspotReady = Boolean(process.env.HUBSPOT_TOKEN);
  const ftpReady = Boolean(process.env.FTP_HOST && process.env.FTP_USER && process.env.FTP_PASSWORD);
  if (!hubspotReady && !ftpReady) {
    logger.info("Service Desk scheduler disabled because integration credentials are incomplete");
    return;
  }
  const now = new Date();
  const next = new Date(now);
  next.setHours(6, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    void runServiceDeskSync().catch(error => logger.error({ error }, "Scheduled Service Desk sync failed"));
    setInterval(() => void runServiceDeskSync().catch(error => logger.error({ error }, "Scheduled Service Desk sync failed")), 24 * 60 * 60 * 1000);
  }, next.getTime() - now.getTime()).unref();
}