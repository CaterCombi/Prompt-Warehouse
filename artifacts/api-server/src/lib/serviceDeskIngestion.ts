import { Client } from "basic-ftp";
import { parse } from "csv-parse/sync";
import { Writable } from "node:stream";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { serviceDeskAssets, serviceDeskIngestionLog, serviceDeskJobs, serviceDeskProcessedFiles, serviceDeskTickets } from "@workspace/db/schema";
import { logger } from "./logger.js";
import { createNonOverlappingRunner } from "./serviceDeskSchedulerCore.js";

export const ASSET_PROPERTY_CANDIDATES = ["catercombi_asset_number", "asset_number", "caterdirect_asset_number__if_available_", "machine_details__model_number_"];
const runWithIngestionLock = createNonOverlappingRunner();

function ftpCredentialsReady(): boolean {
  return Boolean(process.env.FTP_HOST && process.env.FTP_USER && process.env.FTP_PASSWORD);
}

export async function runServiceDeskSync() {
  const result = await runWithIngestionLock(async () => {
    const [hubspot, ftps] = await Promise.all([
      ingestHubSpot(),
      ftpCredentialsReady()
        ? ingestFtps()
        : Promise.resolve({ filesFound: 0, filesProcessed: 0, error: null, skipped: true }),
    ]);
    return { hubspot, ftps };
  });
  return result.locked ? result : { locked: false as const, ...result.value };
}

export async function runServiceDeskFtpSync() {
  const result = await runWithIngestionLock(async () => {
    if (!ftpCredentialsReady()) {
      return { filesFound: 0, filesProcessed: 0, error: "FTP credentials are not configured", skipped: true as const };
    }
    return ingestFtps();
  });
  return result.locked ? result : { locked: false as const, ftps: result.value };
}

export async function runServiceDeskHubSpotSync() {
  const result = await runWithIngestionLock(() => ingestHubSpot());
  return result.locked ? result : { locked: false as const, hubspot: result.value };
}
const val = (r: Record<string, string>, keys: string[]) => { for (const k of keys) if (r[k]?.trim()) return r[k].trim(); return null; };
export const date = (s: string | null) => { if (!s) return null; const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/); const d = m ? new Date(`${m[3]!.length === 2 ? "20" : ""}${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}T${(m[4] ?? "00").padStart(2, "0")}:${m[5] ?? "00"}:00Z`) : new Date(s); return Number.isNaN(d.getTime()) ? null : d; };
export const completedJobIdentity = (ref: string, completed: Date) =>
  `joblogic:completed:${ref.trim().toLowerCase()}:${completed.toISOString()}`;
const rows = (content: Buffer) => parse(content, { columns: (h: string[]) => h.map(x => x.toLowerCase().replace(/[\s-]+/g, "_").trim()), skip_empty_lines: true, relax_column_count: true, trim: true, bom: true }) as Record<string, string>[];
const kind = (r: Record<string, string>) => { const h = Object.keys(r); if (h.includes("asset_autoinc") && h.includes("site_id") && h.includes("service_type")) return "rental_assets"; if (h.some(x => x.includes("visit_startdate") || x.includes("appointment_date"))) return "outstanding"; if (h.some(x => x.includes("job_type") || x.includes("completion"))) return "jobs"; if (h.includes("asset_id") && h.some(x => x.includes("postcode"))) return "asset_addresses"; if (h.some(x => ["asset_id", "asset_ref", "asset_reference"].includes(x))) return "assets"; return "unknown"; };
const jobRefKey = (ref: string) => ref.trim().toLowerCase().replace(/\s+/g, " ");
export function buildJobTypeLookup(content: Buffer): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const record of rows(content)) {
    const ref = val(record, ["job_number", "job_ref", "job_id", "reference", "id"]);
    const jobType = val(record, ["job_type"]);
    if (ref && jobType) lookup.set(jobRefKey(ref), jobType);
  }
  return lookup;
}

// JobLogic visit times are wall-clock times at UK sites, not UTC timestamps.
function ukVisitDate(value: string | null): Date | null {
  if (!value) return null;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!match) return null;
  const [, day, month, year, hour = "00", minute = "00"] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const check = new Date(utc);
  if (check.getUTCFullYear() !== Number(year) || check.getUTCMonth() !== Number(month) - 1 ||
      check.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59) return null;
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" });
  const offset = formatter.formatToParts(check).find(part => part.type === "timeZoneName")?.value === "GMT+1" ? 1 : 0;
  return new Date(utc - offset * 3600000);
}

