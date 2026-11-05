import { eq, sql } from "drizzle-orm";

import { utcDayKey } from "lib/cost/breaker";
import { dailySpendTable } from "lib/db/schema";

import type { SpendBreaker } from "lib/cost/breaker";
import type { dbPool } from "lib/db";

/** Database surface required by the spend breaker, narrowed for injection. */
type SpendDb = Pick<typeof dbPool, "select" | "insert">;

/**
 * Drizzle-backed global daily spend breaker.
 *
 * Durable counterpart to the in-memory breaker: the per-UTC-day total lives in
 * one `daily_spend` row, so the ceiling holds across instances and restarts.
 * `record` is an atomic upsert increment (`INSERT ... ON CONFLICT DO UPDATE SET
 * spent_cents = spent_cents + n`), so concurrent generations never lose spend.
 *
 * A ceiling of zero or less disables the breaker (it never trips); the config
 * layer never produces such a value. `isTripped` and `record` propagate a DB
 * error rather than swallowing it, so the breaker fails closed (the managed
 * path, which already requires the DB for the per-user cap, refuses rather than
 * spending blind during a database outage). The residual check-then-spend race
 * is bounded: the Synapse-key hard budget is the true absolute ceiling
 */
export const createDrizzleSpendBreaker = (
  db: SpendDb,
  ceilingCents: number,
): SpendBreaker => {
  const spentTodayCents = async (nowMs = Date.now()) => {
    const [row] = await db
      .select({ cents: dailySpendTable.spentCents })
      .from(dailySpendTable)
      .where(eq(dailySpendTable.day, utcDayKey(nowMs)));
    return row?.cents ?? 0;
  };

  return {
    spentTodayCents,

    async record(amount, nowMs = Date.now()) {
      if (amount <= 0) return;
      const day = utcDayKey(nowMs);
      await db
        .insert(dailySpendTable)
        .values({ day, spentCents: amount })
        .onConflictDoUpdate({
          target: dailySpendTable.day,
          set: {
            spentCents: sql`${dailySpendTable.spentCents} + ${amount}`,
            updatedAt: sql`now()`,
          },
        });
    },

    async isTripped(nowMs = Date.now()) {
      if (ceilingCents <= 0) return false;
      return (await spentTodayCents(nowMs)) >= ceilingCents;
    },
  };
};
