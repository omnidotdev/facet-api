import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Elysia } from "elysia";

import { createSpendBreaker } from "lib/cost/breaker";
import { createRateLimiter } from "lib/cost/rateLimit";
import { createGenerateRoute } from "./generate";

import type { SpendBreaker } from "lib/cost/breaker";
import type { CreditStore } from "lib/cost/creditStore";
import type { RateLimiter } from "lib/cost/rateLimit";

const CODE = "const part = cube(10);\nreturn part;";
const FENCED = `Here you go:\n\`\`\`ts\n${CODE}\n\`\`\``;

type Caller = Parameters<typeof createGenerateRoute>[0]["callSynapse"];
type Authenticate = Parameters<typeof createGenerateRoute>[0]["authenticate"];

interface Overrides {
  caller?: Caller;
  breaker?: SpendBreaker;
  rateLimiter?: RateLimiter;
  authenticate?: Authenticate;
  creditStore?: CreditStore;
}

/**
 * In-memory CreditStore fake. Every user starts at `seedUsed` credits against a
 * shared `capCredits`, and recordSpend accumulates, so the enforcement logic is
 * exercised with no database
 */
const makeCreditStore = (capCredits = 1000, seedUsed = 0) => {
  const used = new Map<string, number>();
  const getCalls: string[] = [];
  const spendCalls: { userId: string; credits: number }[] = [];
  const store: CreditStore = {
    async getMonthlyUsage(userId) {
      getCalls.push(userId);
      return { usedCredits: used.get(userId) ?? seedUsed, capCredits };
    },
    async recordSpend(userId, credits) {
      spendCalls.push({ userId, credits });
      used.set(userId, (used.get(userId) ?? seedUsed) + credits);
    },
  };
  return { store, getCalls, spendCalls };
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

const makeApp = (overrides: Overrides = {}) => {
  const caller = overrides.caller ?? makeCaller(FENCED).caller;
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
      // default to a generous cap so managed-path tests are not credit-blocked
      creditStore: overrides.creditStore ?? makeCreditStore().store,
    }),
  );

  return (body: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request("http://test/generate", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
};

const ENV_KEYS = [
  "SYNAPSE_API_KEY",
  "MAX_PROMPT_CHARS",
  "MAX_OUTPUT_TOKENS",
  "MAX_REPAIR_ATTEMPTS",
] as const;
let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) snapshot[k] = process.env[k];
  // managed path enabled by default
  process.env.SYNAPSE_API_KEY = "server-key-secret";
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
  test("happy path extracts the fenced code and computes credits", async () => {
    const request = makeApp();
    const res = await request({ prompt: "a 10mm cube" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.code).toBe(CODE);
    // 1.4 cents -> ceil -> 2 credits
    expect(json.usage.credits).toBe(2);
    expect(json.usage.costCents).toBeCloseTo(1.4, 5);
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

  test("returns 503 when the managed path is disabled and no BYOK key is given", async () => {
    process.env.SYNAPSE_API_KEY = "";
    const { caller, calls } = makeCaller(FENCED);
    const request = makeApp({ caller });
    const res = await request({ prompt: "a cube" });

    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test("returns 503 when the daily breaker is tripped (managed path)", async () => {
    const breaker = createSpendBreaker(100);
    breaker.record(100);
    const { caller, calls } = makeCaller(FENCED);
    const request = makeApp({ caller, breaker });
    const res = await request({ prompt: "a cube" });

    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test("BYOK path bypasses the breaker and the managed-disabled check", async () => {
    process.env.SYNAPSE_API_KEY = "";
    const breaker = createSpendBreaker(100);
    breaker.record(100); // tripped
    const { caller, calls } = makeCaller(FENCED);
    const request = makeApp({ caller, breaker });
    const res = await request({ prompt: "a cube", byokKey: "byok-xyz" });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.apiKey).toBe("byok-xyz");
    // BYOK spend is not recorded against our breaker
    expect(breaker.spentTodayCents()).toBe(100);
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

  test("managed path with a valid identity authenticates and proceeds", async () => {
    const { authenticate, calls: authCalls } = makeAuthenticator({
      userId: "user-42",
    });
    const { caller, calls } = makeCaller(FENCED);
    const request = makeApp({ caller, authenticate });
    const res = await request({ prompt: "a cube" });

    expect(res.status).toBe(200);
    expect(authCalls.count).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("BYOK path skips authentication entirely", async () => {
    const { authenticate, calls: authCalls } = makeAuthenticator(null);
    const { caller, calls } = makeCaller(FENCED);
    const request = makeApp({ caller, authenticate });
    const res = await request({ prompt: "a cube", byokKey: "byok-xyz" });

    expect(res.status).toBe(200);
    expect(authCalls.count).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("managed path over the monthly credit cap returns a generic 402 and never calls Synapse", async () => {
    const { store, spendCalls } = makeCreditStore(100, 100); // used == cap
    const { caller, calls } = makeCaller(FENCED);
    const request = makeApp({ caller, creditStore: store });
    const res = await request({ prompt: "a cube" });

    expect(res.status).toBe(402);
    const json = await res.json();
    expect(typeof json.error).toBe("string");
    expect(calls).toHaveLength(0);
    expect(spendCalls).toHaveLength(0);
  });

  test("managed success records the spent credits against the user", async () => {
    const { store, getCalls, spendCalls } = makeCreditStore(1000, 0);
    const { authenticate } = makeAuthenticator({ userId: "user-42" });
    // 3 cents -> ceil -> 3 credits
    const { caller } = makeCaller(FENCED, 3);
    const request = makeApp({ caller, authenticate, creditStore: store });
    const res = await request({ prompt: "a cube" });

    expect(res.status).toBe(200);
    expect(getCalls).toEqual(["user-42"]);
    expect(spendCalls).toEqual([{ userId: "user-42", credits: 3 }]);
  });

  test("BYOK path never touches the credit meter", async () => {
    const { store, getCalls, spendCalls } = makeCreditStore(100, 100); // over cap
    const { caller, calls } = makeCaller(FENCED);
    const request = makeApp({ caller, creditStore: store });
    const res = await request({ prompt: "a cube", byokKey: "byok-xyz" });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(getCalls).toHaveLength(0);
    expect(spendCalls).toHaveLength(0);
  });

  test("managed path forwards no BYOK key and records spend in the breaker", async () => {
    const breaker = createSpendBreaker(500);
    const { caller, calls } = makeCaller(FENCED, 3);
    const request = makeApp({ caller, breaker });
    const res = await request({ prompt: "a cube" });

    expect(res.status).toBe(200);
    expect(calls[0]!.apiKey).toBeUndefined();
    expect(breaker.spentTodayCents()).toBe(3);
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

  test("returns a generic 502 on an upstream failure and never leaks detail", async () => {
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

  test("never echoes the server Synapse key in the response", async () => {
    const request = makeApp();
    const res = await request({ prompt: "a cube" });
    const text = await res.text();
    expect(text).not.toContain("server-key-secret");
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
});
