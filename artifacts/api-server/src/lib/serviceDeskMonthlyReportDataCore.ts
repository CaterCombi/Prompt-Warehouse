const DEFAULT_ALL_JOBS_REPORT_MAX_AGE_DAYS = 35;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ServiceDeskReportJob = {
  jobRef: string | null;
  jobType: string | null;
  category: "Installation" | "Service" | "Repair" | "Other" | "Unclassified";
  assetRef: string | null;
  site: string | null;
  engineer: string | null;
  completedAt: string;
};

export type MonthlyServiceDeskReport = {
  month: string;
  monthLabel: string;
  startDate: string;
  endDate: string;
  generatedAt: string;
  source: {
    status: "fresh" | "stale" | "missing";
    filename: string | null;
    modifiedAt: string | null;
    observedAt: string | null;
    ageDays: number | null;
  };
  totals: {
    completedJobs: number;
    installations: number;
    services: number;
    repairs: number;
    otherJobs: number;
    distinctServiceAssets: number;
  };
  jobTypeBreakdown: Array<{ jobType: string; jobs: number }>;
  assets: Array<{
    assetRef: string;
    jobRefs: string[];
    jobTypes: string[];
    sites: string[];
    engineers: string[];
    latestCompletedAt: string;
  }>;
  jobs: ServiceDeskReportJob[];
  notes: string[];
};

export type MonthlyServiceDeskJobInput = {
  jobRef: string | null;
  jobType: string | null;
  assetRef: string | null;
  site: string | null;
  engineer: string | null;
  completedAt: Date | null;
  externalId: string | null;
};

export type MonthlyAllJobsFreshnessRecord = {
  createdAt: Date;
  metadata: unknown;
};

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeAssetKey(value: string): string {
  const normalized = value.trim().toLocaleLowerCase().replace(/^0+/, "");
  return normalized || value.trim().toLocaleLowerCase();
}