export async function importOutstandingCsv(
  content: Buffer,
  filename: string,
  jobTypesByRef: ReadonlyMap<string, string> = new Map(),
  source: "csv_upload" | "ftps" = "csv_upload",
): Promise<number> {
  try {
  const input = rows(content);
  const headers = Object.keys(input[0] ?? {}).length
    ? Object.keys(input[0]!)
    : ((parse(content, { to_line: 1, bom: true, trim: true }) as string[][])[0] ?? [])
      .map(header => header.toLowerCase().replace(/[\s-]+/g, "_").trim());
  if (!headers.some(h => ["appointment_date", "visit_startdate", "appointment", "planned_date"].includes(h)) ||
      !headers.some(h => ["id", "job_number", "job_ref", "job_id", "reference"].includes(h))) {
    throw new Error("The schedule CSV needs a job ID and appointment or visit start date.");
  }
  const scheduledJobs = input.flatMap(r => {
    const ref = val(r, ["id", "job_number", "job_ref", "job_id", "reference"]);
    const scheduled = ukVisitDate(val(r, ["visit_startdate", "appointment_date", "appointment", "planned_date"]));
    const completed = date(val(r, ["completeddate", "completion_date", "completed_date", "date_completed"]));
    const visitStatus = val(r, ["visit_status"])?.toLowerCase();
    const jobStatus = val(r, ["job_status", "status"])?.toLowerCase();
    if (!ref || !scheduled || completed ||
        ["completed", "cancelled", "canceled"].includes(jobStatus ?? "") ||
        ["complete", "completed", "cancelled", "canceled", "aborted"].includes(visitStatus ?? "")) return [];
    const asset = val(r, ["job_reference", "asset_ref", "asset_number"]) ??
      (val(r, ["job_description", "description"])?.match(/^(\d+)\s*[-–]/)?.[1] ?? null);
    return [{
      externalId: `joblogic:scheduled:${ref.trim().toLowerCase()}:${scheduled.toISOString()}`,
      jobRef: ref, jobType: val(r, ["job_type"]) ?? jobTypesByRef.get(jobRefKey(ref)) ?? null,
      assetRef: asset, site: val(r, ["job_site", "site", "customer"]),
      engineer: val(r, ["engineer", "first_engineer", "last_engineer"]),
      status: val(r, ["job_status", "status"]), scheduledAt: scheduled,
      completedAt: null, sourceFile: filename,
    }];
  });
  if (!scheduledJobs.length) throw new Error("The schedule CSV has no active visits with valid dates; existing bookings were kept.");
  return await db.transaction(async tx => {
    await tx.delete(serviceDeskJobs).where(and(isNotNull(serviceDeskJobs.scheduledAt), isNull(serviceDeskJobs.completedAt)));
    for (const job of scheduledJobs) {
      await tx.insert(serviceDeskJobs).values(job).onConflictDoUpdate({
        target: serviceDeskJobs.externalId,
        set: { jobType: job.jobType, assetRef: job.assetRef, site: job.site, engineer: job.engineer,
          status: job.status, scheduledAt: job.scheduledAt, sourceFile: filename, ingestedAt: new Date() },
      });
    }
    await tx.insert(serviceDeskIngestionLog).values({
      source,
      status: "success",
      filesFound: 1,
      filesProcessed: 1,
      ticketsImported: scheduledJobs.length,
      metadata: { kind: "outstanding", filename, rowsImported: scheduledJobs.length },
    });
    return scheduledJobs.length;
  });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.insert(serviceDeskIngestionLog).values({
      source,
      status: content.length === 0 || /has no active visits/i.test(message) ? "empty" : "error",
      filesFound: 1,
      filesProcessed: 0,
      ticketsImported: 0,
      errorMessage: message,
      metadata: { kind: "outstanding", filename, rowsImported: 0 },
    });
    throw error;
  }
}

