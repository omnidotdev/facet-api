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

import { generationJobTable } from "lib/db/schema";
import {
  JOB_RETENTION_MS,
  createGenerationJobStore,
} from "lib/jobs/generationJobStore";

import type { NewGenerationJob } from "lib/jobs/generationJobStore";
import type { TestDatabase } from "test/setup/createTestDatabase";

// The job store is the durable queue: the per-user cap, the replica-safe claim
// (FOR UPDATE SKIP LOCKED), owner-only reads, interruption, and the 24 hour
// retention purge are all real SQL, which the in-memory fake used by the route
// and worker tests cannot verify. Same harness as the spend breaker test:
// TEST_DATABASE_URL when CI provides one, else a throwaway Docker container,
// else skipped
const envDbUrl = process.env.TEST_DATABASE_URL;
const hasDocker =
  !envDbUrl && Bun.spawnSync({ cmd: ["docker", "info"] }).exitCode === 0;
const canRun = Boolean(envDbUrl) || hasDocker;

const job = (
  userId: string,
  overrides: Partial<NewGenerationJob["request"]> = {},
): NewGenerationJob => ({
  userId,
  workspaceId: `ws-${userId}`,
  isPayingCustomer: true,
  request: {
    prompt: "a 10mm cube",
    kind: "draft",
    attempt: 0,
    generationId: crypto.randomUUID(),
    ...overrides,
  },
});

const FAILURE = { code: "interrupted", message: "Interrupted.", status: 503 };