function serviceDeskReportMonthLabel(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("Service Desk report month must use YYYY-MM format");
  }
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function isInLondonReportMonth(value: Date, month: string): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(value).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}` === month;
}

export function classifyServiceDeskReportJobType(
  jobType: string | null,
): ServiceDeskReportJob["category"] {
  const normalized = normalizeLabel(jobType ?? "");
  if (!normalized) return "Unclassified";
  if (/\b(install|installation|deliver|delivery|ultravent)\b/.test(normalized)) {
    return "Installation";
  }
  if (/\b(service|servicing|maintenance|clean|cleaning|descal\w*|check ?up)\b/.test(normalized)) {
    return "Service";
  }
  if (/\b(repair|broken|fault|replace|replacement|call ?out|workshop|issue)\b/.test(normalized)) {
    return "Repair";
  }
  return "Other";
}

export function parseServiceDeskReportAssetRefs(value: string | null): string[] {
  if (!value?.trim()) return [];
  return [...new Set(
    value.split(/[,;]|\s+-|-\s+/)
      .map((assetRef) => assetRef.trim())
      .filter(Boolean),
  )];
}

function reportJobKey(row: MonthlyServiceDeskJobInput): string {
  const ref = row.jobRef?.trim().toLocaleLowerCase();
  return ref || row.externalId || `${row.completedAt?.toISOString() ?? "unknown"}:${row.assetRef ?? ""}`;
}

function latestUniqueJobs(rows: MonthlyServiceDeskJobInput[]): MonthlyServiceDeskJobInput[] {
  const jobs = new Map<string, MonthlyServiceDeskJobInput>();
  for (const row of rows) {
    if (!row.completedAt || !Number.isFinite(row.completedAt.getTime())) continue;
    const key = reportJobKey(row);
    const current = jobs.get(key);
    if (!current || row.completedAt.getTime() > (current.completedAt?.getTime() ?? 0)) {
      jobs.set(key, row);
    }
  }
  return [...jobs.values()].sort((first, second) =>
    (first.completedAt?.getTime() ?? 0) - (second.completedAt?.getTime() ?? 0),
  );
}

function readFreshness(
  record: MonthlyAllJobsFreshnessRecord | undefined,
  now: Date,
): MonthlyServiceDeskReport["source"] {
  if (!record) {
    return { status: "missing", filename: null, modifiedAt: null, observedAt: null, ageDays: null };
  }
  const metadata = record.metadata && typeof record.metadata === "object"
    ? record.metadata as Record<string, unknown>
    : {};
  if (metadata.status === "missing") {
    return {
      status: "missing",
      filename: null,
      modifiedAt: null,
      observedAt: record.createdAt.toISOString(),
      ageDays: null,
    };
  }
  const filename = typeof metadata.filename === "string" ? metadata.filename : null;
  const sourceModifiedAt = typeof metadata.sourceModifiedAt === "string"
    ? new Date(metadata.sourceModifiedAt)
    : null;
  if (!filename || !sourceModifiedAt || !Number.isFinite(sourceModifiedAt.getTime())) {
    return {
      status: "missing",
      filename,
      modifiedAt: null,
      observedAt: record.createdAt.toISOString(),
      ageDays: null,
    };
  }
  const maxAgeDays = typeof metadata.maxAgeDays === "number"
    && Number.isFinite(metadata.maxAgeDays)
    && metadata.maxAgeDays >= 0
    ? metadata.maxAgeDays
    : DEFAULT_ALL_JOBS_REPORT_MAX_AGE_DAYS;
  const ageDays = (now.getTime() - sourceModifiedAt.getTime()) / DAY_MS;
  return {
    status: ageDays > maxAgeDays ? "stale" : "fresh",
    filename,
    modifiedAt: sourceModifiedAt.toISOString(),
    observedAt: record.createdAt.toISOString(),
    ageDays,
  };
}

export function buildMonthlyServiceDeskReport(
  month: string,
  inputRows: MonthlyServiceDeskJobInput[],
  freshnessRecord: MonthlyAllJobsFreshnessRecord | undefined,
  generatedAt = new Date(),
): MonthlyServiceDeskReport {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("Service Desk report month must use YYYY-MM format");
  }
  const jobs = latestUniqueJobs(inputRows)
    .filter((row) => isInLondonReportMonth(row.completedAt!, month))
    .map((row): ServiceDeskReportJob => ({
      jobRef: row.jobRef,
      jobType: row.jobType,
      category: classifyServiceDeskReportJobType(row.jobType),
      assetRef: row.assetRef,
      site: row.site,
      engineer: row.engineer,
      completedAt: row.completedAt!.toISOString(),
    }));
  const countedByCategory = new Map<ServiceDeskReportJob["category"], Set<string>>();
  const rawTypeCounts = new Map<string, Set<string>>();
  const assetJobs = new Map<string, {
    assetRef: string;
    jobRefs: Set<string>;
    jobTypes: Set<string>;
    sites: Set<string>;
    engineers: Set<string>;
    latestCompletedAt: string;
  }>();

  jobs.forEach((job, index) => {
    const jobKey = job.jobRef?.trim().toLocaleLowerCase() || `${job.completedAt}:${index}`;
    const categoryJobs = countedByCategory.get(job.category) ?? new Set<string>();
    categoryJobs.add(jobKey);
    countedByCategory.set(job.category, categoryJobs);

    const rawType = job.jobType?.trim() || "Not specified";
    const typeJobs = rawTypeCounts.get(rawType) ?? new Set<string>();
    typeJobs.add(jobKey);
    rawTypeCounts.set(rawType, typeJobs);

    if (job.category !== "Service" && job.category !== "Repair") return;
    for (const assetRef of parseServiceDeskReportAssetRefs(job.assetRef)) {
      const assetKey = normalizeAssetKey(assetRef);
      const current = assetJobs.get(assetKey) ?? {
        assetRef,
        jobRefs: new Set<string>(),
        jobTypes: new Set<string>(),
        sites: new Set<string>(),
        engineers: new Set<string>(),
        latestCompletedAt: job.completedAt,
      };
      if (job.jobRef) current.jobRefs.add(job.jobRef);
      if (job.jobType) current.jobTypes.add(job.jobType);
      if (job.site) current.sites.add(job.site);
      if (job.engineer) current.engineers.add(job.engineer);
      if (job.completedAt > current.latestCompletedAt) current.latestCompletedAt = job.completedAt;
      assetJobs.set(assetKey, current);
    }
  });

  const count = (category: ServiceDeskReportJob["category"]) =>
    countedByCategory.get(category)?.size ?? 0;
  const source = readFreshness(freshnessRecord, generatedAt);
  const notes = [
    "Monthly job totals use distinct Joblogic job references completed during the reporting month.",
    "Installations, services, and repairs are grouped from Joblogic job-type text; the original type is retained in the breakdown.",
    "The serviced-assets list includes assets linked to completed service or repair jobs. Missing asset references are not inferred.",
    source.status === "fresh"
      ? `The newest All Jobs report was ${Math.max(0, source.ageDays!).toFixed(1)} days old when this report was generated.`
      : source.status === "stale"
        ? "The newest All Jobs report is stale; this preview must not be used as a complete monthly result."
        : "No successful All Jobs freshness observation is available; this preview may not contain the complete month.",
  ];

  return {
    month,
    monthLabel: serviceDeskReportMonthLabel(month),
    startDate: `${month}-01`,
    endDate: `${month}-${String(new Date(Date.UTC(
      Number(month.slice(0, 4)),
      Number(month.slice(5, 7)),
      0,
    )).getUTCDate()).padStart(2, "0")}`,
    generatedAt: generatedAt.toISOString(),
    source,
    totals: {
      completedJobs: jobs.length,
      installations: count("Installation"),
      services: count("Service"),
      repairs: count("Repair"),
      otherJobs: count("Other") + count("Unclassified"),
      distinctServiceAssets: assetJobs.size,
    },
    jobTypeBreakdown: [...rawTypeCounts.entries()]
      .map(([jobType, refs]) => ({ jobType, jobs: refs.size }))
      .sort((first, second) => second.jobs - first.jobs || first.jobType.localeCompare(second.jobType)),
    assets: [...assetJobs.values()]
      .map((asset) => ({
        assetRef: asset.assetRef,
        jobRefs: [...asset.jobRefs].sort(),
        jobTypes: [...asset.jobTypes].sort(),
        sites: [...asset.sites].sort(),
        engineers: [...asset.engineers].sort(),
        latestCompletedAt: asset.latestCompletedAt,
      }))
      .sort((first, second) => first.assetRef.localeCompare(second.assetRef)),
    jobs,
    notes,
  };
}
