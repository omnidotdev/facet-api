/**
 * Per-user monthly credit meter.
 *
 * The managed generation path is hard-capped with no overage: a free user can
 * never run up a bill. Usage is keyed on the current UTC month, so the cap
 * resets at the month boundary. A credit is a retail unit, not raw cost: a
 * generation costs `ceil(costCents * markup)` credits (see the COGS markup in
 * ai.config), so the monthly allowance carries gross margin over model spend.
 *
 * The interface is injected like the breaker so the enforcement logic is
 * testable with an in-memory fake, with no database. The Drizzle-backed
 * implementation stays thin behind it (see `creditStore.drizzle.ts`)
 */

export interface MonthlyUsage {
  /** Credits consumed so far this UTC month. */
  usedCredits: number;
  /** Hard cap on credits for this UTC month. */
  capCredits: number;
}

export interface CreditStore {
  /** Credits used this UTC month for a user, with the user's hard cap. */
  getMonthlyUsage(userId: string, nowMs?: number): Promise<MonthlyUsage>;
  /** Record credits spent by a user against the current UTC month. */
  recordSpend(userId: string, credits: number, nowMs?: number): Promise<void>;
}

/** UTC month key, e.g. "2026-10". */
export const utcMonthKey = (nowMs: number): string =>
  new Date(nowMs).toISOString().slice(0, 7);
