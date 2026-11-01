import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getAiConfig } from "./ai.config";

const KEYS = [
  "SYNAPSE_BASE_URL",
  "SYNAPSE_API_KEY",
  "FACET_AI_MODEL",
  "MAX_PROMPT_CHARS",
  "MAX_OUTPUT_TOKENS",
  "DAILY_SPEND_CEILING_CENTS",
  "FREE_MONTHLY_CREDITS",
  "RATE_LIMIT_WINDOW_MS",
  "RATE_LIMIT_MAX",
] as const;

let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const k of KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe("getAiConfig", () => {
  test("boots with safe defaults and the managed path disabled when no key is set", () => {
    const cfg = getAiConfig();
    expect(cfg.managedEnabled).toBe(false);
    expect(cfg.synapseApiKey).toBeUndefined();
    expect(cfg.model).toBe("anthropic/claude-sonnet-4-5-20250929");
    expect(cfg.maxPromptChars).toBe(2000);
    expect(cfg.maxOutputTokens).toBe(2048);
    expect(cfg.dailySpendCeilingCents).toBe(500);
    expect(cfg.freeMonthlyCredits).toBe(100);
    expect(cfg.maxRepairAttempts).toBe(2);
    expect(cfg.rateLimitWindowMs).toBe(60_000);
    expect(cfg.rateLimitMax).toBe(20);
  });

  test("the default model is a Synapse provider-prefixed id with an explicit rate", () => {
    // Guards the class of bug that broke managed + BYOK: a bare id like
    // "claude-sonnet-5-5" 404s at the Synapse gateway, which only accepts
    // provider-prefixed ids (e.g. anthropic/...). The default must also carry an
    // explicit rate, not the conservative opus-tier fallback
    const cfg = getAiConfig();
    expect(cfg.model).toMatch(/^[a-z0-9-]+\/.+/);
    expect(cfg.rate).not.toEqual({
      inputCentsPerMTok: 400,
      outputCentsPerMTok: 2000,
    });
  });

  test("enables the managed path once a server key is present", () => {
    process.env.SYNAPSE_API_KEY = "server-key";
    expect(getAiConfig().managedEnabled).toBe(true);
  });

  test("strips a trailing slash from the base url", () => {
    process.env.SYNAPSE_BASE_URL = "https://synapse.example.com/";
    expect(getAiConfig().synapseBaseUrl).toBe("https://synapse.example.com");
  });

  test("falls back to the default for non-positive or invalid numeric env", () => {
    process.env.MAX_PROMPT_CHARS = "0";
    process.env.MAX_OUTPUT_TOKENS = "not-a-number";
    const cfg = getAiConfig();
    expect(cfg.maxPromptChars).toBe(2000);
    expect(cfg.maxOutputTokens).toBe(2048);
  });

  test("resolves the spend rate for the active model with a conservative fallback", () => {
    process.env.FACET_AI_MODEL = "anthropic/claude-haiku-4-5-20251001";
    expect(getAiConfig().rate).toEqual({
      inputCentsPerMTok: 100,
      outputCentsPerMTok: 500,
    });

    process.env.FACET_AI_MODEL = "some-unknown-model";
    expect(getAiConfig().rate).toEqual({
      inputCentsPerMTok: 400,
      outputCentsPerMTok: 2000,
    });
  });
});
