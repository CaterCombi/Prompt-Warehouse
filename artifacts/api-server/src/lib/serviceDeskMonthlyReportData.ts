import { and, desc, eq, gte, ilike, lt, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { serviceDeskIngestionLog, serviceDeskJobs } from "@workspace/db/schema";
import {
  buildMonthlyServiceDeskReport,
  type MonthlyAllJobsFreshnessRecord,
  type MonthlyServiceDeskJobInput,
  type MonthlyServiceDeskReport,
} from "./serviceDeskMonthlyReportDataCore.js";
import { serviceDeskReportMonthRange } from "./serviceDeskMonthlyReportCore.js";

export type { MonthlyServiceDeskReport } from "./serviceDeskMonthlyReportDataCore.js";

export async function loadMonthlyServiceDeskReport(
  month: string,
  generatedAt = new Date(),
): Promise<MonthlyServiceDeskReport> {
  const range = serviceDeskReportMonthRange(month);
  const [jobRows, freshnessRecords] = await Promise.all([
    db.select({
      jobRef: serviceDeskJobs.jobRef,
      jobType: serviceDeskJobs.jobType,
      assetRef: serviceDeskJobs.assetRef,
      site: serviceDeskJobs.site,
      engineer: serviceDeskJobs.engineer,
      completedAt: serviceDeskJobs.completedAt,
      externalId: serviceDeskJobs.externalId,
    }).from(serviceDeskJobs).where(and(
      gte(serviceDeskJobs.completedAt, range.start),
      lt(serviceDeskJobs.completedAt, range.end),
      ilike(serviceDeskJobs.sourceFile, "All Jobs%.csv"),
    )),
    db.select({
      createdAt: serviceDeskIngestionLog.createdAt,
      metadata: serviceDeskIngestionLog.metadata,
    }).from(serviceDeskIngestionLog).where(and(
      eq(serviceDeskIngestionLog.source, "joblogic_all_jobs"),
      sql`${serviceDeskIngestionLog.metadata}->>'kind' = 'monthly_all_jobs_report'`,
    )).orderBy(desc(serviceDeskIngestionLog.createdAt)).limit(1),
  ]);
  return buildMonthlyServiceDeskReport(
    month,
    jobRows as MonthlyServiceDeskJobInput[],
    freshnessRecords[0] as MonthlyAllJobsFreshnessRecord | undefined,
    generatedAt,
  );
}
