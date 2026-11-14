import { integer, pgTable, text } from "drizzle-orm/pg-core";

import { generateDefaultDate } from "lib/db/util";

import type { InferSelectModel } from "drizzle-orm";

/**
 * Global daily spend counter.
 *
 * One row per UTC day holding aggregate free-tier managed model spend in whole
 * US cents (rounded up), so the daily breaker ceiling holds across instances
 * and restarts (unlike the in-memory counter). Real cents, never credits: this
 * is the money-safety backstop below the gateway's per-user credit check.
 * Written with an atomic upsert increment so concurrent requests cannot lose
 * spend
 */
export const dailySpendTable = pgTable("daily_spend", {
  // UTC day the spend counts against, e.g. "2026-11-05"
  day: text().primaryKey(),
  // aggregate free-tier managed model spend for the day, in whole US cents
  spentCents: integer().notNull().default(0),
  updatedAt: generateDefaultDate(),
});

export type SelectDailySpend = InferSelectModel<typeof dailySpendTable>;
