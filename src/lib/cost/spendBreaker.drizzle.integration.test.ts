import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { createTestDatabase } from "test/setup/createTestDatabase";
import {
  cleanupOrphanedContainers,
  startPostgresContainer,
  stopPostgresContainer,
} from "test/setup/startPostgresContainer";

import { createDrizzleSpendBreaker } from "lib/cost/spendBreaker.drizzle";
import { dailySpendTable } from "lib/db/schema";

import type { TestDatabase } from "test/setup/createTestDatabase";

// The Drizzle spend breaker is the absolute money-safety ceiling: it must hold
// across instances and restarts, which the in-memory fake in generate.test.ts
// cannot verify (the atomic upsert increment, the UTC-day key, the across-day
// isolation). Exercise the real queries against Postgres here.
//
// Connect to a Postgres provided by CI (TEST_DATABASE_URL, a `services:` block)
// when present; otherwise spin up a throwaway container with Docker for local
// runs. Skip cleanly when neither exists so the suite still passes without it
const envDbUrl = process.env.TEST_DATABASE_URL;
const hasDocker =
  !envDbUrl && Bun.spawnSync({ cmd: ["docker", "info"] }).exitCode === 0;
const canRun = Boolean(envDbUrl) || hasDocker;

/** A timestamp inside a given UTC day, for the day-boundary fixtures. */
const at = (iso: string) => new Date(iso).getTime();

describe.skipIf(!canRun)("createDrizzleSpendBreaker (Postgres)", () => {
  let ctx: TestDatabase;
  let startedContainer = false;
  // A ceiling of 100 cents, so the trip boundary is exercised directly
  const breaker = () => createDrizzleSpendBreaker(ctx.db, 100);

  beforeAll(async () => {
    let uri = envDbUrl;
    if (!uri) {
      const container = await startPostgresContainer();
      startedContainer = true;
      uri = container.getConnectionUri();
    }
    ctx = await createTestDatabase(uri);
  });

  afterAll(async () => {
    await ctx?.cleanup();
    if (startedContainer) {
      await stopPostgresContainer();
      await cleanupOrphanedContainers();
    }
  });

  beforeEach(async () => {
    await ctx.db.delete(dailySpendTable);
  });

  test("accumulates spend atomically within a UTC day and trips at the ceiling", async () => {
    const now = at("2026-11-15T12:00:00Z");
    const b = breaker();
    await b.record(60, now);
    expect(await b.isTripped(now)).toBe(false);
    await b.record(40, now);
    expect(await b.spentTodayCents(now)).toBe(100);
    expect(await b.isTripped(now)).toBe(true);
  });

  test("concurrent increments do not lose spend (atomic upsert)", async () => {
    const now = at("2026-11-15T12:00:00Z");
    const b = breaker();
    // 20 concurrent 5-cent records must sum to exactly 100, never less
    await Promise.all(Array.from({ length: 20 }, () => b.record(5, now)));
    expect(await b.spentTodayCents(now)).toBe(100);
  });

  test("spend is isolated per UTC day (resets at the day boundary)", async () => {
    const b = breaker();
    await b.record(100, at("2026-11-15T23:30:00Z")); // one day
    expect(await b.isTripped(at("2026-11-15T23:30:00Z"))).toBe(true);
    // the next UTC day starts fresh
    expect(await b.spentTodayCents(at("2026-11-16T00:30:00Z"))).toBe(0);
    expect(await b.isTripped(at("2026-11-16T00:30:00Z"))).toBe(false);
  });

  test("reports zero (not undefined) for a day with no rows", async () => {
    expect(await breaker().spentTodayCents(at("2026-11-01T00:00:00Z"))).toBe(0);
  });

  test("ignores non-positive spend, writing no row", async () => {
    const now = at("2026-11-10T00:00:00Z");
    const b = breaker();
    await b.record(0, now);
    await b.record(-5, now);
    expect(await b.spentTodayCents(now)).toBe(0);
  });

  test("a non-positive ceiling never trips even past recorded spend", async () => {
    const now = at("2026-11-10T00:00:00Z");
    const disabled = createDrizzleSpendBreaker(ctx.db, 0);
    await disabled.record(9999, now);
    expect(await disabled.isTripped(now)).toBe(false);
  });
});
