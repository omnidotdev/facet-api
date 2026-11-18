import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createSpendBreaker } from "@omnidotdev/providers";
import { SynapseProvisionError } from "@omnidotdev/providers/ai";
import { Elysia } from "elysia";
import { createMemoryJobStore } from "test/fakes/memoryJobStore";

import { createRateLimiter } from "lib/cost/rateLimit";
import { createGenerationsRoute } from "./generations";

import type { SpendBreaker } from "@omnidotdev/providers";
import type { WorkspaceFunding } from "lib/billing/facetBilling";
import type { RateLimiter } from "lib/cost/rateLimit";
import type { ManagedKeyProvisioner } from "lib/synapse/provisioner";

type Deps = Parameters<typeof createGenerationsRoute>[0];

const FUNDED: WorkspaceFunding = {
  billingAccountId: "acct-1",
  paidCreditsUsd: 10,
  isPayingCustomer: true,
  cardVerified: false,
};
const NOT_FUNDED: WorkspaceFunding = {
  billingAccountId: "acct-1",
  paidCreditsUsd: 0,
  isPayingCustomer: false,
  cardVerified: false,
};

/** Resolve the signed-in user from a `x-test-user` header (absent is signed out) */
const authenticate: Deps["authenticate"] = async (request) => {
  const userId = request.headers.get("x-test-user");
  if (!userId) return null;
  const noWorkspace = request.headers.get("x-test-no-workspace") === "1";
  return {
    userId,
    personalWorkspace: noWorkspace
      ? null
      : { id: `ws-${userId}`, slug: userId },
  };
};

interface Overrides {
  breaker?: SpendBreaker;
  rateLimiter?: RateLimiter;
  provisioner?: ManagedKeyProvisioner | null;
  funding?: WorkspaceFunding;
}

