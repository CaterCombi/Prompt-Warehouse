export const SERVICE_DESK_JOB_TYPE_CATEGORIES = [
  "Site survey",
  "Rental installation",
  "Rental repair",
  "Rental full service",
  "Rental collection",
  "Rental upgrade",
  "Sale installation",
  "Sale repair",
] as const;

export type ServiceDeskJobTypeCategory = typeof SERVICE_DESK_JOB_TYPE_CATEGORIES[number];

const key = (value: string) => value
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[‐‑‒–—]/g, "-")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim()
  .replace(/\s+/g, " ");

const aliases = new Map<string, ServiceDeskJobTypeCategory>([
  ["site survey", "Site survey"],
  ["rental installation", "Rental installation"],
  ["rental repair", "Rental repair"],
  ["rental full service", "Rental full service"],
  ["full service", "Rental full service"],
  ["full rental service", "Rental full service"],
  ["rental collection", "Rental collection"],
  ["end of rental hire collection", "Rental collection"],
  ["rental hire debt collection", "Rental collection"],
  ["rental upgrade", "Rental upgrade"],
  ["sale installation", "Sale installation"],
  ["oven sale installation", "Sale installation"],
  ["direct sale", "Sale installation"],
  ["sale repair", "Sale repair"],
  ["oven sale repair", "Sale repair"],
  ["general call out", "Rental repair"],
  ["delivery collection", "Rental installation"],
  ["ultravent installation", "Rental installation"],
  ["engineer in workshop", "Rental repair"],
]);

/**
 * Keeps the Joblogic value in storage, while presenting every historical and
 * current value as one of the eight approved Service Desk chart categories.
 */
export function canonicalServiceDeskJobType(jobType: string | null): ServiceDeskJobTypeCategory {
  const value = jobType?.trim() ?? "";
  const normalized = key(value);
  if (!normalized) return "Rental repair";

  const exact = aliases.get(normalized);
  if (exact) return exact;

  // Handle free-text descriptions left by older schedule imports. Specific
  // sale, collection, and repair signals take precedence over generic service.
  if (/\bdirect sale\b/.test(normalized)) return "Sale installation";
  if (/\bsale\b/.test(normalized) && /\b(repair|broken|fault|replace|replacement)\b/.test(normalized)) {
    return "Sale repair";
  }
  if (/\bsale\b/.test(normalized) && /\b(install|installation|deliver|delivery)\b/.test(normalized)) {
    return "Sale installation";
  }
  if (/\b(collection|collect)\b/.test(normalized)) return "Rental collection";
  if (/\b(install|installation|deliver|delivery|ultravent)\b/.test(normalized)) {
    return "Rental installation";
  }
  if (/\b(repair|broken|fault|replace|replacement|change|issue|workshop|seal|ctu)\b/.test(normalized)) {
    return "Rental repair";
  }
  if (/\b(service|servicing|clean|cleaning|descal\w*|checkup|check up)\b/.test(normalized)) {
    return "Rental full service";
  }

  // Joblogic is being restricted to the approved set; default any remaining
  // legacy or blank value to the general repair bucket so no ninth chart label
  // can appear.
  return "Rental repair";
}