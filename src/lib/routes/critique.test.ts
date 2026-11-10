import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Elysia } from "elysia";

import { createSpendBreaker } from "lib/cost/breaker";
import { createRateLimiter } from "lib/cost/rateLimit";
import { createCritiqueRoute } from "./critique";

import type { SpendBreaker } from "lib/cost/breaker";
import type { CreditStore } from "lib/cost/creditStore";
import type { RateLimiter } from "lib/cost/rateLimit";

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
  creditStore?: CreditStore;
  provisioner?: { resolveKey: (userId: string) => Promise<string> };
}

const makeCreditStore = (capCredits = 1000, seedUsed = 0) => {
  const used = new Map<string, number>();
  const spendCalls: { userId: string; credits: number }[] = [];
  const store: CreditStore = {
    async getMonthlyUsage(userId) {
      return { usedCredits: used.get(userId) ?? seedUsed, capCredits };
    },
    async recordSpend(userId, credits) {
      spendCalls.push({ userId, credits });
      used.set(userId, (used.get(userId) ?? seedUsed) + credits);
    },
  };
  return { store, spendCalls };
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
      creditStore: overrides.creditStore ?? makeCreditStore().store,
      provisioner: overrides.provisioner,
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
  "SYNAPSE_API_KEY",
  "MAX_PROMPT_CHARS",
  "CREDIT_COGS_MARKUP",
  "FREE_MONTHLY_CREDITS",
  "FACET_MANAGED_ALLOWLIST",
] as const;
let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) snapshot[k] = process.env[k];
  process.env.SYNAPSE_API_KEY = "server-key"; // enable managed
  process.env.FACET_MANAGED_ALLOWLIST = "";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe("createCritiqueRoute", () => {
  test("returns a structured verdict and meters credits", async () => {
    const { store, spendCalls } = makeCreditStore();
    const res = await makeApp({ creditStore: store })(OK_BODY);
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
    // costCents 1.4 * markup 2 = ceil(2.8) = 3 credits
    expect(spendCalls).toEqual([{ userId: "user-1", credits: 3 }]);
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

  test("402 when the monthly credit cap is exhausted", async () => {
    const { store } = makeCreditStore(100, 100);
    const res = await makeApp({ creditStore: store })(OK_BODY);
    expect(res.status).toBe(402);
  });

  test("BYOK bypasses the managed gating and is not metered", async () => {
    const { store, spendCalls } = makeCreditStore();
    const { caller, calls } = makeCaller(VERDICT);
    const res = await makeApp({ caller, creditStore: store })({
      ...OK_BODY,
      byokKey: "sk-user",
    });
    expect(res.status).toBe(200);
    expect(calls[0]!.apiKey).toBe("sk-user");
    expect(spendCalls).toEqual([]);
  });

  test("422 when the model does not return a JSON verdict", async () => {
    const res = await makeApp({ caller: makeCaller("no json here").caller })(
      OK_BODY,
    );
    expect(res.status).toBe(422);
  });
});