const makeApp = (overrides: Overrides = {}) => {
  const memory = createMemoryJobStore();
  const provisionCalls: unknown[][] = [];
  let notified = 0;
  const app = new Elysia().use(
    createGenerationsRoute({
      store: memory.store,
      breaker: overrides.breaker ?? createSpendBreaker(500),
      rateLimiter:
        overrides.rateLimiter ??
        createRateLimiter({ windowMs: 60_000, max: 100 }),
      authenticate,
      provisioner:
        overrides.provisioner === null
          ? undefined
          : (overrides.provisioner ?? {
              async resolveKey(...args) {
                provisionCalls.push(args);
                return `sk-scoped-${args[0]}`;
              },
            }),
      resolveTier: async () => "free",
      resolveFunding: async () => overrides.funding ?? FUNDED,
      onEnqueued: () => {
        notified += 1;
      },
    }),
  );

  const call = (
    method: string,
    path: string,
    {
      user,
      body,
      headers = {},
    }: {
      user?: string | null;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.handle(
      new Request(`http://test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(user === null ? {} : { "x-test-user": user ?? "user-1" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  return {
    ...memory,
    call,
    provisionCalls,
    notified: () => notified,
    enqueue: (
      body: unknown,
      user?: string | null,
      headers?: Record<string, string>,
    ) => call("POST", "/generations", { user, body, headers }),
  };
};

const ENV_KEYS = [
  "SYNAPSE_API_URL",
  "SYNAPSE_GATEWAY_SECRET",
  "MAX_PROMPT_CHARS",
  "MAX_REPAIR_ATTEMPTS",
  "FACET_MANAGED_ALLOWLIST",
  "MAX_ACTIVE_GENERATION_JOBS",
] as const;
let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SYNAPSE_API_URL = "https://api.synapse.test";
  process.env.SYNAPSE_GATEWAY_SECRET = "gw-secret";
  process.env.MAX_PROMPT_CHARS = "2000";
  process.env.MAX_REPAIR_ATTEMPTS = "2";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe("POST /generations", () => {
  test("queues a managed job and answers 202 with it, waking the worker", async () => {
    const app = makeApp();

    const res = await app.enqueue({ prompt: "a 10mm cube" });

    expect(res.status).toBe(202);
    const { job } = await res.json();
    expect(job).toMatchObject({
      kind: "draft",
      status: "queued",
      prompt: "a 10mm cube",
    });
    expect(typeof job.id).toBe("string");
    expect(typeof job.generationId).toBe("string");
    expect(typeof job.expiresAt).toBe("string");
    // the reply carries nothing internal: no user, workspace, or key
    expect(job.userId).toBeUndefined();
    expect(job.workspaceId).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("sk-scoped");
    expect(app.rows[0]!.userId).toBe("user-1");
    expect(app.rows[0]!.workspaceId).toBe("ws-user-1");
    expect(app.notified()).toBe(1);
  });

  test("never stores the managed key with the job", async () => {
    const app = makeApp();
    await app.enqueue({ prompt: "a 10mm cube" });

    expect(JSON.stringify(app.rows)).not.toContain("sk-scoped");
    // the gate still provisioned it, proving the plan grants access now
    expect(app.provisionCalls).toHaveLength(1);
  });

  test("stores a repair's follow-up context and echoes the chain id", async () => {
    const app = makeApp();

    const res = await app.enqueue({
      prompt: "a 10mm cube",
      previous: { code: "broken()", error: "boom" },
      attempt: 1,
      generationId: "gen-chain",
    });

    expect(res.status).toBe(202);
    expect((await res.json()).job).toMatchObject({
      kind: "repair",
      generationId: "gen-chain",
    });
    expect(app.rows[0]).toMatchObject({
      priorCode: "broken()",
      priorError: "boom",
      attempt: 1,
    });
  });

  test("stores a refine's prior code and suggestion", async () => {
    const app = makeApp();

    await app.enqueue({
      prompt: "a 10mm cube",
      refine: { code: "cube(1)", suggestion: "taller" },
    });

    expect(app.rows[0]).toMatchObject({
      kind: "refine",
      priorCode: "cube(1)",
      suggestion: "taller",
    });
  });

  test("records whether the workspace pays, for the free-tier breaker", async () => {
    const app = makeApp();
    await app.enqueue({ prompt: "a 10mm cube" });
    expect(app.rows[0]!.isPayingCustomer).toBe(true);
  });

  describe("runs every synchronous gate first, with the same codes", () => {
    const refused = async (
      app: ReturnType<typeof makeApp>,
      body: unknown,
      user?: string | null,
      headers?: Record<string, string>,
    ) => {
      const res = await app.enqueue(body, user, headers);
      expect(app.rows).toHaveLength(0);
      return { status: res.status, body: await res.json() };
    };

    test("a missing or overlong prompt is 400 bad_prompt", async () => {
      const app = makeApp();
      expect(await refused(app, { prompt: "  " })).toMatchObject({
        status: 400,
        body: { code: "bad_prompt" },
      });
      expect(await refused(app, { prompt: "x".repeat(2001) })).toMatchObject({
        status: 400,
        body: { code: "bad_prompt" },
      });
    });

    test("a BYOK key is refused (400 bad_input): it is never stored", async () => {
      const app = makeApp();
      expect(
        await refused(app, { prompt: "a cube", byokKey: "sk-user" }),
      ).toMatchObject({ status: 400, body: { code: "bad_input" } });
    });

    test("the per-IP limiter is 429 rate_limited", async () => {
      const app = makeApp({
        rateLimiter: { allow: () => false },
      });
      expect(await refused(app, { prompt: "a cube" })).toMatchObject({
        status: 429,
        body: { code: "rate_limited" },
      });
    });

    test("a repair past the ceiling is 429 repair_limited", async () => {
      const app = makeApp();
      expect(
        await refused(app, {
          prompt: "a cube",
          previous: { code: "x", error: "y" },
          attempt: 3,
        }),
      ).toMatchObject({ status: 429, body: { code: "repair_limited" } });
    });

    test("signed out is 401 unauthorized", async () => {
      const app = makeApp();
      expect(await refused(app, { prompt: "a cube" }, null)).toMatchObject({
        status: 401,
        body: { code: "unauthorized" },
      });
    });

    test("a token without a personal workspace is 401 reauth_required", async () => {
      const app = makeApp();
      expect(
        await refused(app, { prompt: "a cube" }, "user-1", {
          "x-test-no-workspace": "1",
        }),
      ).toMatchObject({ status: 401, body: { code: "reauth_required" } });
    });

    test("a user outside the preview whitelist is 403 not_allowed", async () => {
      process.env.FACET_MANAGED_ALLOWLIST = "someone-else";
      const app = makeApp();
      expect(await refused(app, { prompt: "a cube" })).toMatchObject({
        status: 403,
        body: { code: "not_allowed" },
      });
    });

    test("a non-paying workspace is 402 payment_required", async () => {
      const app = makeApp({ funding: NOT_FUNDED });
      expect(await refused(app, { prompt: "a cube" })).toMatchObject({
        status: 402,
        body: { code: "payment_required" },
      });
    });

    test("a plan without API access is 403 plan_required", async () => {
      const app = makeApp({
        provisioner: {
          async resolveKey() {
            throw new SynapseProvisionError("no access", 403);
          },
        },
      });
      expect(await refused(app, { prompt: "a cube" })).toMatchObject({
        status: 403,
        body: { code: "plan_required" },
      });
    });

    test("managed AI not configured is 503 unavailable", async () => {
      const app = makeApp({ provisioner: null });
      expect(await refused(app, { prompt: "a cube" })).toMatchObject({
        status: 503,
        body: { code: "unavailable" },
      });
    });
  });

  test("past the per-user cap is 429 too_many_jobs, other users unaffected", async () => {
    process.env.MAX_ACTIVE_GENERATION_JOBS = "2";
    const app = makeApp();
    await app.enqueue({ prompt: "one" });
    await app.enqueue({ prompt: "two" });

    const res = await app.enqueue({ prompt: "three" });

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      code: "too_many_jobs",
      error: expect.stringContaining("most generations"),
    });
    expect((await app.enqueue({ prompt: "mine" }, "user-2")).status).toBe(202);
  });

  test("a database failure is a generic 503", async () => {
    const app = makeApp();
    app.store.enqueue = async () => {
      throw new Error("connection refused at 10.0.0.5");
    };

    const res = await app.enqueue({ prompt: "a cube" });

    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("unavailable");
    expect(text).not.toContain("10.0.0.5");
  });
});

describe("reading and dismissing jobs", () => {
  const seed = async () => {
    const app = makeApp();
    const mine = await (await app.enqueue({ prompt: "mine" })).json();
    const theirs = await (
      await app.enqueue({ prompt: "theirs" }, "user-2")
    ).json();
    return {
      app,
      mine: mine.job.id as string,
      theirs: theirs.job.id as string,
    };
  };

  test("GET /generations lists only the caller's jobs, newest first", async () => {
    const { app } = await seed();
    await app.enqueue({ prompt: "mine later" });

    const res = await app.call("GET", "/generations");

    expect(res.status).toBe(200);
    const { jobs } = await res.json();
    expect(jobs.map((j: { prompt: string }) => j.prompt)).toEqual([
      "mine later",
      "mine",
    ]);
  });

  test("a finished job carries its code, a failed one its user-safe error", async () => {
    const { app, mine } = await seed();
    await app.enqueue({ prompt: "second" });
    const first = await app.store.claimNext("w1");
    await app.store.succeed(first!.id, "w1", "return cube(1);");
    // the other user's job is next in line; the caller's second is after it
    await app.store.claimNext("w1");
    const second = await app.store.claimNext("w1");
    await app.store.fail(second!.id, "w1", {
      code: "out_of_credits",
      message: "You are out of AI credits.",
      status: 402,
    });

    const { jobs } = await (await app.call("GET", "/generations")).json();
    const byId = new Map(jobs.map((j: { id: string }) => [j.id, j]));

    expect(byId.get(mine)).toMatchObject({
      status: "succeeded",
      code: "return cube(1);",
    });
    expect(byId.get(second!.id)).toMatchObject({
      status: "failed",
      error: {
        code: "out_of_credits",
        message: "You are out of AI credits.",
        status: 402,
      },
    });
    // a queued or running job carries neither
    const { job } = await (
      await app.call("GET", `/generations/${mine}`)
    ).json();
    expect(job.error).toBeUndefined();
  });

  test("GET /generations/:id is owner-only (404 otherwise)", async () => {
    const { app, mine, theirs } = await seed();

    expect((await app.call("GET", `/generations/${mine}`)).status).toBe(200);
    const res = await app.call("GET", `/generations/${theirs}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
    expect((await app.call("GET", "/generations/not-a-uuid")).status).toBe(404);
  });

  test("DELETE /generations/:id dismisses the caller's job and deletes it", async () => {
    const { app, mine, theirs } = await seed();

    expect((await app.call("DELETE", `/generations/${theirs}`)).status).toBe(
      404,
    );
    const res = await app.call("DELETE", `/generations/${mine}`);

    expect(res.status).toBe(204);
    expect(app.rows.map((r) => r.prompt)).toEqual(["theirs"]);
    expect((await app.call("GET", `/generations/${mine}`)).status).toBe(404);
  });

  test("every read and dismiss requires sign-in", async () => {
    const { app, mine } = await seed();

    for (const [method, path] of [
      ["GET", "/generations"],
      ["GET", `/generations/${mine}`],
      ["DELETE", `/generations/${mine}`],
    ] as const) {
      const res = await app.call(method, path, { user: null });
      expect(res.status).toBe(401);
    }
    expect(app.rows).toHaveLength(2);
  });
});
