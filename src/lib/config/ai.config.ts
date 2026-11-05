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
 * Keyed by the Synapse model id (provider-prefixed, e.g. anthropic/...), since
 * that is what is sent to the gateway. Synapse is the source of truth for real
 * spend when it returns a cost; this table only backs the estimate fallback
 */
const MODEL_RATES: Record<string, ModelRate> = {
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

/** Fallback rate for an unknown model, conservative (Opus-tier) so we never under-charge. */
const DEFAULT_MODEL_RATE: ModelRate = {
  inputCentsPerMTok: 400,
  outputCentsPerMTok: 2000,
};

// Sonnet is the default: strong at code and far cheaper per token than Opus,
// which matters for a high-volume generation endpoint. Model ids are Synapse's
// provider-prefixed ids (confirmed against the gateway's /v1/models). Override
// with FACET_AI_MODEL (e.g. anthropic/claude-opus-4-6) for maximum quality
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5-20250929";

/** Resolve the spend rate for a model, falling back to a conservative default. */
const rateForModel = (model: string): ModelRate =>
  MODEL_RATES[model] ?? DEFAULT_MODEL_RATE;

const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toFloat = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Markup applied when converting real model spend (cents) into billable credits.
 *
 * A credit is a retail unit, not raw cost: one generation debits
 * `ceil(costCents * markup)` credits, so a tier's included allowance carries
 * gross margin over model spend. The default 2.0 yields ~50% gross margin on all
 * managed AI (the standard 1.3-3x range for resold inference), tunable per
 * deployment via `CREDIT_COGS_MARKUP`. This is the Omni fleet credit-economics
 * standard; the eventual home is @omnidotdev/providers so every product that
 * meters AI usage inherits one definition. The spend breaker still tracks REAL
 * cents, so the absolute money-safety ceiling is independent of this markup
 */
const DEFAULT_CREDIT_COGS_MARKUP = 2;

interface AiConfig {
  /** Synapse base URL, without a trailing slash. */
  synapseBaseUrl: string;
  /** Server-side Synapse key, undefined when the managed path is disabled. */
  synapseApiKey: string | undefined;
  /** Synapse provisioning API base URL (api.synapse, not the gateway), for per-user managed keys. */
  synapseApiUrl: string | undefined;
  /** Gateway secret authorizing the internal provisioning call. */
  synapseGatewaySecret: string | undefined;
  /**
   * Whether per-user managed keys are enabled. When true, the managed path
   * provisions a per-user Synapse key so Synapse attributes usage per user;
   * the local credit ledger still enforces the hard monthly cap as a safety net
   */
  perUserManagedEnabled: boolean;
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
  /** Static fallback cap for managed credits per UTC month, used when Aether has no entitlement or is unreachable. */
  freeMonthlyCredits: number;
  /** Markup from real model cents to billable credits (retail unit); see DEFAULT_CREDIT_COGS_MARKUP. */
  creditCogsMarkup: number;
  /** Per-IP rate limit window in milliseconds. */
  rateLimitWindowMs: number;
  /** Maximum requests per IP per window. */
  rateLimitMax: number;
  /**
   * Allowlist of Omni user ids permitted to use the managed (our-key) path.
   * When non-empty, every other signed-in user is refused the managed path and
   * must use BYOK, so only these users can ever spend our Synapse key. Empty
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
  const synapseApiKey = env.SYNAPSE_API_KEY || undefined;
  const synapseApiUrl = env.SYNAPSE_API_URL?.replace(/\/+$/, "") || undefined;
  const synapseGatewaySecret = env.SYNAPSE_GATEWAY_SECRET || undefined;
  const model = env.FACET_AI_MODEL ?? DEFAULT_MODEL;

  return {
    synapseBaseUrl,
    synapseApiKey,
    synapseApiUrl,
    synapseGatewaySecret,
    perUserManagedEnabled: Boolean(synapseApiUrl && synapseGatewaySecret),
    model,
    rate: rateForModel(model),
    managedEnabled: Boolean(synapseApiKey),
    maxPromptChars: toInt(env.MAX_PROMPT_CHARS, 2000),
    maxOutputTokens: toInt(env.MAX_OUTPUT_TOKENS, 2048),
    requestTimeoutMs: toInt(env.AI_REQUEST_TIMEOUT_MS, 30_000),
    maxRepairAttempts: toInt(env.MAX_REPAIR_ATTEMPTS, 2),
    dailySpendCeilingCents: toInt(env.DAILY_SPEND_CEILING_CENTS, 500),
    // Static fallback only: the live cap is the user's included_credits
    // entitlement from Aether (see lib/cost/entitlementCap), used when Aether
    // is unreachable or returns no entitlement
    freeMonthlyCredits: toInt(env.FREE_MONTHLY_CREDITS, 100),
    creditCogsMarkup: toFloat(
      env.CREDIT_COGS_MARKUP,
      DEFAULT_CREDIT_COGS_MARKUP,
    ),
    rateLimitWindowMs: toInt(env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: toInt(env.RATE_LIMIT_MAX, 20),
    managedAllowlist: (env.FACET_MANAGED_ALLOWLIST ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  };
};
