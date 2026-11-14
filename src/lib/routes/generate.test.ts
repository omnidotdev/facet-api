import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createSpendBreaker } from "@omnidotdev/providers";
import { SynapseRequestError } from "@omnidotdev/providers/ai";
import { Elysia } from "elysia";

import { createRateLimiter } from "lib/cost/rateLimit";
import { createFacetProvisioner } from "lib/synapse/provisioner";
import { createGenerateRoute } from "./generate";

import type { SpendBreaker } from "@omnidotdev/providers";
import type { RateLimiter } from "lib/cost/rateLimit";
import type { ManagedKeyProvisioner } from "lib/synapse/provisioner";

const CODE = "const part = cube(10);\nreturn part;";
const FENCED = `Here you go:\n\`\`\`ts\n${CODE}\n\`\`\``;

type Caller = Parameters<typeof createGenerateRoute>[0]["callSynapse"];
type Authenticate = Parameters<typeof createGenerateRoute>[0]["authenticate"];

type Events = NonNullable<Parameters<typeof createGenerateRoute>[0]["events"]>;

interface Overrides {
  caller?: Caller;
  breaker?: SpendBreaker;
  rateLimiter?: RateLimiter;
  authenticate?: Authenticate;
  events?: Events;
  /** null removes the provisioner (provisioning not configured) */
  provisioner?: ManagedKeyProvisioner | null;
  tier?: string;
}

/** Build an events stub that records every emitted event. */
const makeEvents = () => {
  const emitted: {
    type: string;
    data: Record<string, unknown>;
    subject?: string;
  }[] = [];
  const events: Events = {
    async emit(event) {
      emitted.push(event);
      return undefined;
    },
  };
  return { events, emitted };
};

/** A provisioner fake that records each resolveKey call and returns a scoped key */
const makeProvisioner = () => {
  const calls: unknown[][] = [];
  const provisioner: ManagedKeyProvisioner = {
    async resolveKey(...args) {
      calls.push(args);
      return `sk-scoped-${args[0]}`;
    },
  };
  return { provisioner, calls };
};

/** Build an authenticate stub that records how many times it ran. */
const makeAuthenticator = (identity: { userId: string } | null) => {
  const calls: { count: number } = { count: 0 };
  const authenticate: Authenticate = async () => {
    calls.count += 1;
    return identity;
  };
  return { authenticate, calls };
};

const makeCaller = (
  text: string,
  costCents = 1.4,
): { caller: Caller; calls: { apiKey?: string }[] } => {
  const calls: { apiKey?: string }[] = [];
  const caller = (async (input: { apiKey?: string }) => {
    calls.push({ apiKey: input.apiKey });
    return {
      text,
      usage: { inputTokens: 100, outputTokens: 50, costCents },
    };
  }) as Caller;
  return { caller, calls };
};

/** A caller that fails the way the gateway does, with its HTTP status */
const refusingCaller = (status: number) => {
  const calls: { apiKey?: string }[] = [];
  const caller = (async (input: { apiKey?: string }) => {
    calls.push({ apiKey: input.apiKey });
    throw new SynapseRequestError(
      `synapse request failed: status ${status}`,
      status,
    );
  }) as Caller;
  return { caller, calls };
};

