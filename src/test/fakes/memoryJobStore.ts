import { JOB_RETENTION_MS } from "lib/jobs/generationJobStore";

import type { SelectGenerationJob } from "lib/db/schema";
import type { GenerationJobStore } from "lib/jobs/generationJobStore";

/**
 * In-memory stand-in for the Drizzle job store, with the same semantics (cap,
 * owner-only reads, single-claim, owner-only finish, interruption, expiry), so
 * the route and worker are tested without a database. The real SQL is covered
 * by `generationJobStore.integration.test.ts`
 */
export const createMemoryJobStore = () => {
  const rows: SelectGenerationJob[] = [];
  let seq = 0;
  const live = (row: SelectGenerationJob, now: Date) =>
    new Date(row.expiresAt).getTime() > now.getTime();
  const stamp = () => new Date().toISOString();

  const store: GenerationJobStore = {
    async enqueue(
      { userId, workspaceId, isPayingCustomer, request },
      maxActive,
      now = new Date(),
    ) {
      const active = rows.filter(
        (r) =>
          r.userId === userId &&
          (r.status === "queued" || r.status === "running") &&
          live(r, now),
      ).length;
      if (active >= maxActive) return { ok: false, reason: "tooManyJobs" };
      seq += 1;
      const job: SelectGenerationJob = {
        id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
        userId,
        workspaceId,
        generationId: request.generationId,
        kind: request.kind,
        status: "queued",
        prompt: request.prompt,
        priorCode: request.previous?.code ?? request.refine?.code ?? null,
        priorError: request.previous?.error ?? null,
        suggestion: request.refine?.suggestion ?? null,
        attempt: request.attempt,
        isPayingCustomer,
        resultCode: null,
        errorCode: null,
        errorMessage: null,
        errorStatus: null,
        workerId: null,
        heartbeatAt: null,
        startedAt: null,
        finishedAt: null,
        expiresAt: new Date(now.getTime() + JOB_RETENTION_MS).toISOString(),
        createdAt: new Date(now.getTime() + seq).toISOString(),
        updatedAt: now.toISOString(),
      };
      rows.push(job);
      return { ok: true, job: { ...job } };
    },
    async listForUser(userId, limit, now = new Date()) {
      return rows
        .filter((r) => r.userId === userId && live(r, now))
        .sort((a, b) => b.createdAt!.localeCompare(a.createdAt!))
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async getForUser(userId, id, now = new Date()) {
      const row = rows.find(
        (r) => r.id === id && r.userId === userId && live(r, now),
      );
      return row ? { ...row } : null;
    },
    async dismiss(userId, id) {
      const index = rows.findIndex((r) => r.id === id && r.userId === userId);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
    async claimNext(workerId, now = new Date()) {
      const next = rows
        .filter((r) => r.status === "queued" && live(r, now))
        .sort((a, b) => a.createdAt!.localeCompare(b.createdAt!))[0];
      if (!next) return null;
      Object.assign(next, {
        status: "running",
        workerId,
        startedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
      });
      return { ...next };
    },
    async heartbeat(workerId, ids, now = new Date()) {
      for (const r of rows) {
        if (ids.includes(r.id) && r.workerId === workerId && r.status === "running") {
          r.heartbeatAt = now.toISOString();
        }
      }
    },
    async succeed(id, workerId, code) {
      const row = rows.find(
        (r) => r.id === id && r.workerId === workerId && r.status === "running",
      );
      if (!row) return false;
      Object.assign(row, { status: "succeeded", resultCode: code, finishedAt: stamp() });
      return true;
    },
    async fail(id, workerId, failure) {
      const row = rows.find(
        (r) => r.id === id && r.workerId === workerId && r.status === "running",
      );
      if (!row) return false;
      Object.assign(row, {
        status: "failed",
        errorCode: failure.code,
        errorMessage: failure.message,
        errorStatus: failure.status,
        finishedAt: stamp(),
      });
      return true;
    },
    async interruptStale(staleBefore, failure) {
      let count = 0;
      for (const r of rows) {
        if (
          r.status === "running" &&
          (!r.heartbeatAt || new Date(r.heartbeatAt) < staleBefore)
        ) {
          Object.assign(r, {
            status: "failed",
            errorCode: failure.code,
            errorMessage: failure.message,
            errorStatus: failure.status,
            finishedAt: stamp(),
          });
          count += 1;
        }
      }
      return count;
    },
    async interruptWorker(workerId, failure) {
      let count = 0;
      for (const r of rows) {
        if (r.status === "running" && r.workerId === workerId) {
          Object.assign(r, {
            status: "failed",
            errorCode: failure.code,
            errorMessage: failure.message,
            errorStatus: failure.status,
            finishedAt: stamp(),
          });
          count += 1;
        }
      }
      return count;
    },
    async purgeExpired(now = new Date()) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (!live(rows[i]!, now)) rows.splice(i, 1);
      }
      return before - rows.length;
    },
  };

  return { store, rows };
};
