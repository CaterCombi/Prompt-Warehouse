import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@workspace/db";
import {
  serviceDeskAssets, serviceDeskIngestionLog, serviceDeskJobs,
  serviceDeskLegacyImports, serviceDeskPostcodes, serviceDeskProcessedFiles,
  serviceDeskSites, serviceDeskTickets,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { completedJobIdentity } from "./serviceDeskIngestion.js";

type Row = Record<string, unknown>;
type Counts = {
  tickets: number; jobs: number; assets: number; sites: number;
  postcodes: number; ingestionLogs: number; processedFiles: number;
};
type ImportResult = { alreadyImported: boolean; counts: Counts; mapReady: number };

const str = (value: unknown): string | null =>
  value === null || value === undefined || String(value).trim() === ""
    ? null : String(value).trim();
const date = (value: unknown): Date | null => {
  const text = str(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const postcodeKey = (value: unknown) => (str(value) ?? "").toUpperCase().replace(/\s/g, "");
const numberText = (value: unknown): string | null =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : String(value);
const int = (value: unknown): number | null =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);

/**
 * User-initiated, idempotent import of the original Service Desk SQLite file.
 * Nothing in the legacy file is deleted or changed. A transaction ensures that
 * a failed import cannot leave a partially migrated Service Desk behind.
 */
export async function importLegacyServiceDesk(bytes: Buffer): Promise<ImportResult> {
  if (bytes.subarray(0, 16).toString("binary") !== "SQLite format 3\0") {
    throw new Error("The file is not a SQLite database. Extract the .sqlite file from the ZIP first.");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const previous = await db.select().from(serviceDeskLegacyImports)
    .where(eq(serviceDeskLegacyImports.sha256, sha256)).limit(1);
  if (previous.length) return {
    alreadyImported: true, counts: previous[0]!.counts as Counts, mapReady: previous[0]!.mapReady,
  };

  const directory = await mkdtemp(join(tmpdir(), "service-desk-import-"));
  let source: DatabaseSync | undefined;
  let tickets: Row[]; let jobs: Row[]; let assets: Row[];
  let sites: Row[]; let postcodes: Row[]; let logs: Row[]; let processed: Row[];
  try {
    const path = join(directory, "legacy.sqlite");
    await writeFile(path, bytes, { mode: 0o600 });
    source = new DatabaseSync(path, { readOnly: true });
    const integrity = source.prepare("PRAGMA quick_check").get() as Row | undefined;
    if (integrity?.quick_check !== "ok") throw new Error("The SQLite database failed its integrity check.");
    const required = [
      "hubspot_tickets", "joblogic_jobs", "joblogic_assets", "sites",
      "postcode_geocode", "ingestion_log", "processed_files",
    ];
    const present = new Set(
      (source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[])
        .map(row => str(row.name)),
    );
    if (required.some(table => !present.has(table))) {
      throw new Error("The database does not have the expected Service Desk tables.");
    }
    const read = (table: string) => source!.prepare(`SELECT * FROM ${table}`).all() as Row[];
    tickets = read("hubspot_tickets");
    jobs = read("joblogic_jobs");
    assets = read("joblogic_assets");
    sites = read("sites");
    postcodes = read("postcode_geocode");
    logs = read("ingestion_log");
    processed = read("processed_files");
  } finally {
    source?.close();
    await rm(directory, { recursive: true, force: true });
  }

  const counts: Counts = {
    tickets: tickets.length, jobs: jobs.length, assets: assets.length,
    sites: sites.length, postcodes: postcodes.length,
    ingestionLogs: logs.length, processedFiles: processed.length,
  };
  const siteById = new Map(sites.map(row => [str(row.site_id), row]));
  const geoByPostcode = new Map(postcodes.map(row => [postcodeKey(row.postcode), row]));
  let mapReady = 0;
  const assetRows = assets.map(row => {
    const site = siteById.get(str(row.site_id)) ?? null;
    const postcode = str(site?.postcode);
    const geo = geoByPostcode.get(postcodeKey(postcode));
    const latitude = numberText(geo?.lat), longitude = numberText(geo?.lng);
    if (latitude !== null && longitude !== null) mapReady++;
    return {
      externalId: str(row.asset_id) ?? `legacy:asset:${row.id}`,
      assetRef: str(row.asset_ref) ?? "",
      serviceCount: int(row.service_count),
      lastServicedAt: date(row.last_serviced_date),
      serviceType: str(row.service_type),
      siteId: str(row.site_id),
      description: str(row.description),
      customer: str(row.customer),
      postcode,
      latitude, longitude,
      sourceFile: str(row.source_file),
      ingestedAt: date(row.ingested_at) ?? new Date(),
    };
  });
  const seenJobIds = new Set<string>();
  const jobRows = jobs.map(row => {
    const completedAt = date(row.completion_date);
    const scheduledAt = date(row.scheduled_date);
    const jobRef = str(row.job_ref);
    const ref = jobRef ?? `legacy:${row.id}`;
    const base = completedAt ? completedJobIdentity(ref, completedAt)
      : scheduledAt ? `joblogic:scheduled:${ref.toLowerCase()}:${scheduledAt.toISOString()}`
      : `legacy:job:${row.id}`;
    const externalId = seenJobIds.has(base) ? `${base}:legacy:${row.id}` : base;
    seenJobIds.add(base);
    return {
      externalId, jobRef, completedAt, scheduledAt,
      jobType: str(row.job_type), assetRef: str(row.asset_ref),
      site: str(row.site), engineer: str(row.engineer),
      status: str(row.status), sourceFile: str(row.source_file),
      ingestedAt: date(row.ingested_at) ?? new Date(),
    };
  });

  return db.transaction(async tx => {
    // The marker is inserted *inside* the same transaction as all records.
    const claimed = await tx.insert(serviceDeskLegacyImports)
      .values({ sha256, counts, mapReady })
      .onConflictDoNothing({ target: serviceDeskLegacyImports.sha256 })
      .returning({ sha256: serviceDeskLegacyImports.sha256 });
    if (!claimed.length) {
      const existing = await tx.select().from(serviceDeskLegacyImports)
        .where(eq(serviceDeskLegacyImports.sha256, sha256)).limit(1);
      return { alreadyImported: true, counts: existing[0]!.counts as Counts, mapReady: existing[0]!.mapReady };
    }

    if (tickets.length) await tx.insert(serviceDeskTickets).values(tickets.map(row => ({
      externalId: str(row.ticket_id)!, subject: str(row.subject),
      pipeline: str(row.pipeline), pipelineStage: str(row.pipeline_stage),
      assetRef: str(row.asset_ref), createdAt: date(row.create_date),
      closedAt: date(row.closed_date), ingestedAt: date(row.ingested_at) ?? new Date(),
    }))).onConflictDoNothing({ target: serviceDeskTickets.externalId });
    if (jobs.length) await tx.insert(serviceDeskJobs).values(jobRows)
      .onConflictDoNothing({ target: serviceDeskJobs.externalId });
    if (sites.length) await tx.insert(serviceDeskSites).values(sites.map(row => ({
      siteId: str(row.site_id)!, name: str(row.name), postcode: str(row.postcode),
      sourceFile: str(row.source_file), ingestedAt: date(row.ingested_at),
    }))).onConflictDoNothing({ target: serviceDeskSites.siteId });
    if (postcodes.length) await tx.insert(serviceDeskPostcodes).values(postcodes.map(row => ({
      postcode: str(row.postcode)!, latitude: numberText(row.lat),
      longitude: numberText(row.lng), lookedUpAt: date(row.looked_up_at),
      failed: int(row.failed),
    }))).onConflictDoNothing({ target: serviceDeskPostcodes.postcode });
    if (assets.length) await tx.insert(serviceDeskAssets).values(assetRows)
      .onConflictDoNothing({ target: serviceDeskAssets.externalId });
    if (logs.length) await tx.insert(serviceDeskIngestionLog).values(logs.map(row => ({
      externalId: `legacy:log:${row.id}`, source: str(row.source) ?? "legacy",
      status: str(row.status) ?? "unknown", filesFound: int(row.files_found),
      filesProcessed: int(row.files_processed), ticketsImported: int(row.tickets_imported),
      errorMessage: str(row.error_message), metadata: { fileType: str(row.file_type) },
      createdAt: date(row.timestamp) ?? new Date(),
    }))).onConflictDoNothing({ target: serviceDeskIngestionLog.externalId });
    if (processed.length) await tx.insert(serviceDeskProcessedFiles).values(processed.map(row => ({
      filename: str(row.filename)!, processedAt: date(row.processed_at) ?? new Date(),
    }))).onConflictDoNothing({ target: serviceDeskProcessedFiles.filename });
    await tx.insert(serviceDeskIngestionLog).values({
      source: "legacy_import", status: "success", metadata: { sha256, counts, mapReady },
    });
    return { alreadyImported: false, counts, mapReady };
  });
}