/**
 * AI gateway configuration.
 *
 * Read lazily through `getAiConfig()` so the service boots with no env set and
 * tests can set env before reading. Every value has a safe default; the managed
 * generation path is only enabled when product-scoped key provisioning is
 * configured (there is no shared managed key)
 */

const env = process.env;

/**
 * Per-model spend rates in US cents per million tokens. Used ONLY to estimate
 * real spend for the free-tier daily breaker when Synapse does not report a
 * cost; never for billing (the gateway bills the pooled Aether balance)
 */
interface ModelRate {
  inputCentsPerMTok: number;
  outputCentsPerMTok: number;
}

/**
 * Known Claude model list prices, keyed by the Synapse model id
 * (provider-prefixed, e.g. anthropic/...) since that is what is sent to the
 * gateway. Synapse is the source of truth for real spend when it returns a
 * cost; this table only backs the breaker's estimate
 */
const BREAKER_ESTIMATE_RATES: Record<string, ModelRate> = {
  "anthropic/claude-opus-4-6": {
    inputCentsPerMTok: 1500,
    outputCentsPerMTok: 7500,
  },
  "anthropic/claude-sonnet-4-5-20250929": {
    inputCentsPerMTok: 300,
    outputCentsPerMTok: 1500,
  },
  "anthropic/claude-haiku-4-5-20251001": {
    inputCentsPerMTok: 100,
    outputCentsPerMTok: 500,
  },
};

/** Fallback rate for an unknown model, conservative so the breaker never under-counts */
const DEFAULT_MODEL_RATE: ModelRate = {
  inputCentsPerMTok: 400,
  outputCentsPerMTok: 2000,
};

// Sonnet is the default: strong at code and far cheaper per token than Opus,
// which matters for a high-volume generation endpoint. Model ids are Synapse's
// provider-prefixed ids (confirmed against the gateway's /v1/models). Override
// with FACET_AI_MODEL (e.g. anthropic/claude-opus-4-6) for maximum quality
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5-20250929";

// The default is now Synapse smart routing: the virtual `auto` model lets the
// gateway pick the best/cheapest model per request. If the gateway refuses the virtual
// model for this key (not entitled, or an unknown id), callSynapse degrades to
// the concrete fallback below, so routing can never break generation. Override
// the routed model with FACET_AI_MODEL and the concrete fallback with
// FACET_AI_FALLBACK_MODEL
const DEFAULT_ROUTED_MODEL = "auto";

// Synapse's provider-agnostic virtual models (unprefixed). A failure on one of
// these is treated as a routing/entitlement miss and degrades to the fallback;
// a concrete model's failure is a real error and is not retried
const VIRTUAL_MODELS = new Set(["auto", "best", "fast", "cheap"]);

/** Whether a model id is a Synapse virtual (smart-routed) model. */
export const isVirtualModel = (model: string): boolean =>
  VIRTUAL_MODELS.has(model.toLowerCase());

/** Resolve the estimate rate for a model, falling back to a conservative default */
const rateForModel = (model: string): ModelRate =>
  BREAKER_ESTIMATE_RATES[model] ?? DEFAULT_MODEL_RATE;

const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

interface AiConfig {
  /** Synapse base URL, without a trailing slash. */
  synapseBaseUrl: string;
  /** Synapse provisioning API base URL (api.synapse, not the gateway), for product-scoped managed keys. */
  synapseApiUrl: string | undefined;
  /** Gateway secret authorizing the internal provisioning call. */
  synapseGatewaySecret: string | undefined;
  /** Model id passed to Synapse: a virtual routed model (`auto`) or a concrete id. */
  model: string;
  /** Breaker estimate rate for the active model. */
  rate: ModelRate;
  /** Concrete model used if a virtual/routed `model` is refused by the gateway. */
  fallbackModel: string;
  /** Breaker estimate rate for the fallback model. */
  fallbackRate: ModelRate;
  /**
   * Whether the managed generation path is enabled: true only when
   * product-scoped key provisioning is configured. With it off, the managed
   * path answers 503 and BYOK keeps working
   */
  managedEnabled: boolean;
  /** Maximum accepted prompt length in characters. */
  maxPromptChars: number;
  /** Maximum output tokens requested from the model. */
  maxOutputTokens: number;
  /** Request timeout to Synapse in milliseconds. */
  requestTimeoutMs: number;
  /** Maximum repair attempts honored per logical generation (enforced server-side). */
  maxRepairAttempts: number;
  /** Free-tier managed spend ceiling per UTC day in US cents (the breaker backstop). */
  dailySpendCeilingCents: number;
  /** Per-IP rate limit window in milliseconds. */
  rateLimitWindowMs: number;
  /** Maximum requests per IP per window. */
  rateLimitMax: number;
  /**
   * Allowlist of Omni user ids permitted to use the managed path. When
   * non-empty, every other signed-in user is refused the managed path and must
   * use BYOK, so only these users can ever run managed generation. Empty
   * means no restriction. The ids live ONLY in this env var, never in code or
   * git, so no personal identifier is ever committed
   */
  managedAllowlist: string[];
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
  const synapseApiUrl = env.SYNAPSE_API_URL?.replace(/\/+$/, "") || undefined;
  const synapseGatewaySecret = env.SYNAPSE_GATEWAY_SECRET || undefined;
  const model = env.FACET_AI_MODEL ?? DEFAULT_ROUTED_MODEL;
  const fallbackModel = env.FACET_AI_FALLBACK_MODEL || DEFAULT_MODEL;

  return {
    synapseBaseUrl,
    synapseApiUrl,
    synapseGatewaySecret,
    model,
    rate: rateForModel(model),
    fallbackModel,
    fallbackRate: rateForModel(fallbackModel),
    managedEnabled: Boolean(synapseApiUrl && synapseGatewaySecret),
    maxPromptChars: toInt(env.MAX_PROMPT_CHARS, 2000),
    maxOutputTokens: toInt(env.MAX_OUTPUT_TOKENS, 2048),
    requestTimeoutMs: toInt(env.AI_REQUEST_TIMEOUT_MS, 30_000),
    maxRepairAttempts: toInt(env.MAX_REPAIR_ATTEMPTS, 2),
    dailySpendCeilingCents: toInt(env.DAILY_SPEND_CEILING_CENTS, 500),
    rateLimitWindowMs: toInt(env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: toInt(env.RATE_LIMIT_MAX, 20),
    managedAllowlist: (env.FACET_MANAGED_ALLOWLIST ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  };
};
