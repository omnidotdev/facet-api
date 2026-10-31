/**
 * Global daily spend breaker.
 *
 * Tracks aggregate managed model spend per UTC day and trips once a configured
 * ceiling is reached, so a bug or abuse upstream cannot run spend past a known
 * bound. In-memory: process-local and reset on restart.
 *
 * Phase C left this in-memory on purpose. The per-user credit meter is the
 * DB-backed layer; this breaker is a coarse global backstop, and backing it
 * cleanly needs an atomic shared daily counter. Worst-case loss is already
 * bounded by the Synapse-key hard budget and the per-user cap.
 * TODO: back this with a shared store (DB or Redis) so the ceiling holds across
 * instances and restarts
 */

export interface SpendBreaker {
  /** Whether spend has reached the ceiling for the current UTC day. */
  isTripped(nowMs?: number): boolean;
  /** Add spend (US cents) to the current UTC day. */
  record(cents: number, nowMs?: number): void;
  /** Spend recorded so far for the current UTC day, in US cents. */
  spentTodayCents(nowMs?: number): number;
}

/** UTC day key, e.g. "2026-10-31". */
const utcDayKey = (nowMs: number): string =>
  new Date(nowMs).toISOString().slice(0, 10);

/**
 * Create an in-memory daily spend breaker. A ceiling of zero or less disables
 * the breaker (it never trips); the config layer never produces such a value
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
    spentTodayCents(nowMs = now()) {
      rollover(nowMs);
      return cents;
    },
    record(amount, nowMs = now()) {
      rollover(nowMs);
      if (amount > 0) cents += amount;
    },
    isTripped(nowMs = now()) {
      if (ceilingCents <= 0) return false;
      rollover(nowMs);
      return cents >= ceilingCents;
    },
  };
};
