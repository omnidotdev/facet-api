import {
  SynapseRequestError,
  createSynapseClient,
  estimateSynapseCostCents,
} from "@omnidotdev/providers/ai";

import { getAiConfig, isVirtualModel } from "lib/config/ai.config";

import type { SynapseContentBlock } from "@omnidotdev/providers/ai";

export type { SynapseContentBlock };

/**
 * Facet's binding over the shared Synapse client (`@omnidotdev/providers/ai`).
 *
 * The request/parse logic lives in the shared `createSynapseClient` (the
 * fleet's one blessed `/v1/messages` wrapper); this module only binds it to
 * Facet's config (base URL, model, breaker estimate rate) and preserves the
 * `callSynapse(input, options?)` surface. There is no server key: every call
 * carries its own key, either the product-scoped managed key provisioned for
 * the user or the caller's BYOK key. A gateway refusal throws the shared
 * `SynapseRequestError`, whose `status` the routes map onto their UX
 */

/**
 * A single Anthropic-style conversation turn. `content` is a plain string for a
 * text turn, or an array of blocks for a multimodal turn (text + inline images,
 * e.g. a render handed to a vision model for critique)
 */
interface SynapseMessage {
  role: "user" | "assistant";
  content: string | SynapseContentBlock[];
}

interface SynapseCallInput {
  /** System prompt. */
  system: string;
  /** Conversation turns. */
  messages: SynapseMessage[];
  /** Output token ceiling for this call. */
  maxTokens: number;
  /** The key for this call: the product-scoped managed key or a BYOK key */
  apiKey: string;
}

interface SynapseUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Real spend for this call in US cents, from Synapse if reported, else
   * estimated. Feeds only the free-tier breaker, never billing
   */
  costCents: number;
}

interface SynapseResult {
  text: string;
  usage: SynapseUsage;
}

export interface SynapseClientOptions {
  baseUrl: string;
  model: string;
  inputCentsPerMTok: number;
  outputCentsPerMTok: number;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Injectable fetch, defaults to the global. */
  fetchImpl?: typeof fetch;
}

/** Pull config-backed defaults so callers can invoke with just an input. */
const optionsFromConfig = (): SynapseClientOptions => {
  const cfg = getAiConfig();
  return {
    baseUrl: cfg.synapseBaseUrl,
    model: cfg.model,
    inputCentsPerMTok: cfg.rate.inputCentsPerMTok,
    outputCentsPerMTok: cfg.rate.outputCentsPerMTok,
    timeoutMs: cfg.requestTimeoutMs,
  };
};

/** One `/v1/messages` call against a specific model, resolving cost to a number. */
const callOnce = async (
  opts: SynapseClientOptions,
  input: SynapseCallInput,
): Promise<SynapseResult> => {
  const rate = {
    inputCentsPerMTok: opts.inputCentsPerMTok,
    outputCentsPerMTok: opts.outputCentsPerMTok,
  };

  const client = createSynapseClient({
    baseUrl: opts.baseUrl,
    model: opts.model,
    rate,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });

  const result = await client.messages({
    system: input.system,
    messages: input.messages,
    maxTokens: input.maxTokens,
    apiKey: input.apiKey,
  });

  // The shared client returns null cost only without a rate; Facet always
  // configures one, so this coercion keeps costCents a number for the breaker
  const costCents =
    result.usage.costCents ??
    estimateSynapseCostCents(
      result.usage.inputTokens,
      result.usage.outputTokens,
      rate,
    );

  return {
    text: result.text,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costCents,
    },
  };
};

/**
 * Call Synapse's `/v1/messages` via the shared client. Returns the concatenated
 * text and a usage record (cost always resolved to a number, since Facet always
 * configures a rate). Throws a generic, non-leaking error on failure.
 *
 * When the configured model is a Synapse virtual/routed model (`auto`, `best`,
 * ...) and the gateway refuses it (this key is not entitled for smart routing,
 * or the id is unknown), the call degrades once to the concrete fallback model
 * so generation never breaks. A concrete model's failure is a real error and is
 * surfaced, not retried. An explicit per-request model override opts out of the
 * fallback (the caller asked for that exact model). An out-of-credits refusal
 * (402) is never retried: the balance is empty for every model, and a retry
 * would only hide the real state from the user
 */
export const callSynapse = async (
  input: SynapseCallInput,
  options?: Partial<SynapseClientOptions>,
): Promise<SynapseResult> => {
  const opts: SynapseClientOptions = { ...optionsFromConfig(), ...options };

  try {
    return await callOnce(opts, input);
  } catch (err) {
    const cfg = getAiConfig();
    const modelOverridden = options?.model !== undefined;
    const outOfCredits =
      err instanceof SynapseRequestError && err.status === 402;
    const canFallback =
      !outOfCredits &&
      !modelOverridden &&
      isVirtualModel(opts.model) &&
      opts.model !== cfg.fallbackModel;
    if (!canFallback) throw err;

    return callOnce(
      {
        ...opts,
        model: cfg.fallbackModel,
        inputCentsPerMTok: cfg.fallbackRate.inputCentsPerMTok,
        outputCentsPerMTok: cfg.fallbackRate.outputCentsPerMTok,
      },
      input,
    );
  }
};
