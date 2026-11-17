import { ERROR_CODES } from "lib/routes/errorCodes";
import { GENERATE_MESSAGES, runGeneration } from "lib/routes/generationCore";
import { provisionManagedKey } from "lib/routes/managedAccess";

import type { SelectGenerationJob } from "lib/db/schema";
import type {
  GenerationJobStore,
  JobFailure,
} from "lib/jobs/generationJobStore";
import type {
  GenerateReason,
  GenerationCoreDeps,
  GenerationRequest,
} from "lib/routes/generationCore";
import type { ManagedKeyProvisioner } from "lib/synapse/provisioner";

/**
 * In-process worker for background AI generation jobs.
 *
 * Each instance claims queued jobs (replica-safe, see the store) and runs at
 * most `concurrency` at once, doing exactly what the synchronous `/generate`
 * route does through the shared core: provision the user's product-scoped key
 * (never stored with the job), make ONE Synapse call billed by the gateway,
 * extract the code, record non-paying spend, emit telemetry, and capture a
 * consented sample. The result or a user-safe failure is written to the job.
 *
 * A job is never retried automatically: the Synapse call may already have been
 * billed. While a job runs its row carries a heartbeat; a job whose process
 * died (a crash, a redeploy) stops beating and the periodic sweep fails it as
 * `interrupted`, and a graceful shutdown fails its own in-flight jobs at once.
 * The sweep also deletes expired jobs (the 24 hour retention)
 */

export interface GenerationWorkerDeps extends GenerationCoreDeps {
  store: GenerationJobStore;
  /** Product-scoped key provisioner; without it every job fails as unavailable */
  provisioner?: ManagedKeyProvisioner;
  /** Most jobs this instance runs at once */
  concurrency: number;
  /** This process's id, stamped on the jobs it claims */
  workerId?: string;
  /** How often to look for queued jobs when not nudged */
  pollIntervalMs?: number;
  /** How often to refresh the heartbeat of in-flight jobs */
  heartbeatIntervalMs?: number;
  /** A running job whose heartbeat is older than this is interrupted */
  staleAfterMs?: number;
  /** How often to interrupt stale jobs and purge expired ones */
  sweepIntervalMs?: number;
  /** Server-side failure log, never carrying secrets, prompts, or code */
  logFailure?: (reason: string) => void;
}

interface GenerationWorker {
  /** Sweep once, then poll, beat, and sweep on timers */
  start: () => void;
  /** Look for queued jobs now (after an enqueue) */
  notify: () => void;
  /** Claim queued jobs into free slots and start them */
  tick: () => Promise<void>;
  /** Interrupt jobs whose process died and delete expired jobs */
  sweep: (now?: Date) => Promise<void>;
  /** Refresh the heartbeat of every in-flight job */
  beat: (now?: Date) => Promise<void>;
  /** Resolve once no job is in flight (for tests and shutdown) */
  idle: () => Promise<void>;
  /** Stop claiming and fail this instance's in-flight jobs as interrupted */
  stop: () => Promise<void>;
}

/** The failure a job carries for a reason, matching the synchronous route */
const failureFor = (reason: GenerateReason, status: number): JobFailure => ({
  code: ERROR_CODES[reason],
  message: GENERATE_MESSAGES[reason],
  status,
});

/** The failure for a job whose process stopped before it finished */
const INTERRUPTED_FAILURE = failureFor("interrupted", 503);

/** Rebuild the validated request a job was queued with */
const requestFromJob = (job: SelectGenerationJob): GenerationRequest => {
  const base = {
    prompt: job.prompt,
    attempt: job.attempt,
    generationId: job.generationId,
  };
  if (
    job.kind === "repair" &&
    job.priorCode !== null &&
    job.priorError !== null
  ) {
    return {
      ...base,
      kind: "repair",
      previous: { code: job.priorCode, error: job.priorError },
    };
  }
  if (
    job.kind === "refine" &&
    job.priorCode !== null &&
    job.suggestion !== null
  ) {
    return {
      ...base,
      kind: "refine",
      refine: { code: job.priorCode, suggestion: job.suggestion },
    };
  }
  return { ...base, kind: "draft" };
};

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : "unknown error";

const defaultLog = (reason: string): void => {
  // biome-ignore lint/suspicious/noConsole: server-side failure log, no secrets
  console.error(`[generation-worker] ${reason}`);
};

