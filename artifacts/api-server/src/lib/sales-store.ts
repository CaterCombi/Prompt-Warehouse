import { db } from "@workspace/db";
import { salesDealCache, salesHiddenDeals, salesOrder } from "@workspace/db/schema";
import { asc, eq } from "drizzle-orm";
import type { NormalizedDeal } from "./hubspot";

export interface DealOrder { salesQuotes: string[]; salesInvoice: string[]; salesDeposit: string[]; rentalDeals: string[]; }
const emptyOrder = (): DealOrder => ({ salesQuotes: [], salesInvoice: [], salesDeposit: [], rentalDeals: [] });
export async function getCache(): Promise<{ deals: NormalizedDeal[]; cachedAt: string } | null> {
  const [row] = await db.select().from(salesDealCache).where(eq(salesDealCache.id, "current"));
  if (!row) return null;
  try { return { deals: JSON.parse(row.data) as NormalizedDeal[], cachedAt: row.cachedAt.toISOString() }; } catch { return null; }
}
export async function setCache(deals: NormalizedDeal[]): Promise<void> {
  await db.insert(salesDealCache).values({ id: "current", data: JSON.stringify(deals), cachedAt: new Date() }).onConflictDoUpdate({ target: salesDealCache.id, set: { data: JSON.stringify(deals), cachedAt: new Date() } });
}
export async function getHiddenDealIds(): Promise<Set<string>> {
  const rows = await db.select({ dealId: salesHiddenDeals.dealId }).from(salesHiddenDeals);
  return new Set(rows.map((x) => x.dealId));
}
export async function getHiddenDeals() {
  const rows = await db.select().from(salesHiddenDeals).orderBy(asc(salesHiddenDeals.hiddenAt));
  return rows.map((x) => ({ dealId: x.dealId, name: x.name }));
}
export async function hideDeal(dealId: string, name: string) {
  await db.insert(salesHiddenDeals).values({ dealId, name }).onConflictDoUpdate({ target: salesHiddenDeals.dealId, set: { name, hiddenAt: new Date() } });
}
export async function unhideDeal(dealId: string) { await db.delete(salesHiddenDeals).where(eq(salesHiddenDeals.dealId, dealId)); }
export async function getOrder(): Promise<DealOrder> {
  const [row] = await db.select().from(salesOrder).where(eq(salesOrder.id, "current"));
  if (!row) return emptyOrder();
  try {
    const p = JSON.parse(row.data) as Partial<DealOrder> & Record<string, string[]>;
    return { salesQuotes: p.salesQuotes ?? [], salesInvoice: p.salesInvoice ?? [], salesDeposit: p.salesDeposit ?? [], rentalDeals: p.rentalDeals ?? [...(p.rentalQuotes ?? []), ...(p.rentalInvoice ?? [])] };
  } catch { return emptyOrder(); }
}
export async function saveOrder(order: DealOrder) {
  await db.insert(salesOrder).values({ id: "current", data: JSON.stringify(order), updatedAt: new Date() }).onConflictDoUpdate({ target: salesOrder.id, set: { data: JSON.stringify(order), updatedAt: new Date() } });
}