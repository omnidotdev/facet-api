/**
 * Global daily spend breaker.
 *
 * Tracks aggregate managed model spend per UTC day and trips once a configured
 * ceiling is reached, so a bug or abuse upstream cannot run spend past a known
 * bound. Real cents, never marked-up credits: this is the absolute money-safety
 * ceiling below the per-user credit meter.
 *
 * The interface is injected like the credit store so the enforcement logic is
 * testable with an in-memory fake, with no database. Two implementations sit
 * behind it: the in-memory one here (used in tests, and as a DB-less fallback),
 * and the durable Postgres-backed one in `spendBreaker.drizzle.ts`, whose
 * shared daily counter holds the ceiling across instances and restarts.
 */

export interface SpendBreaker {
  /** Whether spend has reached the ceiling for the current UTC day. */
  isTripped(nowMs?: number): Promise<boolean>;
  /** Add spend (US cents) to the current UTC day. */
  record(cents: number, nowMs?: number): Promise<void>;
  /** Spend recorded so far for the current UTC day, in US cents. */
  spentTodayCents(nowMs?: number): Promise<number>;
}

/** UTC day key, e.g. "2026-10-31". */
export const utcDayKey = (nowMs: number): string =>
  new Date(nowMs).toISOString().slice(0, 10);

/**
 * Create an in-memory daily spend breaker. A ceiling of zero or less disables
 * the breaker (it never trips); the config layer never produces such a value.
 *
 * Process-local and reset on restart, so the ceiling does not hold across
 * instances: use `createDrizzleSpendBreaker` wherever the DB is available. This
 * fake exists for tests and as a safe fallback when the database is unreachable
 */
export const createSpendBreaker = (ceilingCents: number): SpendBreaker => {
  let day = "";
  let cents = 0;

  const rollover = (nowMs: number) => {
    const key = utcDayKey(nowMs);
    if (key !== day) {
      day = key;
      cents = 0;
    }
  };

  const now = () => Date.now();

  return {
    async spentTodayCents(nowMs = now()) {
      rollover(nowMs);
      return cents;
    },
    async record(amount, nowMs = now()) {
      rollover(nowMs);
      if (amount > 0) cents += amount;
    },
    async isTripped(nowMs = now()) {
      if (ceilingCents <= 0) return false;
      rollover(nowMs);
      return cents >= ceilingCents;
    },
  };
};