export const createGenerationWorker = (
  deps: GenerationWorkerDeps,
): GenerationWorker => {
  const workerId = deps.workerId ?? crypto.randomUUID();
  const pollIntervalMs = deps.pollIntervalMs ?? 2_000;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 15_000;
  const staleAfterMs = deps.staleAfterMs ?? 60_000;
  const sweepIntervalMs = deps.sweepIntervalMs ?? 60_000;
  const log = deps.logFailure ?? defaultLog;

  const inFlight = new Map<string, Promise<void>>();
  const timers: ReturnType<typeof setInterval>[] = [];
  let ticking = false;
  let stopped = false;
  // a database outage would otherwise log on every poll
  let lastErrorLogAt = 0;
  const logThrottled = (reason: string) => {
    const now = Date.now();
    if (now - lastErrorLogAt < 60_000) return;
    lastErrorLogAt = now;
    log(reason);
  };

  /** Run one claimed job to a recorded result; never throws */
  const run = async (job: SelectGenerationJob): Promise<void> => {
    const finishFailed = (reason: GenerateReason, status: number) =>
      deps.store.fail(job.id, workerId, failureFor(reason, status));

    try {
      if (!deps.provisioner) {
        await finishFailed("unavailable", 503);
        return;
      }
      // the key is provisioned again here, never stored with the job
      const key = await provisionManagedKey(
        deps.provisioner,
        job.userId,
        job.workspaceId,
        log,
      );
      if (!key.ok) {
        await finishFailed(key.reason, key.status);
        return;
      }

      const outcome = await runGeneration(
        deps,
        requestFromJob(job),
        {
          grant: {
            ok: true,
            userId: job.userId,
            workspaceId: job.workspaceId,
            apiKey: key.apiKey,
            isPayingCustomer: job.isPayingCustomer,
          },
        },
        log,
      );
      const recorded = outcome.ok
        ? await deps.store.succeed(job.id, workerId, outcome.code)
        : await finishFailed(outcome.reason, outcome.status);
      if (!recorded) {
        // dismissed or interrupted while running: the result is dropped
        log(`job ${job.id} finished after it was dismissed or interrupted`);
      }
    } catch (err) {
      // an unexpected error (e.g. the database), never a retry: record a
      // generic failure when possible; if even that fails the heartbeat stops
      // and the sweep interrupts the job
      log(`job ${job.id} failed: ${errorText(err)}`);
      await finishFailed("failed", 502).catch((writeErr: unknown) => {
        log(`job ${job.id} could not be marked failed: ${errorText(writeErr)}`);
      });
    }
  };

  const tick = async (): Promise<void> => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      while (!stopped && inFlight.size < deps.concurrency) {
        const job = await deps.store.claimNext(workerId);
        if (!job) break;
        const running = run(job).finally(() => {
          inFlight.delete(job.id);
          // a freed slot may have a queued job waiting
          if (!stopped) void tick();
        });
        inFlight.set(job.id, running);
      }
    } catch (err) {
      logThrottled(`claiming jobs failed: ${errorText(err)}`);
    } finally {
      ticking = false;
    }
  };

  const sweep = async (now = new Date()): Promise<void> => {
    try {
      const interrupted = await deps.store.interruptStale(
        new Date(now.getTime() - staleAfterMs),
        INTERRUPTED_FAILURE,
      );
      if (interrupted > 0) {
        log(`interrupted ${interrupted} job(s) whose worker stopped`);
      }
      await deps.store.purgeExpired(now);
    } catch (err) {
      logThrottled(`job sweep failed: ${errorText(err)}`);
    }
  };

  const beat = async (now = new Date()): Promise<void> => {
    try {
      await deps.store.heartbeat(workerId, [...inFlight.keys()], now);
    } catch (err) {
      logThrottled(`job heartbeat failed: ${errorText(err)}`);
    }
  };

  const idle = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.all([...inFlight.values()]);
    }
  };

  return {
    start() {
      stopped = false;
      void sweep().then(tick);
      const every = (ms: number, fn: () => Promise<void>) => {
        const timer = setInterval(() => void fn(), ms);
        timer.unref?.();
        timers.push(timer);
      };
      every(pollIntervalMs, tick);
      every(heartbeatIntervalMs, () => beat());
      every(sweepIntervalMs, () => sweep());
    },
    notify() {
      void tick();
    },
    tick,
    sweep,
    beat,
    idle,
    async stop() {
      stopped = true;
      for (const timer of timers.splice(0)) clearInterval(timer);
      if (inFlight.size === 0) return;
      // the process is going away: fail its in-flight jobs now rather than
      // leaving them to look alive until their heartbeat goes stale
      try {
        await deps.store.interruptWorker(workerId, INTERRUPTED_FAILURE);
      } catch (err) {
        log(`interrupting in-flight jobs failed: ${errorText(err)}`);
      }
    },
  };
};
