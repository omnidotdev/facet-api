import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getAiConfig } from "./ai.config";

const KEYS = [
  "SYNAPSE_BASE_URL",
  "SYNAPSE_API_KEY",
  "FACET_AI_MODEL",
  "MAX_PROMPT_CHARS",
  "MAX_OUTPUT_TOKENS",
  "DAILY_SPEND_CEILING_CENTS",
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
    expect(cfg.model).toBe("claude-opus-5-5");
    expect(cfg.maxPromptChars).toBe(2000);
    expect(cfg.maxOutputTokens).toBe(2048);
    expect(cfg.dailySpendCeilingCents).toBe(500);
    expect(cfg.maxRepairAttempts).toBe(2);
    expect(cfg.rateLimitWindowMs).toBe(60_000);
    expect(cfg.rateLimitMax).toBe(20);
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
    process.env.FACET_AI_MODEL = "claude-haiku-5-5";
    expect(getAiConfig().rate).toEqual({
      inputCentsPerMTok: 10,
      outputCentsPerMTok: 50,
    });

    process.env.FACET_AI_MODEL = "some-unknown-model";
    expect(getAiConfig().rate).toEqual({
      inputCentsPerMTok: 400,
      outputCentsPerMTok: 2000,
    });
  });
});
