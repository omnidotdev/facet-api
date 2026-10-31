import { and, eq, sql } from "drizzle-orm";

import { utcMonthKey } from "lib/cost/creditStore";
import { creditLedgerTable } from "lib/db/schema";

import type { CreditStore } from "lib/cost/creditStore";
import type { dbPool } from "lib/db";

/** Database surface required by the credit store, narrowed for injection. */
type CreditDb = Pick<typeof dbPool, "select" | "insert">;

/**
 * Drizzle-backed credit store.
 *
 * Thin by design: `getMonthlyUsage` sums a user's ledger rows for the current
 * UTC month and reports them against the configured cap, and `recordSpend`
 * appends one row. All enforcement lives in the route against the `CreditStore`
 * interface, so it is unit-tested with an in-memory fake and this layer only
 * moves rows
 */
export const createDrizzleCreditStore = (
  db: CreditDb,
  capCredits: number,
): CreditStore => ({
  async getMonthlyUsage(userId, nowMs = Date.now()) {
    const month = utcMonthKey(nowMs);

    const [row] = await db
      .select({
        used: sql<number>`coalesce(sum(${creditLedgerTable.credits}), 0)`,
      })
      .from(creditLedgerTable)
      .where(
        and(
          eq(creditLedgerTable.userId, userId),
          eq(creditLedgerTable.month, month),
        ),
      );

    // pg returns the sum as a string, so coerce back to a number
    return { usedCredits: Number(row?.used ?? 0), capCredits };
  },

  async recordSpend(userId, credits, nowMs = Date.now()) {
    if (credits <= 0) return;

    await db.insert(creditLedgerTable).values({
      userId,
      month: utcMonthKey(nowMs),
      credits,
    });
  },
});
