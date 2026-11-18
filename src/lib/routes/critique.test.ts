import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createSpendBreaker } from "@omnidotdev/providers";
import {
  SynapseProvisionError,
  SynapseRequestError,
} from "@omnidotdev/providers/ai";
import { Elysia } from "elysia";

import { createRateLimiter } from "lib/cost/rateLimit";
import { createCritiqueRoute } from "./critique";

import type { SpendBreaker } from "@omnidotdev/providers";
import type { WorkspaceFunding } from "lib/billing/facetBilling";
import type { RateLimiter } from "lib/cost/rateLimit";
import type { ManagedKeyProvisioner } from "lib/synapse/provisioner";

type Caller = Parameters<typeof createCritiqueRoute>[0]["callSynapse"];
type Authenticate = Parameters<typeof createCritiqueRoute>[0]["authenticate"];
type Events = NonNullable<Parameters<typeof createCritiqueRoute>[0]["events"]>;

/** Build an events stub that records every emitted event. */
const makeEvents = () => {
  const emitted: {
    type: string;
    data: Record<string, unknown>;
    subject?: string;
    correlationId?: string;
  }[] = [];
  const events: Events = {
    async emit(event) {
      emitted.push(event);
      return undefined;
    },
  };
  return { events, emitted };
};

const VERDICT = JSON.stringify({
  ok: false,
  score: 0.3,
  issues: ["reads as a letter, not a scorpion", "missing the tail hook"],
  suggestedFix: "render the glyph with text() instead of a hand-drawn path",
});

const IMG = { mediaType: "image/png", data: "aGVsbG8=" };

interface Overrides {
  caller?: Caller;
  breaker?: SpendBreaker;
  rateLimiter?: RateLimiter;
  authenticate?: Authenticate;
  events?: Events;
  provisioner?: ManagedKeyProvisioner;
  tier?: string;
  /** Records each workspace id the tier is resolved for */
  tierCalls?: string[];
  /** The workspace's funding, or an error the funding lookup throws */
  funding?: WorkspaceFunding | Error;
  /** Records each workspace id funding is resolved for */
  fundingCalls?: string[];
}

/** A free-tier workspace that has bought credits (the default managed user) */
const FUNDED: WorkspaceFunding = {
  billingAccountId: "acct-1",
  paidCreditsUsd: 10,
  isPayingCustomer: true,
  cardVerified: false,
};

/** A free-tier workspace that never paid */
const NOT_FUNDED: WorkspaceFunding = {
  billingAccountId: null,
  paidCreditsUsd: 0,
  isPayingCustomer: false,
  cardVerified: false,
};

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

/**
 * Build an authenticate stub. A signed-in identity defaults to a personal
 * workspace `ws-<userId>`; pass `personalWorkspace: null` for a user without one
 */
const makeAuthenticator = (
  identity: {
    userId: string;
    personalWorkspace?: { id: string; slug: string } | null;
  } | null,
) => {
  const authenticate: Authenticate = async () =>
    identity && {
      userId: identity.userId,
      personalWorkspace:
        identity.personalWorkspace === undefined
          ? { id: `ws-${identity.userId}`, slug: identity.userId }
          : identity.personalWorkspace,
    };
  return { authenticate };
};

const makeCaller = (text: string, costCents = 1.4) => {
  const calls: { apiKey?: string; content: unknown }[] = [];
  const caller = (async (input: {
    apiKey?: string;
    messages: { content: unknown }[];
  }) => {
    calls.push({ apiKey: input.apiKey, content: input.messages[0]?.content });
    return { text, usage: { inputTokens: 100, outputTokens: 50, costCents } };
  }) as Caller;
  return { caller, calls };
};

