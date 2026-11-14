import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createSpendBreaker } from "@omnidotdev/providers";
import { SynapseRequestError } from "@omnidotdev/providers/ai";
import { Elysia } from "elysia";

import { createRateLimiter } from "lib/cost/rateLimit";
import { createCritiqueRoute } from "./critique";

import type { SpendBreaker } from "@omnidotdev/providers";
import type { RateLimiter } from "lib/cost/rateLimit";
import type { ManagedKeyProvisioner } from "lib/synapse/provisioner";

type Caller = Parameters<typeof createCritiqueRoute>[0]["callSynapse"];
type Authenticate = Parameters<typeof createCritiqueRoute>[0]["authenticate"];

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
  provisioner?: ManagedKeyProvisioner;
  tier?: string;
}

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

const makeAuthenticator = (identity: { userId: string } | null) => {
  const authenticate: Authenticate = async () => identity;
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
      provisioner: overrides.provisioner ?? makeProvisioner().provisioner,
      resolveTier: async () => overrides.tier ?? "free",
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
    expect(provisionCalls).toEqual([
      ["user-1", undefined, { entityType: "user", entityId: "user-1" }],
    ]);
    expect(calls[0]!.apiKey).toBe("sk-scoped-user-1");
    // free-tier real spend reaches the breaker backstop
    expect(await breaker.spentTodayCents()).toBeCloseTo(1.4);
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
});
