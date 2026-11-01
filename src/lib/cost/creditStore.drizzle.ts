import { and, eq, sql } from "drizzle-orm";

import { utcMonthKey } from "lib/cost/creditStore";
import { creditLedgerTable } from "lib/db/schema";

import type { CreditStore } from "lib/cost/creditStore";
import type { CapResolver } from "lib/cost/entitlementCap";
import type { dbPool } from "lib/db";

/** Database surface required by the credit store, narrowed for injection. */
type CreditDb = Pick<typeof dbPool, "select" | "insert">;

/**
 * Drizzle-backed credit store.
 *
 * Thin by design: `getMonthlyUsage` sums a user's ledger rows for the current
 * UTC month and reports them against a cap resolved per user, and `recordSpend`
 * appends one row. The cap is tier-aware: `resolveCap` reads the user's
 * `included_credits` entitlement from Aether (see `entitlementCap`) and falls
 * back to the static free cap on any failure, so this layer stays thin and the
 * enforcement logic in the route is unit-tested against the `CreditStore`
 * interface with an in-memory fake
 */
export const createDrizzleCreditStore = (
  db: CreditDb,
  resolveCap: CapResolver,
): CreditStore => ({
  async getMonthlyUsage(userId, nowMs = Date.now()) {
    const month = utcMonthKey(nowMs);

    const capCredits = await resolveCap(userId);

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
