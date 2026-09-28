import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const marketingRecommendationOverrides = pgTable("marketing_recommendation_overrides", {
  recommendationId: text("recommendation_id").primaryKey(),
  status: text("status").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMarketingRecommendationOverrideSchema = createInsertSchema(marketingRecommendationOverrides);
export type MarketingRecommendationOverride = z.infer<typeof insertMarketingRecommendationOverrideSchema>;