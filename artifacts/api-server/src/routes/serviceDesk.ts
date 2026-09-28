import { Router, raw, text } from "express";
import { parse } from "csv-parse/sync";
import { desc, eq, isNull, and, gte, lt, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { serviceDeskAssets, serviceDeskIngestionLog, serviceDeskJobs, serviceDeskSites, serviceDeskTickets } from "@workspace/db/schema";
import { requireAuth } from "../middlewares/requireAuth.js";
import { completedJobIdentity, date as parseJobLogicDate, importOutstandingCsv } from "../lib/serviceDeskIngestion.js";
import { importLegacyServiceDesk } from "../lib/serviceDeskLegacyImport.js";
import { canonicalServiceDeskJobType } from "../lib/serviceDeskJobTypes.js";

const router = Router();
router.use(requireAuth);

const textValue = (v: unknown) => typeof v === "string" ? v.trim() || null : null;
const iso = (v: string | null) => {
  if (!v) return null;
  const uk = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (uk) {
    const d = new Date(`${uk[3]!.length === 2 ? "20" : ""}${uk[3]}-${uk[2]!.padStart(2, "0")}-${uk[1]!.padStart(2, "0")}T${(uk[4] ?? "00").padStart(2, "0")}:${uk[5] ?? "00"}:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const normaliseAssetRef = (ref: string) => ref.trim().toLowerCase().replace(/^0+/, "") || ref.trim().toLowerCase();
const parseAssetRefs = (value: string | null) =>
  (value ?? "").split(/[,;]|\s+-|-\s+/).map(normaliseAssetRef).filter(Boolean);
router.get("/summary", async (req, res) => {
  try {
    const now = new Date();
    const month = typeof req.query.month === "string" ? req.query.month : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const start = iso(`${month}-01T00:00:00Z`) ?? new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
    const [open, tickets, jobs, allJobs, last] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(serviceDeskTickets).where(isNull(serviceDeskTickets.closedAt)),
      db.select({ count: sql<number>`count(*)` }).from(serviceDeskTickets).where(and(gte(serviceDeskTickets.createdAt, start), lt(serviceDeskTickets.createdAt, end))),
      db.select({ count: sql<number>`count(distinct ${serviceDeskJobs.jobRef})` }).from(serviceDeskJobs).where(and(gte(serviceDeskJobs.completedAt, start), lt(serviceDeskJobs.completedAt, end))),
      db.select({ completedAt: serviceDeskJobs.completedAt, scheduledAt: serviceDeskJobs.scheduledAt, ingestedAt: serviceDeskJobs.ingestedAt }).from(serviceDeskJobs).where(sql`${serviceDeskJobs.completedAt} is not null or ${serviceDeskJobs.scheduledAt} is not null`),
      db.select().from(serviceDeskIngestionLog).orderBy(desc(serviceDeskIngestionLog.createdAt)).limit(1),
    ]);
    const days = new Set(allJobs.map(j => j.completedAt).filter(d => d && d >= start && d < end).map(d => d!.toISOString().slice(0, 10)));
    const outstanding = allJobs.filter(j => j.scheduledAt && !j.completedAt).sort((a, b) => b.ingestedAt.getTime() - a.ingestedAt.getTime())[0];
    res.json({ openTicketsNow: Number(open[0]?.count ?? 0), ticketsThisMonth: Number(tickets[0]?.count ?? 0), jobsThisMonth: Number(jobs[0]?.count ?? 0), activeDaysThisMonth: days.size, lastSyncedAt: last[0]?.createdAt?.toISOString() ?? null, lastSyncStatus: last[0]?.status === "success" ? "ok" : (last[0]?.status ?? "never"), lastSyncError: last[0]?.errorMessage ?? null, outstandingJobsLastUpdatedAt: outstanding?.ingestedAt.toISOString() ?? null });
  } catch (error) { req.log.error({ error }, "Service Desk summary failed"); res.status(500).json({ error: "Failed to load Service Desk summary" }); }
});

router.get("/trends", async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30) || 30));
  try {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - days + 1);
    const [ticketRows, jobRows, scheduledRows] = await Promise.all([
      db.select({ date: serviceDeskTickets.createdAt }).from(serviceDeskTickets).where(gte(serviceDeskTickets.createdAt, since)),
      db.select({ date: serviceDeskJobs.completedAt, jobType: serviceDeskJobs.jobType }).from(serviceDeskJobs).where(gte(serviceDeskJobs.completedAt, since)),
      db.select({ date: serviceDeskJobs.scheduledAt, jobType: serviceDeskJobs.jobType }).from(serviceDeskJobs).where(and(isNull(serviceDeskJobs.completedAt), gte(serviceDeskJobs.scheduledAt, since))),
    ]);
    const map = new Map<string, { tickets: number; jobs: number }>();
    for (let i = 0; i < days; i++) {
      const day = new Date(since);
      day.setUTCDate(day.getUTCDate() + i);
      map.set(day.toISOString().slice(0, 10), { tickets: 0, jobs: 0 });
    }
    for (const r of ticketRows) if (r.date) { const d = r.date.toISOString().slice(0, 10); const v = map.get(d) ?? { tickets: 0, jobs: 0 }; v.tickets++; map.set(d, v); }
    for (const r of jobRows) if (r.date) { const d = r.date.toISOString().slice(0, 10); const v = map.get(d) ?? { tickets: 0, jobs: 0 }; v.jobs++; map.set(d, v); }
    const sorted = [...map.entries()].sort();
    const daily = sorted.map(([date, v], i) => { const avg = (n: number) => Math.round(sorted.slice(Math.max(0, i - n + 1), i + 1).reduce((s, [, x]) => s + x.tickets, 0) / Math.min(n, i + 1) * 10) / 10; return { date, ...v, rollingAvg7: avg(7), rollingAvg30: avg(30) }; });
    const months = new Map<string, { tickets: number; jobs: number; jobsByType: Record<string, number> }>();
    for (const r of ticketRows) if (r.date) { const m = r.date.toISOString().slice(0, 7); const v = months.get(m) ?? { tickets: 0, jobs: 0, jobsByType: {} }; v.tickets++; months.set(m, v); }
    for (const r of [...jobRows, ...scheduledRows]) if (r.date) { const m = r.date.toISOString().slice(0, 7); const v = months.get(m) ?? { tickets: 0, jobs: 0, jobsByType: {} }; v.jobs++; const t = canonicalServiceDeskJobType(r.jobType); v.jobsByType[t] = (v.jobsByType[t] ?? 0) + 1; months.set(m, v); }
    res.json({ daily, monthly: [...months.entries()].sort().map(([month, v]) => ({ month, ...v })), period: days });
  } catch (error) { req.log.error({ error }, "Service Desk trends failed"); res.status(500).json({ error: "Failed to load trends" }); }
});

router.get("/top-assets", async (req, res) => {
  try {
    const [assets, jobs, tickets] = await Promise.all([db.select().from(serviceDeskAssets).where(sql`lower(trim(coalesce(${serviceDeskAssets.serviceType}, ''))) = 'rental' or (trim(coalesce(${serviceDeskAssets.serviceType}, '')) = '' and lower(trim(coalesce(${serviceDeskAssets.customer}, ''))) in (select lower(trim(customer)) from service_desk_assets where lower(trim(coalesce(service_type, ''))) = 'rental'))`), db.select().from(serviceDeskJobs), db.select().from(serviceDeskTickets)]);
    const norm = normaliseAssetRef;
    const map = new Map<string, any>();
    for (const a of assets) if (a.assetRef?.trim()) map.set(norm(a.assetRef), { assetId: a.assetRef, assetRef: a.assetRef, ticketCount: 0, jobCount: 0, totalJobCount: 0, lastServiceDate: null, installationDate: null });
    for (const j of jobs) for (const part of parseAssetRefs(j.assetRef)) { const a = map.get(part); if (!a || !j.completedAt) continue; a.totalJobCount++; if (j.completedAt >= new Date(Date.now() - 365 * 86400000)) a.jobCount++; const d = j.completedAt.toISOString(); if (!a.lastServiceDate || d > a.lastServiceDate) a.lastServiceDate = d; const category = canonicalServiceDeskJobType(j.jobType); if ((category === "Rental installation" || category === "Sale installation") && (!a.installationDate || d < a.installationDate)) a.installationDate = d; }
    for (const t of tickets) for (const part of parseAssetRefs(t.assetRef)) { const a = map.get(part); if (a && t.createdAt && t.createdAt >= new Date(Date.now() - 365 * 86400000)) a.ticketCount++; }
    res.json([...map.values()].map(a => ({ ...a, totalCount: a.ticketCount + a.jobCount })).filter(a => a.jobCount > 0).sort((a, b) => b.jobCount - a.jobCount).slice(0, 15));
  } catch (error) { req.log.error({ error }, "Service Desk top assets failed"); res.status(500).json({ error: "Failed to load top assets" }); }
});

router.get("/upcoming-jobs", async (req, res) => {
  try {
    const from = new Date(); from.setHours(0, 0, 0, 0); const to = new Date(from.getTime() + 7 * 86400000);
    const rows = await db.select().from(serviceDeskJobs).where(and(gte(serviceDeskJobs.scheduledAt, from), lt(serviceDeskJobs.scheduledAt, to))).orderBy(serviceDeskJobs.scheduledAt);
    res.json(rows.map(r => ({ jobRef: r.jobRef, jobType: canonicalServiceDeskJobType(r.jobType), site: r.site, assetRef: r.assetRef, engineer: r.engineer, status: r.status, scheduledDate: r.scheduledAt?.toISOString() })));
  } catch (error) { req.log.error({ error }, "Service Desk upcoming jobs failed"); res.status(500).json({ error: "Failed to load upcoming jobs" }); }
});

router.get("/rental-pins", async (_req, res) => {
  const rows = await db.select({ asset: serviceDeskAssets, siteName: serviceDeskSites.name })
    .from(serviceDeskAssets).leftJoin(serviceDeskSites, eq(serviceDeskAssets.siteId, serviceDeskSites.siteId))
    .where(and(sql`lower(trim(coalesce(${serviceDeskAssets.serviceType}, ''))) = 'rental'`, sql`${serviceDeskAssets.latitude} is not null`, sql`${serviceDeskAssets.longitude} is not null`));
  res.json(rows.map(({ asset: r, siteName }) => ({ assetRef: r.assetRef, description: r.description, customer: r.customer, site: siteName ?? r.siteId, postcode: r.postcode, lat: Number(r.latitude), lng: Number(r.longitude), lastServicedDate: r.lastServicedAt?.toISOString() ?? null, serviceType: r.serviceType })));
});
router.get("/map", async (_req, res) => {
  const rows = await db.select({ asset: serviceDeskAssets, siteName: serviceDeskSites.name })
    .from(serviceDeskAssets).leftJoin(serviceDeskSites, eq(serviceDeskAssets.siteId, serviceDeskSites.siteId))
    .where(and(sql`${serviceDeskAssets.latitude} is not null`, sql`${serviceDeskAssets.longitude} is not null`));
  res.json(rows.map(({ asset: r, siteName }) => ({ assetRef: r.assetRef, description: r.description, customer: r.customer, site: siteName ?? r.siteId, postcode: r.postcode, lat: Number(r.latitude), lng: Number(r.longitude), lastServicedDate: r.lastServicedAt?.toISOString() ?? null, serviceType: r.serviceType })));
});

router.get("/ingestion-log", async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
  const rows = await db.select().from(serviceDeskIngestionLog).orderBy(desc(serviceDeskIngestionLog.createdAt)).limit(limit);
  res.json(rows.map(r => ({ id: r.id, timestamp: r.createdAt.toISOString(), source: r.source, status: r.status, filesFound: r.filesFound, filesProcessed: r.filesProcessed, ticketsImported: r.ticketsImported, errorMessage: r.errorMessage })));
});

router.get("/dashboard/asset-history", async (req, res) => {
  const assetRef = textValue(req.query.assetRef);
  if (!assetRef) { res.status(400).json({ error: "assetRef is required" }); return; }
  const rows = await db.select().from(serviceDeskJobs).where(sql`${serviceDeskJobs.completedAt} is not null`).orderBy(desc(serviceDeskJobs.completedAt));
  const normalised = normaliseAssetRef(assetRef);
  res.json(rows.filter(r => parseAssetRefs(r.assetRef).includes(normalised)).map(r => ({ jobRef: r.jobRef ?? "", jobType: canonicalServiceDeskJobType(r.jobType), site: r.site, engineer: r.engineer, completionDate: r.completedAt!.toISOString() })));
});

router.post("/import-sqlite", raw({ type: "application/octet-stream", limit: "20mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    res.status(400).json({ error: "Upload an extracted Service Desk .sqlite database file." });
    return;
  }
  try {
    res.json(await importLegacyServiceDesk(req.body));
  } catch (error) {
    req.log.error({ error }, "Service Desk legacy import failed");
    const message = error instanceof Error ? error.message : "";
    if (/^(The file is not|The SQLite database|The database does not)/.test(message)) {
      res.status(400).json({ error: message });
    } else {
      res.status(500).json({ error: "The historical database could not be imported. No partial records were saved." });
    }
  }
});

router.post("/upload-csv", text({ type: ["text/csv", "text/plain"], limit: "25mb" }), async (req, res) => {
  const filename = textValue(req.query.filename) ?? "upload.csv";
  const kind = textValue(req.query.kind) ?? "completed";
  const body = typeof req.body === "string" ? req.body : "";
  if (!body.trim()) { res.status(400).json({ error: "A non-empty CSV file is required" }); return; }
  if (Buffer.byteLength(body, "utf8") > 25 * 1024 * 1024) { res.status(413).json({ error: "CSV exceeds the 25MB upload limit" }); return; }
  if (kind !== "completed" && kind !== "outstanding") { res.status(400).json({ error: "CSV kind must be completed or outstanding" }); return; }
  try {
    const records = parse(body, { columns: (headers: string[]) => headers.map(h => h.trim().toLowerCase().replace(/[\s-]+/g, "_")), skip_empty_lines: true, relax_column_count: false, bom: true, trim: true }) as Record<string, string>[];
    const headers = Object.keys(records[0] ?? {});
    const pick = (names: string[]) => names.find(n => headers.includes(n));
    const jobColumn = pick(["job_number", "job_ref", "job_id", "reference"]);
    const completedColumn = pick(["completeddate", "completion_date", "completed_date", "date_completed"]);
    if (kind === "outstanding") {
      if (!jobColumn && !pick(["id"])) { res.status(400).json({ error: "The schedule CSV needs a job ID." }); return; }
      const count = await importOutstandingCsv(Buffer.from(body, "utf8"), filename);
      await db.insert(serviceDeskIngestionLog).values({ source: "csv_upload", status: "success", filesFound: 1, filesProcessed: 1, ticketsImported: count, metadata: { kind: "outstanding", filename } });
      res.json({ filename, kind, rowsImported: count });
      return;
    }
    if (!jobColumn || !completedColumn) { res.status(400).json({ error: "Only JobLogic All Jobs CSV exports are supported" }); return; }
    const valid = records.flatMap(record => {
      const completedAt = parseJobLogicDate(textValue(record[completedColumn]));
      const jobRef = textValue(record[jobColumn]);
      if (!completedAt || !jobRef) return [];
      return [{
        externalId: completedJobIdentity(jobRef, completedAt), jobRef, completedAt,
        jobType: textValue(record.job_type),
        assetRef: textValue(record.job_reference ?? record.asset_ref ?? record.asset_reference ?? record.asset_number ?? record.equipment),
        site: textValue(record.job_site ?? record.site ?? record.customer),
        engineer: textValue(record.last_engineer ?? record.first_engineer ?? record.engineer ?? record.completed_by),
        status: textValue(record.job_status ?? record.status),
        sourceFile: filename,
      }];
    });
    if (!valid.length) { res.status(400).json({ error: "No completed jobs with valid dates and references were found" }); return; }
    const count = await db.transaction(async tx => {
      let inserted = 0;
      for (const row of valid) {
        const result = await tx.insert(serviceDeskJobs).values(row).onConflictDoUpdate({
          target: serviceDeskJobs.externalId,
          set: { jobRef: row.jobRef, jobType: row.jobType, assetRef: row.assetRef, site: row.site, engineer: row.engineer, status: row.status, completedAt: row.completedAt, sourceFile: row.sourceFile, ingestedAt: new Date() },
        }).returning({ id: serviceDeskJobs.id });
        inserted += result.length;
      }
      await tx.insert(serviceDeskIngestionLog).values({ source: "csv_upload", status: "success", filesFound: 1, filesProcessed: 1, ticketsImported: inserted });
      return inserted;
    });
    res.json({ filename, rowsImported: count });
  } catch (error) {
    req.log.warn({ error }, "Historical Service Desk CSV rejected");
    res.status(400).json({ error: "CSV could not be imported. Check its JobLogic headers, dates and quoting." });
  }
});

export default router;