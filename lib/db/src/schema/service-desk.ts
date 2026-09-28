import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/** Service Desk data is intentionally isolated from warehouse tables. */
export const serviceDeskTickets = pgTable("service_desk_tickets", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").notNull().unique(),
  subject: text("subject"),
  pipeline: text("pipeline"),
  pipelineStage: text("pipeline_stage"),
  assetRef: text("asset_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  properties: jsonb("properties"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
});

export const serviceDeskJobs = pgTable("service_desk_jobs", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").unique(),
  jobRef: text("job_ref"),
  jobType: text("job_type"),
  assetRef: text("asset_ref"),
  site: text("site"),
  engineer: text("engineer"),
  status: text("status"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  sourceFile: text("source_file"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
});

export const serviceDeskAssets = pgTable("service_desk_assets", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").unique(),
  assetRef: text("asset_ref").notNull(),
  serviceCount: integer("service_count"),
  lastServicedAt: timestamp("last_serviced_at", { withTimezone: true }),
  serviceType: text("service_type"),
  siteId: text("site_id"),
  description: text("description"),
  customer: text("customer"),
  postcode: text("postcode"),
  latitude: text("latitude"),
  longitude: text("longitude"),
  sourceFile: text("source_file"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
});

export const serviceDeskIngestionLog = pgTable("service_desk_ingestion_log", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").unique(),
  source: text("source").notNull(),
  status: text("status").notNull(),
  filesFound: integer("files_found"),
  filesProcessed: integer("files_processed"),
  ticketsImported: integer("tickets_imported"),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export const serviceDeskProcessedFiles = pgTable("service_desk_processed_files", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull().unique(),
  processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
});

export const serviceDeskSites = pgTable("service_desk_sites", {
  siteId: text("site_id").primaryKey(),
  name: text("name"),
  postcode: text("postcode"),
  sourceFile: text("source_file"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }),
});

export const serviceDeskPostcodes = pgTable("service_desk_postcodes", {
  postcode: text("postcode").primaryKey(),
  latitude: text("latitude"),
  longitude: text("longitude"),
  lookedUpAt: timestamp("looked_up_at", { withTimezone: true }),
  failed: integer("failed"),
});

export const serviceDeskLegacyImports = pgTable("service_desk_legacy_imports", {
  sha256: text("sha256").primaryKey(),
  counts: jsonb("counts").notNull(),
  mapReady: integer("map_ready").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertServiceDeskTicketSchema = createInsertSchema(serviceDeskTickets);
export const insertServiceDeskJobSchema = createInsertSchema(serviceDeskJobs);
export type ServiceDeskTicket = typeof serviceDeskTickets.$inferSelect;
export type ServiceDeskJob = typeof serviceDeskJobs.$inferSelect;