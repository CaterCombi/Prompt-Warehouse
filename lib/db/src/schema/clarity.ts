import { jsonb, integer, pgTable, serial, date, timestamp, text, uniqueIndex } from "drizzle-orm/pg-core";

export const claritySnapshots = pgTable(
  "clarity_snapshots",
  {
    id: serial("id").primaryKey(),
    snapshotDate: date("snapshot_date").notNull(),
    numOfDays: integer("num_of_days").notNull(),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
    source: text("source").default("microsoft_clarity").notNull(),
  },
  (table) => ({
    snapshotDateUnique: uniqueIndex("clarity_snapshots_snapshot_date_unique").on(table.snapshotDate),
  }),
);

export type ClaritySnapshotRecord = typeof claritySnapshots.$inferSelect;