export async function ingestHubSpot() {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return { count: 0, error: "HUBSPOT_TOKEN environment variable is not set", matchedAssetProperties: {} as Record<string, number> };
  let after: string | undefined; let count = 0; const matched: Record<string, number> = {};
  try {
    const since = new Date(); since.setMonth(since.getMonth() - 3);
    do {
      const body: Record<string, unknown> = { limit: 100, after, properties: ["subject", "createdate", "closed_date", "hs_pipeline", "hs_pipeline_stage", "source_type", ...ASSET_PROPERTY_CANDIDATES], filterGroups: [{ filters: [{ propertyName: "createdate", operator: "GTE", value: String(since.getTime()) }] }] };
      if (!after) delete body.after;
      const response = await fetch("https://api.hubapi.com/crm/v3/objects/tickets/search", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { results?: Array<{ id: string; properties: Record<string, string | null> }>; paging?: { next?: { after: string } }; message?: string };
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${payload.message ?? "HubSpot request failed"}`);
      for (const ticket of payload.results ?? []) {
        const p = ticket.properties; let assetRef: string | null = null; let matchedProp: string | null = null;
        for (const key of ASSET_PROPERTY_CANDIDATES) if (p[key]?.trim()) { assetRef = p[key]!.trim(); matchedProp = key; break; }
        if (!assetRef && p.source_type === "FORM" && p.subject) { assetRef = p.subject.trim(); matchedProp = "subject(form)"; }
        if (matchedProp) matched[matchedProp] = (matched[matchedProp] ?? 0) + 1;
        await db.insert(serviceDeskTickets).values({ externalId: ticket.id, subject: p.subject, pipeline: p.hs_pipeline, pipelineStage: p.hs_pipeline_stage, assetRef, createdAt: date(p.createdate), closedAt: date(p.closed_date), properties: p }).onConflictDoUpdate({ target: serviceDeskTickets.externalId, set: { subject: p.subject, pipeline: p.hs_pipeline, pipelineStage: p.hs_pipeline_stage, assetRef, createdAt: date(p.createdate), closedAt: date(p.closed_date), properties: p, ingestedAt: new Date() } });
        count++;
      }
      after = payload.paging?.next?.after;
    } while (after);
    await db.insert(serviceDeskIngestionLog).values({ source: "hubspot", status: "success", ticketsImported: count, filesFound: null, filesProcessed: null });
    return { count, error: null, matchedAssetProperties: matched };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); logger.error({ error: message }, "HubSpot ingestion failed");
    await db.insert(serviceDeskIngestionLog).values({ source: "hubspot", status: "error", ticketsImported: count, errorMessage: message });
    return { count, error: message, matchedAssetProperties: matched };
  }
}

async function importCsv(content: Buffer, filename: string, type: string, jobTypesByRef?: ReadonlyMap<string, string>) {
  if (type === "outstanding") return importOutstandingCsv(content, filename, jobTypesByRef, "ftps");
  const input = rows(content);
  // Outstanding exports are snapshots. Replacement is performed in one DB
  // transaction after parsing has succeeded, so a bad file cannot erase the
  // current schedule.
  const run = async (connection: any) => {
    let imported = 0;
  for (const r of input) {
    const ref = val(r, ["id", "job_number", "job_ref", "job_id", "reference"]); const asset = val(r, ["job_reference", "asset_ref", "job_reference_number", "equipment", "asset_number"]) ?? (val(r, ["job_description", "description"])?.match(/^(\d+)\s*[-–]/)?.[1] ?? null);
    const scheduled = date(val(r, ["visit_startdate", "appointment_date", "appointment", "planned_date"])); const completed = date(val(r, ["completeddate", "completion_date", "completed_date", "date_completed", "date"]));
    if (type === "jobs" && !completed || type === "outstanding" && !scheduled) continue;
    if (type === "jobs" || type === "outstanding") {
      // JobLogic job reference is stable across exports. Filename is metadata,
      // never part of identity (otherwise every weekly export duplicates jobs).
      const externalId = type === "outstanding"
        ? `joblogic:scheduled:${String(ref ?? asset ?? "unknown").trim().toLowerCase()}:${scheduled!.toISOString()}`
        : completedJobIdentity(String(ref ?? asset ?? "unknown"), completed!);
      await connection.insert(serviceDeskJobs).values({
        externalId,
        jobRef: ref,
        jobType: val(r, ["job_type"]),
        assetRef: asset,
        site: val(r, ["job_site", "customer", "site", "location"]),
        engineer: val(r, ["last_engineer", "first_engineer", "engineer", "completed_by"]),
        status: val(r, ["job_status", "status"]),
        scheduledAt: scheduled,
        completedAt: completed,
        sourceFile: filename,
      }).onConflictDoUpdate({
        target: serviceDeskJobs.externalId,
        set: {
          jobType: val(r, ["job_type"]),
          assetRef: asset,
          site: val(r, ["job_site", "customer", "site", "location"]),
          engineer: val(r, ["last_engineer", "first_engineer", "engineer", "completed_by"]),
          status: val(r, ["job_status", "status"]),
          scheduledAt: scheduled,
          completedAt: completed,
          sourceFile: filename,
          ingestedAt: new Date(),
        },
      });
      imported++;
    } else if (["assets", "rental_assets", "asset_addresses"].includes(type)) {
      const assetRef = val(r, ["number", "asset_number", "asset_ref", "asset_reference", "asset_autoinc"]) ?? val(r, ["description"])?.match(/^(\d+)\s*[-–]/)?.[1]; if (!assetRef) continue;
      await connection.insert(serviceDeskAssets).values({ externalId: val(r, ["asset_id", "asset_autoinc"]), assetRef, serviceCount: Number(val(r, ["service_count"]) ?? 0) || null, lastServicedAt: date(val(r, ["last_serviced", "last_serviced_date"])), serviceType: val(r, ["service_type"]), siteId: val(r, ["site_id"]), description: val(r, ["description"]), customer: val(r, ["customer", "site"]), postcode: val(r, ["postcode", "post_code"]), latitude: val(r, ["latitude", "lat"]), longitude: val(r, ["longitude", "lng"]), sourceFile: filename }).onConflictDoUpdate({ target: serviceDeskAssets.externalId, set: { assetRef: sql`coalesce(excluded.asset_ref, ${serviceDeskAssets.assetRef})`, serviceType: sql`coalesce(excluded.service_type, ${serviceDeskAssets.serviceType})`, siteId: sql`coalesce(excluded.site_id, ${serviceDeskAssets.siteId})`, description: sql`coalesce(excluded.description, ${serviceDeskAssets.description})`, customer: sql`coalesce(excluded.customer, ${serviceDeskAssets.customer})`, postcode: sql`coalesce(excluded.postcode, ${serviceDeskAssets.postcode})`, latitude: sql`coalesce(excluded.latitude, ${serviceDeskAssets.latitude})`, longitude: sql`coalesce(excluded.longitude, ${serviceDeskAssets.longitude})`, ingestedAt: new Date() } });
      imported++;
    }
  }
  return imported;
  };
  // Keep snapshot deletion and replacement atomic. Do not extract the method:
  // Drizzle binds transaction internals to the database instance.
  return run(db);
}

async function downloadCsvFile(client: Client, filename: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  await client.downloadTo(stream, filename);
  return Buffer.concat(chunks);
}

export async function ingestFtps() {
  const host = process.env.FTP_HOST, user = process.env.FTP_USER, password = process.env.FTP_PASSWORD;
  if (!host || !user || !password) return { filesFound: 0, filesProcessed: 0, error: "FTP credentials not configured (FTP_HOST, FTP_USER, FTP_PASSWORD required)" };
  const client = new Client(); let filesProcessed = 0; let error: string | null = null;
  try {
    const plaintext = process.env.FTP_ALLOW_PLAINTEXT === "true";
    if (plaintext) logger.warn("Service Desk FTP is using plaintext; credentials and job reports are not encrypted in transit");
    await client.access({
      host, port: Number(process.env.FTP_PORT ?? 21), user, password,
      secure: !plaintext, ...(plaintext ? {} : { secureOptions: { rejectUnauthorized: true } }),
    });
    const files = (await client.list("/")).filter(f => f.type === 1 && f.name.toLowerCase().endsWith(".csv"));
    // JobLogic generates a new filename for each daily full snapshot. Import only
    // the newest of each report, not weeks of superseded copies on first sync.
    const reportFamily = (name: string) => {
      const lower = name.toLowerCase();
      return ["outstanding jobs by engineer", "outstanding jobs logged today or before", "all jobs", "all sites", "all assets"]
        .find(prefix => lower.startsWith(prefix)) ?? null;
    };
    const newest = new Map<string, (typeof files)[number]>();
    for (const file of files) {
      const family = reportFamily(file.name);
      if (!family) continue;
      const previous = newest.get(family);
      if (!previous || (file.modifiedAt?.getTime() ?? 0) > (previous.modifiedAt?.getTime() ?? 0)) newest.set(family, file);
    }
    const latestEngineer = newest.get("outstanding jobs by engineer")?.name;
    const latestAllJobs = newest.get("all jobs")?.name;
    const contents = new Map<string, Buffer>();
    const readCsvFile = async (filename: string) => {
      const cached = contents.get(filename);
      if (cached) return cached;
      const content = await downloadCsvFile(client, filename);
      contents.set(filename, content);
      return content;
    };
    const isProcessed = async (filename: string) => {
      const found = await db.select({ id: serviceDeskProcessedFiles.id }).from(serviceDeskProcessedFiles).where(eq(serviceDeskProcessedFiles.filename, filename)).limit(1);
      return found.length > 0;
    };
    let refreshEngineerSchedule = false;
    let jobTypesByRef = new Map<string, string>();
    if (latestEngineer) {
      const [engineerProcessed, allJobsProcessed, legacyScheduleTypes] = await Promise.all([
        isProcessed(latestEngineer),
        latestAllJobs ? isProcessed(latestAllJobs) : Promise.resolve(true),
        db.select({ id: serviceDeskJobs.id }).from(serviceDeskJobs)
          .where(and(
            isNotNull(serviceDeskJobs.scheduledAt),
            isNull(serviceDeskJobs.completedAt),
            sql`(position(chr(10) in coalesce(${serviceDeskJobs.jobType}, '')) > 0 or position(chr(13) in coalesce(${serviceDeskJobs.jobType}, '')) > 0)`,
          ))
          .limit(1),
      ]);
      const needsLegacyTypeCorrection = legacyScheduleTypes.length > 0;
      refreshEngineerSchedule = !engineerProcessed || (!!latestAllJobs && (!allJobsProcessed || needsLegacyTypeCorrection));
      if (needsLegacyTypeCorrection && !latestAllJobs) {
        logger.warn("Stored schedule rows contain description text as Job Type, but no All Jobs export is available to correct them");
      }
      if (refreshEngineerSchedule && latestAllJobs) {
        const allJobsContent = await readCsvFile(latestAllJobs);
        jobTypesByRef = buildJobTypeLookup(allJobsContent);
        if (jobTypesByRef.size === 0) {
          logger.warn({ filename: latestAllJobs }, "All Jobs export had no Job Type values for the outstanding-job lookup");
        }
      }
    }
    for (const file of files) {
      const family = reportFamily(file.name);
      if (family && newest.get(family)?.name !== file.name) continue;
      if (family === "outstanding jobs logged today or before" && latestEngineer) continue;
      const refreshThisEngineerSchedule = file.name === latestEngineer && refreshEngineerSchedule;
      if (await isProcessed(file.name) && !refreshThisEngineerSchedule) continue;
       const content = await readCsvFile(file.name); const parsed = rows(content); const first = parsed[0] ?? Object.fromEntries(((parse(content, { to_line: 1, bom: true, trim: true }) as string[][])[0] ?? []).map(header => [header.toLowerCase().replace(/[\s-]+/g, "_").trim(), ""])); const detectedType = kind(first); const isOutstandingReport = file.name.toLowerCase().startsWith("outstanding jobs by engineer") || file.name.toLowerCase().startsWith("outstanding jobs logged today or before"); const type = detectedType === "unknown" && isOutstandingReport ? "outstanding" : detectedType; if (type === "unknown") { logger.warn({ filename: file.name }, "Skipping unknown FTPS CSV type"); continue; } const imported = await importCsv(content, file.name, type, refreshThisEngineerSchedule ? jobTypesByRef : undefined);
      await db.insert(serviceDeskProcessedFiles).values({ filename: file.name }).onConflictDoNothing(); filesProcessed++; logger.info({ filename: file.name, imported }, "FTPS file imported");
    }
    // Enrich imported postcodes through the public bulk geocoder when source
    // exports do not contain coordinates. This is best-effort and never blocks
    // successful CSV persistence.
    const pending = await db.select({ postcode: serviceDeskAssets.postcode }).from(serviceDeskAssets).where(and(sql`${serviceDeskAssets.postcode} is not null`, isNull(serviceDeskAssets.latitude))).limit(100);
    if (pending.length) {
      try {
        const response = await fetch("https://api.postcodes.io/postcodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ postcodes: pending.map(p => p.postcode) }) });
        const payload = await response.json() as { result?: Array<{ query: string; result: { latitude: number; longitude: number } | null }> };
        for (const item of payload.result ?? []) if (item.result) await db.update(serviceDeskAssets).set({ latitude: String(item.result.latitude), longitude: String(item.result.longitude) }).where(eq(serviceDeskAssets.postcode, item.query));
      } catch (geocodeError) { logger.warn({ error: geocodeError }, "Postcode enrichment failed"); }
    }
    await db.insert(serviceDeskIngestionLog).values({ source: "ftps", status: error ? "partial" : "success", filesFound: files.length, filesProcessed, errorMessage: error });
    return { filesFound: files.length, filesProcessed, error };
  } catch (e) { error = e instanceof Error ? e.message : String(e); logger.error({ error }, "FTPS ingestion failed"); await db.insert(serviceDeskIngestionLog).values({ source: "ftps", status: "error", filesProcessed, errorMessage: error }); return { filesFound: 0, filesProcessed, error }; } finally { client.close(); }
}