const makeApp = (overrides: Overrides = {}) => {
  const caller = overrides.caller ?? makeCaller(VERDICT).caller;
  const app = new Elysia().use(
    createCritiqueRoute({
      callSynapse: caller,
      breaker: overrides.breaker ?? createSpendBreaker(500),
      rateLimiter:
        overrides.rateLimiter ??
        createRateLimiter({ windowMs: 60_000, max: 100 }),
      authenticate:
        overrides.authenticate ??
        makeAuthenticator({ userId: "user-1" }).authenticate,
      events: overrides.events,
      provisioner: overrides.provisioner ?? makeProvisioner().provisioner,
      resolveTier: async (workspaceId) => {
        overrides.tierCalls?.push(workspaceId);
        return overrides.tier ?? "free";
      },
      resolveFunding: async (workspaceId) => {
        overrides.fundingCalls?.push(workspaceId);
        const funding = overrides.funding ?? FUNDED;
        if (funding instanceof Error) throw funding;
        return funding;
      },
    }),
  );
  return (body: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request("http://test/critique", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
};

const OK_BODY = {
  prompt: "scorpio symbol",
  code: "return cube(10);",
  image: IMG,
};

const ENV_KEYS = [
  "SYNAPSE_API_URL",
  "SYNAPSE_GATEWAY_SECRET",
  "MAX_PROMPT_CHARS",
  "FACET_MANAGED_ALLOWLIST",
] as const;
let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) snapshot[k] = process.env[k];
  // enable managed (product-scoped provisioning configured)
  process.env.SYNAPSE_API_URL = "https://api.synapse.test";
  process.env.SYNAPSE_GATEWAY_SECRET = "gw-secret";
  process.env.FACET_MANAGED_ALLOWLIST = "";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe("createCritiqueRoute", () => {
  test("returns a structured verdict using the product-scoped key", async () => {
    const { provisioner, calls: provisionCalls } = makeProvisioner();
    const { caller, calls } = makeCaller(VERDICT);
    const breaker = createSpendBreaker(500);
    const res = await makeApp({ caller, provisioner, breaker })(OK_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      score: number;
      issues: string[];
      suggestedFix: string | null;
    };
    expect(body.ok).toBe(false);
    expect(body.score).toBeCloseTo(0.3);
    expect(body.issues.length).toBe(2);
    expect(body.suggestedFix).toContain("text()");
    // the key is the user's but bills their personal workspace
    expect(provisionCalls).toEqual([
      [
        "user-1",
        undefined,
        { entityType: "organization", entityId: "ws-user-1" },
      ],
    ]);
    expect(calls[0]!.apiKey).toBe("sk-scoped-user-1");
    // only a paying customer is served, and their spend never counts toward
    // the free-tier breaker backstop
    expect(await breaker.spentTodayCents()).toBe(0);
  });

  test("forwards the render as a multimodal image block", async () => {
    const { caller, calls } = makeCaller(VERDICT);
    await makeApp({ caller })(OK_BODY);
    expect(calls[0]!.content).toEqual([
      expect.objectContaining({ type: "text" }),
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
    ]);
  });

  test("400 when prompt, code, or image is missing", async () => {
    const res = await makeApp()({ prompt: "x", code: "y" });
    expect(res.status).toBe(400);
  });

  test("401 on the managed path without a signed-in identity", async () => {
    const res = await makeApp({
      authenticate: makeAuthenticator(null).authenticate,
    })(OK_BODY);
    expect(res.status).toBe(401);
  });

  test("a provisioning failure is a 503 with no gateway call", async () => {
    const { caller, calls } = makeCaller(VERDICT);
    const res = await makeApp({
      caller,
      provisioner: {
        resolveKey: async () => {
          throw new Error("synapse-api down");
        },
      },
    })(OK_BODY);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test("a gateway 402 surfaces as the out-of-credits 402", async () => {
    const caller = (async () => {
      throw new SynapseRequestError("synapse request failed: status 402", 402);
    }) as Caller;
    const res = await makeApp({ caller })(OK_BODY);
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("out_of_credits");
  });

  test("a free, never-paid workspace is refused with 402 payment_required before the breaker, provisioning, or any call", async () => {
    const { provisioner, calls: provisionCalls } = makeProvisioner();
    const { caller, calls } = makeCaller(VERDICT);
    const touched = { isTripped: 0, record: 0 };
    const breaker: SpendBreaker = {
      async isTripped() {
        touched.isTripped += 1;
        return false;
      },
      async record() {
        touched.record += 1;
      },
      async spentTodayCents() {
        return 0;
      },
    };
    const res = await makeApp({
      caller,
      provisioner,
      breaker,
      funding: NOT_FUNDED,
    })(OK_BODY);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error:
        "AI generation uses Omni credits. Buy credits or upgrade to Pro to start, or use your own key.",
      code: "payment_required",
    });
    expect(provisionCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(touched).toEqual({ isTripped: 0, record: 0 });
  });

  test("a funding lookup failure fails closed", async () => {
    const { caller, calls } = makeCaller(VERDICT);
    const res = await makeApp({ caller, funding: new Error("aether down") })(
      OK_BODY,
    );
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("payment_required");
    expect(calls).toHaveLength(0);
  });

  test("a paid tier is eligible without a funding lookup", async () => {
    const fundingCalls: string[] = [];
    const res = await makeApp({
      tier: "pro",
      funding: NOT_FUNDED,
      fundingCalls,
    })(OK_BODY);
    expect(res.status).toBe(200);
    expect(fundingCalls).toHaveLength(0);
  });

  test("a free workspace that bought credits is served even when the breaker is tripped", async () => {
    const breaker = createSpendBreaker(100);
    await breaker.record(100);
    const fundingCalls: string[] = [];
    const res = await makeApp({ breaker, funding: FUNDED, fundingCalls })(
      OK_BODY,
    );
    expect(res.status).toBe(200);
    expect(fundingCalls).toEqual(["ws-user-1"]);
    // a paying customer's spend never counts toward the free ceiling
    expect(await breaker.spentTodayCents()).toBe(100);
  });

  test("the tier is resolved for the personal workspace, not the user", async () => {
    const tierCalls: string[] = [];
    await makeApp({ tierCalls })(OK_BODY);
    expect(tierCalls).toEqual(["ws-user-1"]);
  });

  test("a token without a personal workspace is a re-auth 401 with no provisioning or call", async () => {
    const { provisioner, calls: provisionCalls } = makeProvisioner();
    const { caller, calls } = makeCaller(VERDICT);
    const tierCalls: string[] = [];
    const res = await makeApp({
      caller,
      provisioner,
      tierCalls,
      authenticate: makeAuthenticator({
        userId: "user-1",
        personalWorkspace: null,
      }).authenticate,
    })(OK_BODY);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe(
      "Sign in again to keep using AI generation.",
    );
    expect(provisionCalls).toHaveLength(0);
    expect(tierCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("a gateway 429 (usage limit) surfaces as a usage-limit 429", async () => {
    const caller = (async () => {
      throw new SynapseRequestError("synapse request failed: status 429", 429);
    }) as Caller;
    const res = await makeApp({ caller })(OK_BODY);
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text).toMatch(/usage limit/i);
    expect(text).not.toContain("synapse");
  });

  test("a gateway 403 (entitlement denied) surfaces as a plan-related 403", async () => {
    const caller = (async () => {
      throw new SynapseRequestError("synapse request failed: status 403", 403);
    }) as Caller;
    const res = await makeApp({ caller })(OK_BODY);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toMatch(/plan/i);
    expect(text).not.toContain("synapse");
  });

  test("a provisioning 403 (plan denies API access) is a plan-related 403", async () => {
    const { caller, calls } = makeCaller(VERDICT);
    const res = await makeApp({
      caller,
      provisioner: {
        resolveKey: async () => {
          throw new SynapseProvisionError(
            "provision-managed-key failed: 403",
            403,
          );
        },
      },
    })(OK_BODY);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/plan/i);
    expect(calls).toHaveLength(0);
  });

  test("BYOK bypasses the managed gating and is not recorded", async () => {
    const { provisioner, calls: provisionCalls } = makeProvisioner();
    const { caller, calls } = makeCaller(VERDICT);
    const breaker = createSpendBreaker(500);
    const res = await makeApp({ caller, provisioner, breaker })({
      ...OK_BODY,
      byokKey: "sk-user",
    });
    expect(res.status).toBe(200);
    expect(calls[0]!.apiKey).toBe("sk-user");
    expect(provisionCalls).toHaveLength(0);
    expect(await breaker.spentTodayCents()).toBe(0);
  });

  test("422 when the model does not return a JSON verdict", async () => {
    const res = await makeApp({ caller: makeCaller("no json here").caller })(
      OK_BODY,
    );
    expect(res.status).toBe(422);
  });

  test("emits facet.generation.critiqued with the verdict, correlated to the generation", async () => {
    const { events, emitted } = makeEvents();
    const res = await makeApp({ events })({
      ...OK_BODY,
      generationId: "gen-xyz-9",
    });

    expect(res.status).toBe(200);
    // the emit is fire-and-forget, so let the microtask settle
    await Promise.resolve();
    expect(emitted).toHaveLength(1);
    const event = emitted[0]!;
    expect(event.type).toBe("facet.generation.critiqued");
    expect(event.correlationId).toBe("gen-xyz-9");
    expect(event.subject).toBe("user-1");
    expect(event.data).toMatchObject({
      byok: false,
      userId: "user-1",
      ok: false,
      issueCount: 2,
    });
    // never leak the prompt or the code into telemetry
    const serialized = JSON.stringify(event.data);
    expect(serialized).not.toContain("scorpio");
    expect(serialized).not.toContain("cube(10)");
  });

  test("a failed critique emits no event", async () => {
    const { events, emitted } = makeEvents();
    const res = await makeApp({ events, caller: makeCaller("no json").caller })(
      OK_BODY,
    );
    expect(res.status).toBe(422);
    await Promise.resolve();
    expect(emitted).toHaveLength(0);
  });
});