const makeApp = (overrides: Overrides = {}) => {
  const caller = overrides.caller ?? makeCaller(FENCED).caller;
  const tierCalls: string[] = [];
  const app = new Elysia().use(
    createGenerateRoute({
      callSynapse: caller,
      breaker: overrides.breaker ?? createSpendBreaker(500),
      rateLimiter:
        overrides.rateLimiter ??
        createRateLimiter({ windowMs: 60_000, max: 100 }),
      // default to a valid identity so managed-path tests proceed
      authenticate:
        overrides.authenticate ??
        makeAuthenticator({ userId: "user-1" }).authenticate,
      events: overrides.events,
      provisioner:
        overrides.provisioner === null
          ? undefined
          : (overrides.provisioner ?? makeProvisioner().provisioner),
      resolveTier: async (userId) => {
        tierCalls.push(userId);
        return overrides.tier ?? "free";
      },
    }),
  );

  const request = (body: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request("http://test/generate", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  return Object.assign(request, { tierCalls });
};

const ENV_KEYS = [
  "SYNAPSE_API_URL",
  "SYNAPSE_GATEWAY_SECRET",
  "MAX_PROMPT_CHARS",
  "MAX_OUTPUT_TOKENS",
  "MAX_REPAIR_ATTEMPTS",
  "FACET_MANAGED_ALLOWLIST",
] as const;
let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  // Snapshot, then clear every toggled key so the file is hermetic: a value
  // left set by an earlier test file (the suite runs them in one process) must
  // not bleed in, or e.g. a leaked FACET_MANAGED_ALLOWLIST gates the happy path
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
  // managed path enabled by default (product-scoped provisioning configured)
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

describe("POST /generate", () => {
  test("happy path extracts the fenced code and reports no local credit math", async () => {
    const request = makeApp();
    const res = await request({ prompt: "a 10mm cube" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.code).toBe(CODE);
    // billing is the gateway's: the response carries no locally computed credits
    expect(json.usage).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("credits");
  });

  describe("product-scoped managed key", () => {
    test("provisions a key billed to the user and calls the gateway with it", async () => {
      const { provisioner, calls: provisionCalls } = makeProvisioner();
      const { caller, calls } = makeCaller(FENCED);
      const request = makeApp({ caller, provisioner });

      const res = await request({ prompt: "a 10mm cube" });

      expect(res.status).toBe(200);
      expect(provisionCalls).toEqual([
        ["user-1", undefined, { entityType: "user", entityId: "user-1" }],
      ]);
      expect(calls[0]!.apiKey).toBe("sk-scoped-user-1");
    });

    test("the provisioning request is scoped to the facet app and the user", async () => {
      const userId = "6f1c2a8e-4b7d-4e2a-9c1f-0a1b2c3d4e5f";
      const bodies: Record<string, unknown>[] = [];
      const provisioner = createFacetProvisioner({
        apiUrl: "https://api.synapse.test",
        gatewaySecret: "gw-secret",
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ apiKey: "sk-facet-user" }));
        }) as unknown as typeof fetch,
      });
      const { caller, calls } = makeCaller(FENCED);
      const request = makeApp({
        caller,
        provisioner,
        authenticate: makeAuthenticator({ userId }).authenticate,
      });

      const res = await request({ prompt: "a 10mm cube" });

      expect(res.status).toBe(200);
      expect(bodies).toEqual([
        {
          identityProviderId: userId,
          source: "Facet",
          appId: "facet",
          billingEntity: { entityType: "user", entityId: userId },
        },
      ]);
      expect(calls[0]!.apiKey).toBe("sk-facet-user");
    });

    test("a provisioning failure is a 503 with no gateway call (never a shared key)", async () => {
      const { caller, calls } = makeCaller(FENCED);
      const request = makeApp({
        caller,
        provisioner: {
          resolveKey: async () => {
            throw new Error("synapse-api down");
          },
        },
      });

      const res = await request({ prompt: "a 10mm cube" });

      expect(res.status).toBe(503);
      expect(calls).toHaveLength(0);
    });

    test("managed generation is a 503 when provisioning is not configured", async () => {
      delete process.env.SYNAPSE_GATEWAY_SECRET;
      const { caller, calls } = makeCaller(FENCED);
      const request = makeApp({ caller });

      const res = await request({ prompt: "a cube" });

      expect(res.status).toBe(503);
      expect(calls).toHaveLength(0);
    });

    test("managed generation is a 503 when no provisioner is wired", async () => {
      const { caller, calls } = makeCaller(FENCED);
      const request = makeApp({ caller, provisioner: null });

      const res = await request({ prompt: "a cube" });

      expect(res.status).toBe(503);
      expect(calls).toHaveLength(0);
    });
  });

  describe("gateway refusals", () => {
    test("a gateway 402 (empty balance) surfaces as the out-of-credits 402", async () => {
      const { caller, calls } = refusingCaller(402);
      const breaker = createSpendBreaker(500);
      const request = makeApp({ caller, breaker });

      const res = await request({ prompt: "a cube" });

      expect(res.status).toBe(402);
      const json = await res.json();
      expect(json.error).toMatch(/out of AI credits/i);
      expect(calls).toHaveLength(1);
      // nothing was spent, so nothing is recorded
      expect(await breaker.spentTodayCents()).toBe(0);
    });

    test("a gateway 503 surfaces as temporarily unavailable", async () => {
      const request = makeApp({ caller: refusingCaller(503).caller });

      const res = await request({ prompt: "a cube" });

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toMatch(/temporarily unavailable/i);
    });

    test("any other gateway failure is a generic 502 that never leaks detail", async () => {
      const caller = (async () => {
        throw new Error("synapse request failed: status 500 provider xyz");
      }) as Caller;
      const request = makeApp({ caller });
      const res = await request({ prompt: "a cube" });

      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).not.toContain("provider xyz");
      expect(text).not.toContain("synapse");
    });
  });

  describe("managed allowlist (limited preview)", () => {
    test("refuses a signed-in user who is not on the allowlist", async () => {
      process.env.FACET_MANAGED_ALLOWLIST = "owner-123, owner-456";
      const { caller, calls } = makeCaller(FENCED);
      const { provisioner, calls: provisionCalls } = makeProvisioner();
      const request = makeApp({
        caller,
        provisioner,
        authenticate: makeAuthenticator({ userId: "random-user" }).authenticate,
      });

      const res = await request({ prompt: "a cube" });

      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
      expect(provisionCalls).toHaveLength(0);
    });

    test("allows a user who is on the allowlist", async () => {
      process.env.FACET_MANAGED_ALLOWLIST = "owner-123, random-user";
      const request = makeApp({
        authenticate: makeAuthenticator({ userId: "random-user" }).authenticate,
      });

      const res = await request({ prompt: "a cube" });

      expect(res.status).toBe(200);
    });

    test("does not restrict anyone when the allowlist is unset", async () => {
      const request = makeApp({
        authenticate: makeAuthenticator({ userId: "anyone" }).authenticate,
      });

      const res = await request({ prompt: "a cube" });

      expect(res.status).toBe(200);
    });
  });

  describe("free-tier daily breaker", () => {
    test("records a free user's real spend (gateway or estimate) in the breaker", async () => {
      const breaker = createSpendBreaker(500);
      const request = makeApp({
        caller: makeCaller(FENCED, 3).caller,
        breaker,
      });

      const res = await request({ prompt: "a cube" });

      expect(res.status).toBe(200);
      expect(await breaker.spentTodayCents()).toBe(3);
    });

    test("a tripped breaker blocks a free user before provisioning or any call", async () => {
      const breaker = createSpendBreaker(100);
      await breaker.record(100);
      const { caller, calls } = makeCaller(FENCED);
      const { provisioner, calls: provisionCalls } = makeProvisioner();
      const request = makeApp({ caller, breaker, provisioner });

      const res = await request({ prompt: "a cube" });

      expect(res.status).toBe(503);
      expect(calls).toHaveLength(0);
      expect(provisionCalls).toHaveLength(0);
    });

    test("a paid tier is served even when the free-tier breaker is tripped", async () => {
      const breaker = createSpendBreaker(100);
      await breaker.record(100);
      const { caller, calls } = makeCaller(FENCED);
      const request = makeApp({ caller, breaker, tier: "pro" });

      const res = await request({ prompt: "a cube" });

      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
    });

    test("paid spend is never recorded against the free breaker", async () => {
      const breaker = createSpendBreaker(500);
      const request = makeApp({
        caller: makeCaller(FENCED, 5).caller,
        breaker,
        tier: "pro",
      });

      const res = await request({ prompt: "a cube" });

      expect(res.status).toBe(200);
      expect(await breaker.spentTodayCents()).toBe(0);
    });

    test("the tier is resolved for the signed-in user", async () => {
      const request = makeApp({
        authenticate: makeAuthenticator({ userId: "user-42" }).authenticate,
      });

      await request({ prompt: "a cube" });

      expect(request.tierCalls).toEqual(["user-42"]);
    });
  });

  describe("BYOK (unchanged: the caller's own key, no managed gating)", () => {
    test("forwards the caller's key and skips auth, tier, breaker and provisioning", async () => {
      delete process.env.SYNAPSE_GATEWAY_SECRET; // managed path disabled
      process.env.FACET_MANAGED_ALLOWLIST = "owner-123";
      const breaker = createSpendBreaker(100);
      await breaker.record(100); // tripped
      const { authenticate, calls: authCalls } = makeAuthenticator(null);
      const { provisioner, calls: provisionCalls } = makeProvisioner();
      const { caller, calls } = makeCaller(FENCED);
      const request = makeApp({ caller, breaker, authenticate, provisioner });

      const res = await request({ prompt: "a cube", byokKey: "byok-xyz" });

      expect(res.status).toBe(200);
      expect(calls).toEqual([{ apiKey: "byok-xyz" }]);
      expect(authCalls.count).toBe(0);
      expect(provisionCalls).toHaveLength(0);
      expect(request.tierCalls).toHaveLength(0);
      // BYOK spend is not recorded against our breaker
      expect(await breaker.spentTodayCents()).toBe(100);
    });

    test("a BYOK upstream failure stays a generic 502", async () => {
      const request = makeApp({ caller: refusingCaller(402).caller });

      const res = await request({ prompt: "a cube", byokKey: "byok-xyz" });

      expect(res.status).toBe(502);
    });
  });

  test("emits facet.generation.completed with usage metadata (no prompt/code, no credits)", async () => {
    const { events, emitted } = makeEvents();
    const request = makeApp({ events });
    const res = await request({ prompt: "a 10mm cube" });

    expect(res.status).toBe(200);
    // the emit is fire-and-forget, so let the microtask settle
    await Promise.resolve();
    expect(emitted).toHaveLength(1);
    const event = emitted[0]!;
    expect(event.type).toBe("facet.generation.completed");
    expect(event.subject).toBe("user-1");
    expect(event.data).toMatchObject({
      byok: false,
      userId: "user-1",
      inputTokens: 100,
      outputTokens: 50,
      repaired: false,
    });
    expect(event.data.credits).toBeUndefined();
    // never leak the prompt or the generated code into telemetry
    const serialized = JSON.stringify(event.data);
    expect(serialized).not.toContain("10mm cube");
    expect(serialized).not.toContain(CODE);
  });

  test("a failed generation emits no event", async () => {
    const { events, emitted } = makeEvents();
    const request = makeApp({
      events,
      caller: makeCaller("no code here").caller,
    });
    const res = await request({ prompt: "a 10mm cube" });

    expect(res.status).toBe(422);
    await Promise.resolve();
    expect(emitted).toHaveLength(0);
  });

  test("rejects an empty prompt with a user-safe 400", async () => {
    const { caller, calls } = makeCaller(FENCED);
    const request = makeApp({ caller });
    const res = await request({ prompt: "   " });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.error).toBe("string");
    expect(calls).toHaveLength(0);
  });

  test("rejects an oversize prompt with a user-safe 400 and never calls Synapse", async () => {
    process.env.MAX_PROMPT_CHARS = "10";
    const { caller, calls } = makeCaller(FENCED);
    const request = makeApp({ caller });
    const res = await request({ prompt: "x".repeat(50) });

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("managed path with no identity returns a generic 401 and never calls Synapse", async () => {
    const { authenticate, calls: authCalls } = makeAuthenticator(null);
    const { caller, calls } = makeCaller(FENCED);
    const request = makeApp({ caller, authenticate });
    const res = await request({ prompt: "a cube" });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(typeof json.error).toBe("string");
    expect(authCalls.count).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("returns 422 when the model emits no fenced code block", async () => {
    const { caller } = makeCaller("Sorry, I cannot do that.");
    const request = makeApp({ caller });
    const res = await request({ prompt: "a cube" });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(typeof json.error).toBe("string");
  });

  test("returns 429 when the per-IP rate limit is exceeded", async () => {
    const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    const request = makeApp({ rateLimiter });
    const headers = { "x-forwarded-for": "9.9.9.9" };

    expect((await request({ prompt: "a cube" }, headers)).status).toBe(200);
    expect((await request({ prompt: "a cube" }, headers)).status).toBe(429);
  });

  test("never echoes the managed key in the response", async () => {
    const request = makeApp();
    const res = await request({ prompt: "a cube" });
    const text = await res.text();
    expect(text).not.toContain("sk-scoped");
  });

  test("forwards repair context and enforces the repair-attempt ceiling", async () => {
    process.env.MAX_REPAIR_ATTEMPTS = "1";
    const { caller, calls } = makeCaller(FENCED);
    const request = makeApp({ caller });

    // attempt within the ceiling is allowed
    const ok = await request({
      prompt: "a cube",
      previous: { code: "bad", error: "boom" },
      attempt: 1,
    });
    expect(ok.status).toBe(200);
    expect(calls).toHaveLength(1);

    // attempt beyond the ceiling is refused without calling Synapse
    const refused = await request({
      prompt: "a cube",
      previous: { code: "bad", error: "boom" },
      attempt: 2,
    });
    expect(refused.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  test("forwards refine context: prior code + the critic's suggestion, not an error", async () => {
    // Capture the messages the route builds, to prove the refine turn carries
    // the critique and is framed as a visual mismatch, never a thrown error
    const seen: { messages: { role: string; content: string }[] }[] = [];
    const caller = (async (input: {
      apiKey?: string;
      messages: { role: string; content: string }[];
    }) => {
      seen.push({ messages: input.messages });
      return {
        text: FENCED,
        usage: { inputTokens: 100, outputTokens: 50, costCents: 1.4 },
      };
    }) as Caller;
    const request = makeApp({ caller });

    const res = await request({
      prompt: "scorpio symbol",
      refine: {
        code: "return cube(10);",
        suggestion: "Add a curved tail with an arrow stinger at the end.",
      },
    });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const text = seen[0]!.messages.map((m) => m.content).join("\n");
    expect(text).toContain("cube(10)");
    expect(text).toContain("curved tail");
    expect(text).not.toMatch(/threw|error/i);
  });
});
