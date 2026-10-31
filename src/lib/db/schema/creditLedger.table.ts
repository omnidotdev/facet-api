import { index, integer, pgTable, text } from "drizzle-orm/pg-core";

import { generateDefaultDate, generateDefaultId } from "lib/db/util";

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

/**
 * Credit ledger.
 *
 * One row per managed generation charge. Monthly usage is the sum of a user's
 * credits for the current UTC month key, so the hard cap resets at the month
 * boundary with no stored running total to drift. 1 credit maps to roughly 1
 * US cent of model spend
 */
export const creditLedgerTable = pgTable(
  "credit_ledger",
  {
    id: generateDefaultId(),
    // identity-provider subject id of the user the spend is billed to
    userId: text().notNull(),
    // UTC month the spend counts against, e.g. "2026-10"
    month: text().notNull(),
    // credits consumed by this generation
    credits: integer().notNull(),
    createdAt: generateDefaultDate(),
  },
  (table) => [index().on(table.userId, table.month)],
);

export type InsertCreditLedger = InferInsertModel<typeof creditLedgerTable>;
export type SelectCreditLedger = InferSelectModel<typeof creditLedgerTable>;
