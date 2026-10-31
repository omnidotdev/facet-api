/**
 * AI gateway configuration.
 *
 * Read lazily through `getAiConfig()` so the service boots with no env set and
 * tests can set env before reading. Every value has a safe default; the managed
 * generation path is only enabled when a server Synapse key is present
 */

const env = process.env;

/** Per-model spend rates in US cents per million tokens, used when Synapse does not return a cost. */
interface ModelRate {
  inputCentsPerMTok: number;
  outputCentsPerMTok: number;
}

/**
 * Known Claude model rates (Anthropic first-party list prices).
 * Synapse is the source of truth for real spend when it returns a cost; this
 * table only backs the estimate fallback
 */
const MODEL_RATES: Record<string, ModelRate> = {
  "claude-opus-5-5": { inputCentsPerMTok: 400, outputCentsPerMTok: 2000 },
  "claude-opus-5": { inputCentsPerMTok: 500, outputCentsPerMTok: 2500 },
  "claude-sonnet-5-5": { inputCentsPerMTok: 200, outputCentsPerMTok: 1000 },
  "claude-haiku-5-5": { inputCentsPerMTok: 10, outputCentsPerMTok: 50 },
};

/** Fallback rate for an unknown model, conservative (Opus-tier) so we never under-charge. */
const DEFAULT_MODEL_RATE: ModelRate = {
  inputCentsPerMTok: 400,
  outputCentsPerMTok: 2000,
};

// Sonnet is the default: latest-generation, strong at code, and far cheaper per
// token than Opus, which matters for a high-volume generation endpoint. Override
// with FACET_AI_MODEL (e.g. claude-opus-5-5) when a request needs maximum quality
const DEFAULT_MODEL = "claude-sonnet-5-5";

/** Resolve the spend rate for a model, falling back to a conservative default. */
const rateForModel = (model: string): ModelRate =>
  MODEL_RATES[model] ?? DEFAULT_MODEL_RATE;

const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

interface AiConfig {
  /** Synapse base URL, without a trailing slash. */
  synapseBaseUrl: string;
  /** Server-side Synapse key, undefined when the managed path is disabled. */
  synapseApiKey: string | undefined;
  /** Claude model id passed through to Synapse. */
  model: string;
  /** Spend rate for the active model. */
  rate: ModelRate;
  /** Whether the managed (our-key) generation path is enabled. */
  managedEnabled: boolean;
  /** Maximum accepted prompt length in characters. */
  maxPromptChars: number;
  /** Maximum output tokens requested from the model. */
  maxOutputTokens: number;
  /** Request timeout to Synapse in milliseconds. */
  requestTimeoutMs: number;
  /** Maximum repair attempts honored per logical generation (enforced server-side). */
  maxRepairAttempts: number;
  /** Global managed spend ceiling per UTC day in US cents. */
  dailySpendCeilingCents: number;
  /** Per-IP rate limit window in milliseconds. */
  rateLimitWindowMs: number;
  /** Maximum requests per IP per window. */
  rateLimitMax: number;
}

/**
 * Read the AI gateway configuration from the environment.
 *
 * Reads `process.env` on each call so the value tracks the current environment
 */
export const getAiConfig = (): AiConfig => {
  const synapseBaseUrl = (
    env.SYNAPSE_BASE_URL ?? "http://localhost:6000"
  ).replace(/\/+$/, "");
  const synapseApiKey = env.SYNAPSE_API_KEY || undefined;
  const model = env.FACET_AI_MODEL ?? DEFAULT_MODEL;

  return {
    synapseBaseUrl,
    synapseApiKey,
    model,
    rate: rateForModel(model),
    managedEnabled: Boolean(synapseApiKey),
    maxPromptChars: toInt(env.MAX_PROMPT_CHARS, 2000),
    maxOutputTokens: toInt(env.MAX_OUTPUT_TOKENS, 2048),
    requestTimeoutMs: toInt(env.AI_REQUEST_TIMEOUT_MS, 30_000),
    maxRepairAttempts: toInt(env.MAX_REPAIR_ATTEMPTS, 2),
    dailySpendCeilingCents: toInt(env.DAILY_SPEND_CEILING_CENTS, 500),
    rateLimitWindowMs: toInt(env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: toInt(env.RATE_LIMIT_MAX, 20),
  };
};
