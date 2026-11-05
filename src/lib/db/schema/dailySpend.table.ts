import { integer, pgTable, text } from "drizzle-orm/pg-core";

import { generateDefaultDate } from "lib/db/util";

import type { InferSelectModel } from "drizzle-orm";

/**
 * Global daily spend counter.
 *
 * One row per UTC day holding aggregate managed model spend in US cents, so the
 * global daily breaker ceiling holds across instances and restarts (unlike the
 * in-memory counter). Real cents, never marked-up credits: this is the absolute
 * money-safety backstop below the per-user credit meter. Written with an atomic
 * upsert increment so concurrent requests cannot lose spend
 */
export const dailySpendTable = pgTable("daily_spend", {
  // UTC day the spend counts against, e.g. "2026-11-05"
  day: text().primaryKey(),
  // aggregate managed model spend for the day, in US cents
  spentCents: integer().notNull().default(0),
  updatedAt: generateDefaultDate(),
});

export type SelectDailySpend = InferSelectModel<typeof dailySpendTable>;
