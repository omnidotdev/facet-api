import { Elysia } from "elysia";

import { getAiConfig } from "lib/config/ai.config";
import {
  clientIp,
  errorBody,
  parseGenerationRequest,
} from "lib/routes/generationCore";
import { resolveManagedAccess } from "lib/routes/managedAccess";

import type { RateLimiter } from "lib/cost/rateLimit";
import type { SelectGenerationJob } from "lib/db/schema";
import type { GenerationJobStore } from "lib/jobs/generationJobStore";
import type { GenerationBody } from "lib/routes/generationCore";
import type { ManagedDeps } from "lib/routes/managedAccess";

/**
 * Background AI generation for the managed path.
 *
 * - `POST /generations` runs EVERY gate the synchronous `/generate` runs, in the
 *   same order and with the same error codes (prompt caps, per-IP rate limit,
 *   repair ceiling, then the shared managed gating: sign-in and re-auth, the
 *   limited-preview whitelist, the paying-customer check, the breaker, and key
 *   provisioning), then the per-user concurrent-job cap (429
 *   `too_many_jobs`), and only then queues the job: 202 `{ job }`. The worker
 *   (`generationWorker.ts`) runs it exactly as `/generate` would. BYOK is
 *   refused (400 `bad_input`): a caller's own key is never stored, so it stays
 *   on the synchronous route
 * - `GET /generations` lists the caller's own recent jobs, newest first
 * - `GET /generations/:id` reads one of the caller's jobs (404 otherwise)
 * - `DELETE /generations/:id` dismisses one, deleting its prompt and result
 *   (204; 404 when it is not the caller's)
 *
 * Reads are scoped to the signed-in user and never return another user's job,
 * the workspace id, or the follow-up context; the gateway owns billing, so no
 * credit figure appears either
 */

interface GenerationsDeps extends ManagedDeps {
  rateLimiter: RateLimiter;
  store: GenerationJobStore;
  /** Wake the worker after an enqueue so the job starts without a poll delay */
  onEnqueued?: () => void;
}

/** How many recent jobs a list returns */
const LIST_LIMIT = 20;

/** Job ids are uuids; anything else cannot exist and reads as not found */
const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const logFailure = (reason: string): void => {
  // biome-ignore lint/suspicious/noConsole: server-side failure log, no secrets
  console.error(`[generations] ${reason}`);
};

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : "unknown error";

/**
 * The client's view of a job: what was asked, where it is, and the code or a
 * user-safe failure once it is done
 */
const toPublicJob = (job: SelectGenerationJob) => ({
  id: job.id,
  kind: job.kind,
  status: job.status,
  prompt: job.prompt,
  generationId: job.generationId,
  ...(job.status === "succeeded" && job.resultCode !== null
    ? { code: job.resultCode }
    : {}),
  ...(job.status === "failed"
    ? {
        error: {
          code: job.errorCode,
          message: job.errorMessage,
          status: job.errorStatus,
        },
      }
    : {}),
  createdAt: job.createdAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  expiresAt: job.expiresAt,
});

export const createGenerationsRoute = (deps: GenerationsDeps) => {
  /** The signed-in user's id, or null (the caller answers 401) */
  const signedInUser = async (request: Request) =>
    (await deps.authenticate(request))?.userId ?? null;

  return new Elysia()
    .post("/generations", async ({ body, request, set }) => {
      const cfg = getAiConfig();
      const input = (body ?? {}) as GenerationBody;

      // 1. validate the prompt
      const parsed = parseGenerationRequest(input);
      if (!parsed) {
        set.status = 400;
        return errorBody("badPrompt");
      }

      // 2. a caller's own key is never stored, so BYOK stays synchronous
      if (typeof input.byokKey === "string" && input.byokKey.length > 0) {
        set.status = 400;
        return errorBody("badInput");
      }

      // 3. per-IP rate limit
      if (!deps.rateLimiter.allow(clientIp(request))) {
        set.status = 429;
        return errorBody("rateLimited");
      }

      // 4. per-request repair-attempt ceiling
      if (parsed.attempt > cfg.maxRepairAttempts) {
        set.status = 429;
        return errorBody("repairLimited");
      }

      // 5. the shared managed gating, identical to /generate. The key it
      // provisions proves the plan grants access now; the worker provisions
      // again when the job runs, so no key is ever stored
      const access = await resolveManagedAccess(deps, request, logFailure);
      if (!access.ok) {
        set.status = access.status;
        return errorBody(access.reason);
      }

      // 6. queue it, under the per-user concurrent-job cap
      try {
        const result = await deps.store.enqueue(
          {
            userId: access.userId,
            workspaceId: access.workspaceId,
            isPayingCustomer: access.isPayingCustomer,
            request: parsed,
          },
          cfg.maxActiveJobsPerUser,
        );
        if (!result.ok) {
          set.status = 429;
          return errorBody("tooManyJobs");
        }
        deps.onEnqueued?.();
        set.status = 202;
        return { job: toPublicJob(result.job) };
      } catch (err) {
        logFailure(`enqueue failed: ${errorText(err)}`);
        set.status = 503;
        return errorBody("unavailable");
      }
    })
    .get("/generations", async ({ request, set }) => {
      const userId = await signedInUser(request);
      if (!userId) {
        set.status = 401;
        return errorBody("unauthorized");
      }
      try {
        const jobs = await deps.store.listForUser(userId, LIST_LIMIT);
        return { jobs: jobs.map(toPublicJob) };
      } catch (err) {
        logFailure(`list failed: ${errorText(err)}`);
        set.status = 503;
        return errorBody("unavailable");
      }
    })
    .get("/generations/:id", async ({ params, request, set }) => {
      const userId = await signedInUser(request);
      if (!userId) {
        set.status = 401;
        return errorBody("unauthorized");
      }
      if (!JOB_ID.test(params.id)) {
        set.status = 404;
        return errorBody("notFound");
      }
      try {
        const job = await deps.store.getForUser(userId, params.id);
        if (!job) {
          set.status = 404;
          return errorBody("notFound");
        }
        return { job: toPublicJob(job) };
      } catch (err) {
        logFailure(`read failed: ${errorText(err)}`);
        set.status = 503;
        return errorBody("unavailable");
      }
    })
    .delete("/generations/:id", async ({ params, request, set }) => {
      const userId = await signedInUser(request);
      if (!userId) {
        set.status = 401;
        return errorBody("unauthorized");
      }
      if (!JOB_ID.test(params.id)) {
        set.status = 404;
        return errorBody("notFound");
      }
      try {
        if (!(await deps.store.dismiss(userId, params.id))) {
          set.status = 404;
          return errorBody("notFound");
        }
        set.status = 204;
        return undefined;
      } catch (err) {
        logFailure(`dismiss failed: ${errorText(err)}`);
        set.status = 503;
        return errorBody("unavailable");
      }
    });
};
