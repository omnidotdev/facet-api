import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { generationJobTable } from "lib/db/schema";

import type { dbPool } from "lib/db";
import type { SelectGenerationJob } from "lib/db/schema";
import type { GenerationRequest } from "lib/routes/generationCore";

/**
 * Durable queue behind background AI generation (`POST /generations`).
 *
 * A job row holds the prompt and, once done, the code, for as long as the user
 * needs them: `dismiss` deletes it, and `purgeExpired` deletes every row past
 * `expiresAt` (`JOB_RETENTION_MS` after it was queued). Every read is scoped to
 * the owning user and hides expired rows even before the purge runs.
 *
 * Claiming is replica-safe: `claimNext` takes the oldest queued row with
 * `FOR UPDATE SKIP LOCKED`, so two workers never run the same job. A claimed
 * job carries its worker's id and a heartbeat; only that worker may finish it,
 * and a job whose heartbeat went stale (its process died) is failed as
 * interrupted by `interruptStale`, never run again (the Synapse call may already
 * have been billed)
 */

/** How long a job (its prompt and result) is kept at most: 24 hours */
export const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The statuses that count toward a user's concurrent-job cap */
const ACTIVE_STATUSES = ["queued", "running"] as const;

type JobDb = Pick<
  typeof dbPool,
  "select" | "insert" | "update" | "delete" | "transaction"
>;

/** A new job: who asked, which workspace pays, and what to generate */
export interface NewGenerationJob {
  userId: string;
  workspaceId: string;
  isPayingCustomer: boolean;
  request: GenerationRequest;
}

/** A finished job's failure: the stable code, user-safe message, and HTTP status */
export interface JobFailure {
  code: string;
  message: string;
  status: number;
}

export type EnqueueResult =
  | { ok: true; job: SelectGenerationJob }
  | { ok: false; reason: "tooManyJobs" };

export interface GenerationJobStore {
  /**
   * Queue a job unless the user already has `maxActive` queued or running. The
   * count and insert run under a per-user transaction lock, so concurrent
   * enqueues cannot slip past the cap
   */
  enqueue: (
    job: NewGenerationJob,
    maxActive: number,
    now?: Date,
  ) => Promise<EnqueueResult>;
  /** The user's unexpired jobs, newest first */
  listForUser: (
    userId: string,
    limit: number,
    now?: Date,
  ) => Promise<SelectGenerationJob[]>;
  /** One of the user's unexpired jobs, or null (another user's reads as absent) */
  getForUser: (
    userId: string,
    id: string,
    now?: Date,
  ) => Promise<SelectGenerationJob | null>;
  /** Delete one of the user's jobs, prompt and code included; false if absent */
  dismiss: (userId: string, id: string) => Promise<boolean>;
  /** Claim the oldest queued job for a worker, or null when none is waiting */
  claimNext: (
    workerId: string,
    now?: Date,
  ) => Promise<SelectGenerationJob | null>;
  /** Refresh the liveness beat of the given jobs this worker is running */
  heartbeat: (workerId: string, ids: string[], now?: Date) => Promise<void>;
  /** Record a worker's job as succeeded; false if it no longer owns it running */
  succeed: (id: string, workerId: string, code: string) => Promise<boolean>;
  /** Record a worker's job as failed; false if it no longer owns it running */
  fail: (id: string, workerId: string, failure: JobFailure) => Promise<boolean>;
  /** Fail every running job whose heartbeat is older than `staleBefore` */
  interruptStale: (staleBefore: Date, failure: JobFailure) => Promise<number>;
  /** Fail every job a worker is still running (its graceful shutdown) */
  interruptWorker: (workerId: string, failure: JobFailure) => Promise<number>;
  /** Delete every job past its expiry, prompt and code included */
  purgeExpired: (now?: Date) => Promise<number>;
}

const iso = (date: Date) => date.toISOString();

