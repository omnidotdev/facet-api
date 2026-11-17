import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  SynapseProvisionError,
  SynapseRequestError,
} from "@omnidotdev/providers/ai";
import { createMemoryJobStore } from "test/fakes/memoryJobStore";

import { createGenerationWorker } from "lib/jobs/generationWorker";

import type { SpendBreaker } from "@omnidotdev/providers";
import type { NewGenerationJob } from "lib/jobs/generationJobStore";
import type { GenerationWorkerDeps } from "lib/jobs/generationWorker";

const CODE = "const part = cube(10);\nreturn part;";
const FENCED = `Here you go:\n\`\`\`ts\n${CODE}\n\`\`\``;

type Caller = GenerationWorkerDeps["callSynapse"];
type CallInput = Parameters<Caller>[0];

const makeCaller = (text = FENCED, outputTokens = 50) => {
  const calls: CallInput[] = [];
  const caller = (async (input: CallInput) => {
    calls.push(input);
    return {
      text,
      usage: { inputTokens: 100, outputTokens, costCents: 1.4 },
    };
  }) as Caller;
  return { caller, calls };
};

/** A caller whose calls stay pending until released, to observe concurrency */
const makeGatedCaller = () => {
  const releases: (() => void)[] = [];
  let calls = 0;
  const caller = (async () => {
    calls += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    return {
      text: FENCED,
      usage: { inputTokens: 1, outputTokens: 1, costCents: 0 },
    };
  }) as Caller;
  return {
    caller,
    calls: () => calls,
    releaseAll: () => {
      for (const release of releases.splice(0)) release();
    },
  };
};

const makeBreaker = () => {
  const recorded: number[] = [];
  const breaker: SpendBreaker = {
    async isTripped() {
      return false;
    },
    async record(amount) {
      recorded.push(amount);
    },
    async spentTodayCents() {
      return 0;
    },
  };
  return { breaker, recorded };
};

const makeProvisioner = () => {
  const calls: unknown[][] = [];
  return {
    calls,
    provisioner: {
      async resolveKey(...args: unknown[]) {
        calls.push(args);
        return `sk-scoped-${args[0]}`;
      },
    },
  };
};

const newJob = (
  userId = "user-1",
  overrides: Partial<NewGenerationJob> = {},
  request: Partial<NewGenerationJob["request"]> = {},
): NewGenerationJob => ({
  userId,
  workspaceId: `ws-${userId}`,
  isPayingCustomer: true,
  ...overrides,
  request: {
    prompt: "a 10mm cube",
    kind: "draft",
    attempt: 0,
    generationId: "gen-1",
    ...request,
  },
});

const setup = (overrides: Partial<GenerationWorkerDeps> = {}) => {
  const memory = createMemoryJobStore();
  const { breaker, recorded } = makeBreaker();
  const { provisioner, calls: provisionCalls } = makeProvisioner();
  const logs: string[] = [];
  const worker = createGenerationWorker({
    store: memory.store,
    callSynapse: makeCaller().caller,
    breaker,
    provisioner,
    concurrency: 2,
    workerId: "w1",
    logFailure: (reason) => logs.push(reason),
    ...overrides,
  });
  return { ...memory, worker, recorded, provisionCalls, logs };
};

