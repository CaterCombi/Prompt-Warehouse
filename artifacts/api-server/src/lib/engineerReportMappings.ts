import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineerReportChecklistCheck, EngineerReportPart } from "@workspace/api-zod";
import { z } from "zod";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = [
  resolve(MODULE_DIR, "../config"),
  resolve(MODULE_DIR, "../../config"),
  resolve(process.cwd(), "config"),
].find((directory) => existsSync(directory)) ?? resolve(process.cwd(), "config");

const checklistFileSchema = z.object({
  checks: z.array(
    z.object({
      number: z.number().int().min(1).max(57),
      category: z.string().min(1),
      label: z.string().min(1),
      gasOnly: z.boolean().optional(),
    }),
  ).length(57),
});

const partMappingFileSchema = z.object({
  abbreviations: z.record(z.string(), z.string()),
  descriptionOverrides: z.record(z.string(), z.string()),
  rules: z.array(
    z.object({
      keywords: z.array(z.string().min(1)).min(1),
      checks: z.array(z.number().int().min(1).max(57)),
      exclude: z.array(z.string()).optional(),
    }),
  ),
});

export const checklistConfig = checklistFileSchema.parse(
  JSON.parse(readFileSync(resolve(CONFIG_DIR, "engineer-report-checklist.json"), "utf8")),
);
const partMappingConfig = partMappingFileSchema.parse(
  JSON.parse(readFileSync(resolve(CONFIG_DIR, "engineer-report-part-mapping.json"), "utf8")),
);

export type PartPrice = { partNumber: string; description: string };
export type PartPriceIndex = {
  byNumber: Map<string, PartPrice>;
  byDescription: Map<string, PartPrice[]>;
};

export function normalizeHeader(value: unknown): string {
  return String(value ?? "").toLocaleLowerCase("en-GB").replace(/\s+/g, " ").trim();
}

function normalizedDescription(value: string, partNumber: string | null): string {
  const override = partNumber ? partMappingConfig.descriptionOverrides[partNumber] : undefined;
  let description = (override ?? value).replace(/\s+/g, " ").trim();
  const abbreviations = Object.entries(partMappingConfig.abbreviations).sort(
    ([left], [right]) => right.length - left.length,
  );
  for (const [abbreviation, replacement] of abbreviations) {
    const escaped = abbreviation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    description = description.replace(new RegExp(escaped, "gi"), replacement);
  }
  if (description) {
    description = description[0].toLocaleUpperCase("en-GB") + description.slice(1);
  }
  return description;
}

export function matchChecks(description: string): number[] {
  const searchable = normalizeHeader(description);
  const checks = new Set<number>();
  for (const rule of partMappingConfig.rules) {
    const matches = rule.keywords.some((keyword) => searchable.includes(normalizeHeader(keyword)));
    const excluded = (rule.exclude ?? []).some((keyword) => searchable.includes(normalizeHeader(keyword)));
    if (matches && !excluded) {
      for (const number of rule.checks) checks.add(number);
    }
  }
  return [...checks].sort((left, right) => left - right);
}

export function mapParts(rawValues: unknown[], priceIndex: PartPriceIndex): EngineerReportPart[] {
  const grouped = new Map<string, { description: string; partNumber: string | null; quantity: number }>();
  for (const value of rawValues) {
    if (value === null || value === undefined) continue;
    const raw = String(value).trim();
    if (!raw) continue;
    const codeMatch = priceIndex.byNumber.get(raw.toLocaleLowerCase("en-GB"));
    const descriptionMatches = codeMatch
      ? []
      : priceIndex.byDescription.get(normalizeHeader(raw)) ?? [];
    const uniqueDescriptionMatch = descriptionMatches.length === 1 ? descriptionMatches[0] : undefined;
    const partNumber =
      codeMatch?.partNumber ??
      uniqueDescriptionMatch?.partNumber ??
      (/^[A-Z0-9][A-Z0-9.-]{3,}$/i.test(raw) ? raw : null);
    const description = normalizedDescription(
      codeMatch?.description ?? uniqueDescriptionMatch?.description ?? raw,
      partNumber,
    );
    const key = partNumber
      ? `part:${partNumber.toLocaleLowerCase("en-GB")}`
      : `description:${normalizeHeader(description)}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity += 1;
    } else {
      grouped.set(key, { description, partNumber, quantity: 1 });
    }
  }

  return [...grouped.values()].map((part) => {
    const matchedChecks = matchChecks(part.description);
    return { ...part, matchedChecks, matched: matchedChecks.length > 0 };
  });
}

export function buildChecks(parts: EngineerReportPart[], fuelType: string | null): EngineerReportChecklistCheck[] {
  const normalizedFuel = normalizeHeader(fuelType ?? "");
  const isElectric = /^(electric|electricity)$/.test(normalizedFuel);
  const isGas = /^(gas|ng|lpg|natural gas|propane|butane)$/.test(normalizedFuel);

  return checklistConfig.checks.map((check) => {
    const relatedParts = parts.filter((part) => part.matchedChecks.includes(check.number));
    const notes = relatedParts.length
      ? `Part replaced: ${[...new Set(relatedParts.map((part) => part.description))].join(", ")}`
      : "";

    if (check.gasOnly) {
      if (isElectric) {
        return { number: check.number, category: check.category, label: check.label, pass: false, fail: false, notApplicable: true, notes: "" };
      }
      if (isGas) {
        return { number: check.number, category: check.category, label: check.label, pass: relatedParts.length === 0, fail: false, notApplicable: false, notes };
      }
      return { number: check.number, category: check.category, label: check.label, pass: false, fail: false, notApplicable: false, notes: "Gas only: confirm fuel type" };
    }

    return {
      number: check.number,
      category: check.category,
      label: check.label,
      pass: relatedParts.length === 0,
      fail: false,
      notApplicable: false,
      notes,
    };
  });
}