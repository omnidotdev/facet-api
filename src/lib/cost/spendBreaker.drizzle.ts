import { utcDayKey } from "@omnidotdev/providers";
import { eq, sql } from "drizzle-orm";

import { dailySpendTable } from "lib/db/schema";

import type { SpendBreaker } from "@omnidotdev/providers";
import type { dbPool } from "lib/db";

/** Database surface required by the spend breaker, narrowed for injection. */
type SpendDb = Pick<typeof dbPool, "select" | "insert">;

/**
 * Drizzle-backed global daily spend breaker, the durable implementation of the
 * shared `SpendBreaker` contract from `@omnidotdev/providers`.
 *
 * Durable counterpart to the shared in-memory breaker: the per-UTC-day total lives in
 * one `daily_spend` row, so the ceiling holds across instances and restarts.
 * `record` is an atomic upsert increment (`INSERT ... ON CONFLICT DO UPDATE SET
 * spent_cents = spent_cents + n`), so concurrent generations never lose spend.
 *
 * Spend is recorded in whole cents rounded UP: real model spend is fractional
 * (e.g. 1.4 cents) but `spent_cents` is an integer column, so an unrounded
 * write is rejected by Postgres and the ceiling would never accumulate.
 * Rounding up keeps the backstop conservative (it trips no later than real
 * spend would)
 *
 * A ceiling of zero or less disables the breaker (it never trips); the config
 * layer never produces such a value. `isTripped` and `record` propagate a DB
 * error rather than swallowing it, so the breaker fails closed (the free-tier
 * managed path refuses rather than spending blind during a database outage).
 * The residual check-then-spend race is bounded: the gateway's credit check
 * against the user's Aether balance is the true per-user ceiling
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
      if (!(amount > 0)) return;
      const cents = Math.ceil(amount);
      const day = utcDayKey(nowMs);
      await db
        .insert(dailySpendTable)
        .values({ day, spentCents: cents })
        .onConflictDoUpdate({
          target: dailySpendTable.day,
          set: {
            spentCents: sql`${dailySpendTable.spentCents} + ${cents}`,
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