const ENV_KEYS = ["MAX_OUTPUT_TOKENS"] as const;
let snapshot: Record<string, string | undefined> = {};
beforeEach(() => {
  snapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe("generation worker", () => {
  test("runs a queued job with a freshly provisioned key and stores the code", async () => {
    const { caller, calls } = makeCaller();
    const { store, rows, worker, provisionCalls } = setup({
      callSynapse: caller,
    });
    await store.enqueue(newJob(), 3);

    await worker.tick();
    await worker.idle();

    expect(provisionCalls).toEqual([
      [
        "user-1",
        undefined,
        { entityType: "organization", entityId: "ws-user-1" },
      ],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.apiKey).toBe("sk-scoped-user-1");
    expect(rows[0]!.status).toBe("succeeded");
    expect(rows[0]!.resultCode).toBe(CODE);
    expect(rows[0]!.finishedAt).not.toBeNull();
  });

  test("emits the same usage event and consented sample as the synchronous route", async () => {
    const emitted: {
      type: string;
      correlationId?: string;
      subject?: string;
    }[] = [];
    const captured: { generationId: string; userId: string; code: string }[] =
      [];
    const { store, worker } = setup({
      events: {
        async emit(event) {
          emitted.push(event);
        },
      },
      samples: {
        async capture(sample) {
          captured.push(sample);
        },
      },
    });
    await store.enqueue(newJob(), 3);

    await worker.tick();
    await worker.idle();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "facet.generation.completed",
      correlationId: "gen-1",
      subject: "user-1",
    });
    expect(captured).toEqual([
      expect.objectContaining({
        generationId: "gen-1",
        userId: "user-1",
        code: CODE,
      }),
    ]);
  });

  test("a repair job sends the prior code and its error back to the model", async () => {
    const { caller, calls } = makeCaller();
    const { store, worker } = setup({ callSynapse: caller });
    await store.enqueue(
      newJob(
        "user-1",
        {},
        {
          kind: "repair",
          previous: { code: "broken()", error: "kernel boom" },
          attempt: 1,
        },
      ),
      3,
    );

    await worker.tick();
    await worker.idle();

    const conversation = JSON.stringify(calls[0]!.messages);
    expect(conversation).toContain("broken()");
    expect(conversation).toContain("kernel boom");
  });

  test("a refine job sends the prior code and the critic's suggestion", async () => {
    const { caller, calls } = makeCaller();
    const { store, worker } = setup({ callSynapse: caller });
    await store.enqueue(
      newJob(
        "user-1",
        {},
        {
          kind: "refine",
          refine: { code: "cube(1)", suggestion: "make it taller" },
        },
      ),
      3,
    );

    await worker.tick();
    await worker.idle();

    const conversation = JSON.stringify(calls[0]!.messages);
    expect(conversation).toContain("cube(1)");
    expect(conversation).toContain("make it taller");
  });

  test("runs at most `concurrency` jobs at once and picks up the rest as slots free", async () => {
    const gated = makeGatedCaller();
    const { store, rows, worker } = setup({
      callSynapse: gated.caller,
      concurrency: 2,
    });
    for (let i = 0; i < 3; i += 1) await store.enqueue(newJob(`u${i}`), 3);

    await worker.tick();
    // let the claimed jobs reach the gateway call
    await Bun.sleep(5);
    expect(gated.calls()).toBe(2);
    expect(rows.filter((r) => r.status === "running")).toHaveLength(2);
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(1);

    gated.releaseAll();
    await Bun.sleep(5);
    gated.releaseAll();
    await worker.idle();

    expect(gated.calls()).toBe(3);
    expect(rows.every((r) => r.status === "succeeded")).toBe(true);
  });

  test("a gateway refusal fails the job with the synchronous route's code and status, without a retry", async () => {
    const calls: unknown[] = [];
    const caller = (async (input: unknown) => {
      calls.push(input);
      throw new SynapseRequestError("synapse request failed: status 402", 402);
    }) as Caller;
    const { store, rows, worker } = setup({ callSynapse: caller });
    await store.enqueue(newJob(), 3);

    await worker.tick();
    await worker.idle();
    await worker.tick();

    expect(calls).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      errorCode: "out_of_credits",
      errorStatus: 402,
    });
    expect(rows[0]!.errorMessage).toContain("out of AI credits");
  });

  test("a reply without code fails as no_code, and a cut-off reply as truncated", async () => {
    process.env.MAX_OUTPUT_TOKENS = "100";
    const noCode = setup({ callSynapse: makeCaller("I cannot.", 10).caller });
    await noCode.store.enqueue(newJob(), 3);
    await noCode.worker.tick();
    await noCode.worker.idle();
    expect(noCode.rows[0]).toMatchObject({
      status: "failed",
      errorCode: "no_code",
      errorStatus: 422,
    });

    const cut = setup({ callSynapse: makeCaller("thinking...", 100).caller });
    await cut.store.enqueue(newJob(), 3);
    await cut.worker.tick();
    await cut.worker.idle();
    expect(cut.rows[0]).toMatchObject({
      status: "failed",
      errorCode: "truncated",
    });
  });

  test("a plan refusal at provisioning fails the job before any gateway call", async () => {
    const { caller, calls } = makeCaller();
    const { store, rows, worker } = setup({
      callSynapse: caller,
      provisioner: {
        async resolveKey() {
          throw new SynapseProvisionError("no api access", 403);
        },
      },
    });
    await store.enqueue(newJob(), 3);

    await worker.tick();
    await worker.idle();

    expect(calls).toHaveLength(0);
    expect(rows[0]).toMatchObject({
      status: "failed",
      errorCode: "plan_required",
      errorStatus: 403,
    });
  });

  test("without provisioning every job fails as unavailable", async () => {
    const { store, rows, worker } = setup({ provisioner: undefined });
    await store.enqueue(newJob(), 3);

    await worker.tick();
    await worker.idle();

    expect(rows[0]).toMatchObject({
      status: "failed",
      errorCode: "unavailable",
      errorStatus: 503,
    });
  });

  test("records a non-paying job's spend on the breaker, never a paying one's", async () => {
    const paying = setup();
    await paying.store.enqueue(newJob("payer"), 3);
    await paying.worker.tick();
    await paying.worker.idle();
    expect(paying.recorded).toEqual([]);

    const free = setup();
    await free.store.enqueue(newJob("free", { isPayingCustomer: false }), 3);
    await free.worker.tick();
    await free.worker.idle();
    expect(free.recorded).toEqual([1.4]);
  });

  test("an unexpected error records a generic failure instead of leaving the job running", async () => {
    const { store, rows, worker, logs } = setup({
      provisioner: {
        resolveKey: async () => "sk",
      },
      callSynapse: makeCaller().caller,
    });
    await store.enqueue(newJob(), 3);
    const succeed = store.succeed;
    store.succeed = async () => {
      throw new Error("db write failed");
    };

    await worker.tick();
    await worker.idle();
    store.succeed = succeed;

    expect(rows[0]).toMatchObject({ status: "failed", errorCode: "failed" });
    expect(logs.some((l) => l.includes("db write failed"))).toBe(true);
  });

  test("a job dismissed while running drops its result", async () => {
    const gated = makeGatedCaller();
    const { store, rows, worker } = setup({ callSynapse: gated.caller });
    const queued = await store.enqueue(newJob(), 3);
    await worker.tick();
    await Bun.sleep(5);

    await store.dismiss("user-1", queued.ok ? queued.job.id : "");
    gated.releaseAll();
    await worker.idle();

    expect(rows).toHaveLength(0);
  });

  describe("restarts and retention", () => {
    test("the sweep fails a dead worker's running job as interrupted and never re-runs it", async () => {
      const { caller, calls } = makeCaller();
      const { store, rows, worker } = setup({ callSynapse: caller });
      await store.enqueue(newJob(), 3);
      // a previous process claimed it and died a while ago
      await store.claimNext("w-dead", new Date(Date.now() - 5 * 60_000));

      await worker.sweep();
      await worker.tick();
      await worker.idle();

      expect(rows[0]).toMatchObject({
        status: "failed",
        errorCode: "interrupted",
        errorMessage: "Generation was interrupted. Try again.",
      });
      expect(calls).toHaveLength(0);
    });

    test("the sweep leaves a job whose worker is still beating", async () => {
      const gated = makeGatedCaller();
      const { store, rows, worker } = setup({
        callSynapse: gated.caller,
        staleAfterMs: 60_000,
      });
      await store.enqueue(newJob(), 3);
      await worker.tick();
      await Bun.sleep(5);

      await worker.beat(new Date(Date.now() + 120_000));
      await worker.sweep(new Date(Date.now() + 150_000));

      expect(rows[0]!.status).toBe("running");
      gated.releaseAll();
      await worker.idle();
      expect(rows[0]!.status).toBe("succeeded");
    });

    test("stop fails this instance's in-flight jobs as interrupted at once", async () => {
      const gated = makeGatedCaller();
      const { store, rows, worker } = setup({ callSynapse: gated.caller });
      await store.enqueue(newJob(), 3);
      await store.enqueue(newJob("user-2"), 3);
      await worker.tick();
      await Bun.sleep(5);

      await worker.stop();

      expect(rows.map((r) => r.errorCode)).toEqual([
        "interrupted",
        "interrupted",
      ]);
      // a result that lands after shutdown does not overwrite the failure
      gated.releaseAll();
      await worker.idle();
      expect(rows.every((r) => r.status === "failed")).toBe(true);
    });

    test("the sweep deletes jobs past their 24 hour expiry", async () => {
      const { store, rows, worker } = setup();
      await store.enqueue(newJob(), 3, new Date(Date.now() - 25 * 3_600_000));
      await store.enqueue(newJob("user-2"), 3);

      await worker.sweep();

      expect(rows.map((r) => r.userId)).toEqual(["user-2"]);
    });
  });
});
