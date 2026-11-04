import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { sql } from "drizzle-orm";
import { createTestDatabase } from "test/setup/createTestDatabase";
import {
  cleanupOrphanedContainers,
  startPostgresContainer,
  stopPostgresContainer,
} from "test/setup/startPostgresContainer";

import { createDrizzleCreditStore } from "lib/cost/creditStore.drizzle";
import { creditLedgerTable } from "lib/db/schema";

import type { CapResolver } from "lib/cost/entitlementCap";
import type { TestDatabase } from "test/setup/createTestDatabase";

// The Drizzle credit store is the money path: the per-user monthly cap is
// enforced against what this reads back. The in-memory fake in generate.test.ts
// cannot catch SQL regressions (the month-key filter, the coalesce(sum) and its
// string->number coercion), so exercise the real queries against Postgres here.
//
// Needs Docker for a throwaway Postgres; skip cleanly where it is unavailable so
// the suite still passes on a machine or CI runner without it
const hasDocker = Bun.spawnSync({ cmd: ["docker", "info"] }).exitCode === 0;

/** A timestamp inside a given UTC month, for the month-boundary fixtures. */
const at = (iso: string) => new Date(iso).getTime();

describe.skipIf(!hasDocker)("createDrizzleCreditStore (Postgres)", () => {
  let ctx: TestDatabase;
  // A static cap, so these tests exercise the ledger SQL rather than the Aether
  // entitlement path (covered separately in entitlementCap.test.ts)
  const cap: CapResolver = async () => 100;
  const store = () => createDrizzleCreditStore(ctx.db, cap);

  beforeAll(async () => {
    const container = await startPostgresContainer();
    ctx = await createTestDatabase(container.getConnectionUri());
  });

  afterAll(async () => {
    await ctx?.cleanup();
    await stopPostgresContainer();
    await cleanupOrphanedContainers();
  });

  beforeEach(async () => {
    await ctx.db.delete(creditLedgerTable);
  });

  test("sums a user's spend for the current UTC month, with the resolved cap", async () => {
    const now = at("2026-11-15T00:00:00Z");
    const s = store();
    await s.recordSpend("user-1", 3, now);
    await s.recordSpend("user-1", 7, now);

    const usage = await s.getMonthlyUsage("user-1", now);
    // pg returns the SUM as a string; it must come back as a real number
    expect(usage.usedCredits).toBe(10);
    expect(usage.usedCredits).toBeTypeOf("number");
    expect(usage.capCredits).toBe(100);
  });

  test("reports zero (not NaN) when the user has no rows this month", async () => {
    const usage = await store().getMonthlyUsage(
      "nobody",
      at("2026-11-01T00:00:00Z"),
    );
    expect(usage.usedCredits).toBe(0);
  });

  test("does not count spend recorded in a different UTC month", async () => {
    const s = store();
    await s.recordSpend("user-1", 40, at("2026-10-31T23:00:00Z")); // October
    const usage = await s.getMonthlyUsage("user-1", at("2026-11-01T01:00:00Z")); // November
    expect(usage.usedCredits).toBe(0);
  });

  test("isolates users: one user's spend does not count for another", async () => {
    const now = at("2026-11-10T00:00:00Z");
    const s = store();
    await s.recordSpend("user-1", 25, now);
    expect((await s.getMonthlyUsage("user-2", now)).usedCredits).toBe(0);
  });

  test("ignores non-positive credits, inserting no row", async () => {
    const now = at("2026-11-10T00:00:00Z");
    const s = store();
    await s.recordSpend("user-1", 0, now);
    await s.recordSpend("user-1", -5, now);
    const [row] = await ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(creditLedgerTable);
    expect(Number(row?.n ?? 0)).toBe(0);
  });
});