describe.skipIf(!canRun)("createGenerationJobStore (Postgres)", () => {
  let ctx: TestDatabase;
  let startedContainer = false;
  const store = () => createGenerationJobStore(ctx.db);

  beforeAll(async () => {
    let uri = envDbUrl;
    if (!uri) {
      const container = await startPostgresContainer();
      startedContainer = true;
      uri = container.getConnectionUri();
    }
    ctx = await createTestDatabase(uri);
    // a cold container start can outlast the default hook timeout
  }, 60_000);

  afterAll(async () => {
    await ctx?.cleanup();
    if (startedContainer) {
      await stopPostgresContainer();
      await cleanupOrphanedContainers();
    }
  });

  beforeEach(async () => {
    await ctx.db.delete(generationJobTable);
  });

  test("enqueue stores a queued job with the follow-up context and a 24 hour expiry", async () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const result = await store().enqueue(
      job("u1", {
        kind: "repair",
        previous: { code: "bad()", error: "boom" },
        attempt: 1,
      }),
      3,
      now,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.status).toBe("queued");
    expect(result.job.kind).toBe("repair");
    expect(result.job.priorCode).toBe("bad()");
    expect(result.job.priorError).toBe("boom");
    expect(result.job.attempt).toBe(1);
    expect(new Date(result.job.expiresAt).getTime()).toBe(
      now.getTime() + JOB_RETENTION_MS,
    );
  });

  test("refuses a user past the active cap, even when enqueues race", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => store().enqueue(job("u1"), 3)),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "tooManyJobs" },
      { ok: false, reason: "tooManyJobs" },
      { ok: false, reason: "tooManyJobs" },
    ]);
    // another user is unaffected by u1's cap
    expect((await store().enqueue(job("u2"), 3)).ok).toBe(true);
  });

  test("finished jobs free a slot under the cap", async () => {
    const s = store();
    for (let i = 0; i < 3; i += 1) await s.enqueue(job("u1"), 3);
    const claimed = await s.claimNext("w1");
    await s.succeed(claimed!.id, "w1", "return cube(1);");

    expect((await s.enqueue(job("u1"), 3)).ok).toBe(true);
  });

  test("concurrent claims never hand the same job to two workers", async () => {
    const s = store();
    for (let i = 0; i < 5; i += 1) await s.enqueue(job(`u${i}`), 3);

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => s.claimNext(`w${i}`)),
    );
    const ids = claims.filter((c) => c !== null).map((c) => c!.id);

    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  test("claims the oldest queued job first and marks it running for the worker", async () => {
    const s = store();
    const first = await s.enqueue(
      job("u1"),
      3,
      new Date("2026-11-17T12:00:00Z"),
    );
    await s.enqueue(job("u1"), 3, new Date("2026-11-17T12:00:05Z"));

    const claimed = await s.claimNext("w1", new Date("2026-11-17T12:00:10Z"));

    expect(first.ok && claimed?.id === first.job.id).toBe(true);
    expect(claimed?.status).toBe("running");
    expect(claimed?.workerId).toBe("w1");
    expect(claimed?.heartbeatAt).not.toBeNull();
  });

  test("only the owning worker can finish a job", async () => {
    const s = store();
    await s.enqueue(job("u1"), 3);
    const claimed = await s.claimNext("w1");

    expect(await s.succeed(claimed!.id, "w2", "x")).toBe(false);
    expect(await s.succeed(claimed!.id, "w1", "return cube(1);")).toBe(true);
    // a finished job cannot be finished again
    expect(await s.fail(claimed!.id, "w1", FAILURE)).toBe(false);

    const row = await s.getForUser("u1", claimed!.id);
    expect(row?.status).toBe("succeeded");
    expect(row?.resultCode).toBe("return cube(1);");
    expect(row?.finishedAt).not.toBeNull();
  });

  test("reads are owner-only, newest first, and hide expired jobs", async () => {
    const s = store();
    const older = await s.enqueue(
      job("u1"),
      3,
      new Date("2026-11-17T10:00:00Z"),
    );
    const newer = await s.enqueue(
      job("u1"),
      3,
      new Date("2026-11-17T11:00:00Z"),
    );
    await s.enqueue(job("u2"), 3, new Date("2026-11-17T11:30:00Z"));
    const at = new Date("2026-11-17T12:00:00Z");

    const list = await s.listForUser("u1", 20, at);
    expect(list.map((j) => j.id)).toEqual([
      newer.ok ? newer.job.id : "",
      older.ok ? older.job.id : "",
    ]);
    expect(list.every((j) => j.userId === "u1")).toBe(true);

    const id = older.ok ? older.job.id : "";
    expect(await s.getForUser("u2", id, at)).toBeNull();
    expect((await s.getForUser("u1", id, at))?.id).toBe(id);

    // a day after the older job was queued it reads as gone, before any purge
    const later = new Date(
      new Date("2026-11-17T10:00:00Z").getTime() + JOB_RETENTION_MS,
    );
    expect(await s.getForUser("u1", id, later)).toBeNull();
    expect(await s.listForUser("u1", 20, later)).toHaveLength(1);
  });

  test("dismiss deletes only the owner's job", async () => {
    const s = store();
    const queued = await s.enqueue(job("u1"), 3);
    const id = queued.ok ? queued.job.id : "";

    expect(await s.dismiss("u2", id)).toBe(false);
    expect(await s.dismiss("u1", id)).toBe(true);
    expect(await ctx.db.select().from(generationJobTable)).toHaveLength(0);
  });

  test("interruptStale fails running jobs whose heartbeat went stale, never live ones", async () => {
    const s = store();
    await s.enqueue(job("u1"), 3);
    await s.enqueue(job("u2"), 3);
    await s.enqueue(job("u3"), 3);
    const dead = await s.claimNext("w-dead", new Date("2026-11-17T12:00:00Z"));
    const live = await s.claimNext("w-live", new Date("2026-11-17T12:00:00Z"));
    await s.heartbeat("w-live", [live!.id], new Date("2026-11-17T12:02:00Z"));

    const count = await s.interruptStale(
      new Date("2026-11-17T12:01:00Z"),
      FAILURE,
    );

    expect(count).toBe(1);
    const rows = await ctx.db.select().from(generationJobTable);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(dead!.id)?.status).toBe("failed");
    expect(byId.get(dead!.id)?.errorCode).toBe("interrupted");
    expect(byId.get(live!.id)?.status).toBe("running");
    // the queued job is untouched and is not re-run by the interruption
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(1);
  });

  test("interruptWorker fails only that worker's running jobs", async () => {
    const s = store();
    await s.enqueue(job("u1"), 3);
    await s.enqueue(job("u2"), 3);
    const mine = await s.claimNext("w1");
    const theirs = await s.claimNext("w2");

    expect(await s.interruptWorker("w1", FAILURE)).toBe(1);
    expect((await s.getForUser(mine!.userId, mine!.id))?.status).toBe("failed");
    expect((await s.getForUser(theirs!.userId, theirs!.id))?.status).toBe(
      "running",
    );
  });

  test("purgeExpired deletes every row past its expiry, prompt and code included", async () => {
    const s = store();
    const queuedAt = new Date("2026-11-17T12:00:00Z");
    await s.enqueue(job("u1"), 3, queuedAt);
    await s.enqueue(job("u2"), 3, new Date("2026-11-17T13:00:00Z"));
    const claimed = await s.claimNext("w1", queuedAt);
    await s.succeed(claimed!.id, "w1", "return cube(1);");

    const purged = await s.purgeExpired(
      new Date(queuedAt.getTime() + JOB_RETENTION_MS),
    );

    expect(purged).toBe(1);
    const rows = await ctx.db.select().from(generationJobTable);
    expect(rows.map((r) => r.userId)).toEqual(["u2"]);
  });
});