export const createGenerationJobStore = (db: JobDb): GenerationJobStore => {
  const t = generationJobTable;

  /** Finish a running job, but only for the worker that owns it */
  const finish = async (
    id: string,
    workerId: string,
    set: Partial<typeof t.$inferInsert>,
  ) => {
    const now = iso(new Date());
    const rows = await db
      .update(t)
      .set({ ...set, finishedAt: now, updatedAt: now })
      .where(
        and(eq(t.id, id), eq(t.workerId, workerId), eq(t.status, "running")),
      )
      .returning({ id: t.id });
    return rows.length > 0;
  };

  const failedWith = (failure: JobFailure, now: string) => ({
    status: "failed" as const,
    errorCode: failure.code,
    errorMessage: failure.message,
    errorStatus: failure.status,
    finishedAt: now,
    updatedAt: now,
  });

  return {
    async enqueue(
      { userId, workspaceId, isPayingCustomer, request },
      maxActive,
      now = new Date(),
    ) {
      return db.transaction(async (tx) => {
        // serialize one user's enqueues so the cap check and insert are atomic
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`generation_job:${userId}`}, 0))`,
        );
        const [active] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(t)
          .where(
            and(
              eq(t.userId, userId),
              inArray(t.status, [...ACTIVE_STATUSES]),
              gt(t.expiresAt, iso(now)),
            ),
          );
        if ((active?.count ?? 0) >= maxActive) {
          return { ok: false as const, reason: "tooManyJobs" as const };
        }

        const [job] = await tx
          .insert(t)
          .values({
            userId,
            workspaceId,
            generationId: request.generationId,
            kind: request.kind,
            prompt: request.prompt,
            priorCode: request.previous?.code ?? request.refine?.code ?? null,
            priorError: request.previous?.error ?? null,
            suggestion: request.refine?.suggestion ?? null,
            attempt: request.attempt,
            isPayingCustomer,
            createdAt: iso(now),
            updatedAt: iso(now),
            expiresAt: iso(new Date(now.getTime() + JOB_RETENTION_MS)),
          })
          .returning();
        return { ok: true as const, job: job! };
      });
    },

    async listForUser(userId, limit, now = new Date()) {
      return db
        .select()
        .from(t)
        .where(and(eq(t.userId, userId), gt(t.expiresAt, iso(now))))
        .orderBy(desc(t.createdAt))
        .limit(limit);
    },

    async getForUser(userId, id, now = new Date()) {
      const [job] = await db
        .select()
        .from(t)
        .where(
          and(eq(t.id, id), eq(t.userId, userId), gt(t.expiresAt, iso(now))),
        );
      return job ?? null;
    },

    async dismiss(userId, id) {
      const rows = await db
        .delete(t)
        .where(and(eq(t.id, id), eq(t.userId, userId)))
        .returning({ id: t.id });
      return rows.length > 0;
    },

    async claimNext(workerId, now = new Date()) {
      const stamp = iso(now);
      const next = db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.status, "queued"), gt(t.expiresAt, stamp)))
        .orderBy(asc(t.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      const [job] = await db
        .update(t)
        .set({
          status: "running",
          workerId,
          startedAt: stamp,
          heartbeatAt: stamp,
          updatedAt: stamp,
        })
        // a scalar `= (subquery)` runs the locking subquery once (an `IN`
        // can be planned as a semi-join that claims more than one row)
        .where(and(sql`${t.id} = (${next})`, eq(t.status, "queued")))
        .returning();
      return job ?? null;
    },

    async heartbeat(workerId, ids, now = new Date()) {
      if (ids.length === 0) return;
      await db
        .update(t)
        .set({ heartbeatAt: iso(now) })
        .where(
          and(
            inArray(t.id, ids),
            eq(t.workerId, workerId),
            eq(t.status, "running"),
          ),
        );
    },

    succeed(id, workerId, code) {
      return finish(id, workerId, { status: "succeeded", resultCode: code });
    },

    fail(id, workerId, failure) {
      return finish(id, workerId, {
        status: "failed",
        errorCode: failure.code,
        errorMessage: failure.message,
        errorStatus: failure.status,
      });
    },

    async interruptStale(staleBefore, failure) {
      const rows = await db
        .update(t)
        .set(failedWith(failure, iso(new Date())))
        .where(
          and(
            eq(t.status, "running"),
            or(isNull(t.heartbeatAt), lt(t.heartbeatAt, iso(staleBefore))),
          ),
        )
        .returning({ id: t.id });
      return rows.length;
    },

    async interruptWorker(workerId, failure) {
      const rows = await db
        .update(t)
        .set(failedWith(failure, iso(new Date())))
        .where(and(eq(t.status, "running"), eq(t.workerId, workerId)))
        .returning({ id: t.id });
      return rows.length;
    },

    async purgeExpired(now = new Date()) {
      const rows = await db
        .delete(t)
        .where(lte(t.expiresAt, iso(now)))
        .returning({ id: t.id });
      return rows.length;
    },
  };
};
