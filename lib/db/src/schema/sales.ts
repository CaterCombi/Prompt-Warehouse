import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const salesDealCache = pgTable("sales_deal_cache", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
  cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
});

export const salesHiddenDeals = pgTable("sales_hidden_deals", {
  dealId: text("deal_id").primaryKey(),
  name: text("name").notNull().default(""),
  hiddenAt: timestamp("hidden_at", { withTimezone: true }).notNull().defaultNow(),
});

export const salesOrder = pgTable("sales_order", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSalesDealCacheSchema = createInsertSchema(salesDealCache);
export const insertSalesHiddenDealSchema = createInsertSchema(salesHiddenDeals);
export const insertSalesOrderSchema = createInsertSchema(salesOrder);
export type SalesDealCache = z.infer<typeof insertSalesDealCacheSchema>;
export type SalesHiddenDeal = z.infer<typeof insertSalesHiddenDealSchema>;
export type SalesOrder = z.infer<typeof insertSalesOrderSchema>;