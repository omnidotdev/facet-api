import {
  createSynapseClient,
  estimateSynapseCostCents,
} from "@omnidotdev/providers/ai";

import { getAiConfig } from "lib/config/ai.config";

/**
 * Facet's binding over the shared Synapse client (`@omnidotdev/providers/ai`).
 *
 * The request/parse logic now lives in the shared `createSynapseClient` (the
 * fleet's one blessed `/v1/messages` wrapper); this module only binds it to
 * Facet's config (base URL, model, rate, server key) and preserves the existing
 * `callSynapse(input, options?)` surface so callers are unchanged. The server
 * Synapse key is used by default; a per-request BYOK key overrides it
 */

/** A single Anthropic-style conversation turn. */
interface SynapseMessage {
  role: "user" | "assistant";
  content: string;
}

interface SynapseCallInput {
  /** System prompt. */
  system: string;
  /** Conversation turns. */
  messages: SynapseMessage[];
  /** Output token ceiling for this call. */
  maxTokens: number;
  /** Optional BYOK key, used instead of the server key when present. */
  apiKey?: string;
}

interface SynapseUsage {
  inputTokens: number;
  outputTokens: number;
  /** Spend for this call in US cents, from Synapse if reported, else estimated. */
  costCents: number;
}

interface SynapseResult {
  text: string;
  usage: SynapseUsage;
}

export interface SynapseClientOptions {
  baseUrl: string;
  /** Server-side key, used when the input carries no BYOK key. */
  serverApiKey?: string;
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
    serverApiKey: cfg.synapseApiKey,
    model: cfg.model,
    inputCentsPerMTok: cfg.rate.inputCentsPerMTok,
    outputCentsPerMTok: cfg.rate.outputCentsPerMTok,
    timeoutMs: cfg.requestTimeoutMs,
  };
};

/**
 * Call Synapse's `/v1/messages` via the shared client. Returns the concatenated
 * text and a usage record (cost always resolved to a number, since Facet always
 * configures a rate). Throws a generic, non-leaking error on failure
 */
export const callSynapse = async (
  input: SynapseCallInput,
  options?: Partial<SynapseClientOptions>,
): Promise<SynapseResult> => {
  const opts: SynapseClientOptions = { ...optionsFromConfig(), ...options };
  const rate = {
    inputCentsPerMTok: opts.inputCentsPerMTok,
    outputCentsPerMTok: opts.outputCentsPerMTok,
  };

  const client = createSynapseClient({
    baseUrl: opts.baseUrl,
    apiKey: opts.serverApiKey,
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
  // configures one, so this coercion keeps costCents a number for the meter
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
