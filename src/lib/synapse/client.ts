import { getAiConfig } from "lib/config/ai.config";

/**
 * Thin client over the Synapse AI router's Anthropic-compatible
 * `POST {baseUrl}/v1/messages` endpoint.
 *
 * Uses the global `fetch` (no SDK, no node: imports) so it is trivially
 * mockable and carries no base-url friction. The server Synapse key is used by
 * default; a per-request BYOK key overrides it and is the only path a caller's
 * own key ever takes
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

/** Anthropic-compatible response shape (only the fields read here). */
interface AnthropicResponseBody {
  content?: { type?: string; text?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost_cents?: number;
  };
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

const estimateCostCents = (
  inputTokens: number,
  outputTokens: number,
  opts: SynapseClientOptions,
): number =>
  (inputTokens / 1_000_000) * opts.inputCentsPerMTok +
  (outputTokens / 1_000_000) * opts.outputCentsPerMTok;

/**
 * Call Synapse's `/v1/messages`. Returns the concatenated text and a usage
 * record. Throws a generic, non-leaking error on a transport or non-2xx
 * failure; callers log the detail server-side and surface a safe message
 */
export const callSynapse = async (
  input: SynapseCallInput,
  options?: Partial<SynapseClientOptions>,
): Promise<SynapseResult> => {
  const opts: SynapseClientOptions = { ...optionsFromConfig(), ...options };
  const doFetch = opts.fetchImpl ?? fetch;

  const key = input.apiKey ?? opts.serverApiKey;
  if (!key) {
    // the managed path must be gated before here, this guards misuse
    throw new Error("synapse request failed: no api key available");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": key,
    authorization: `Bearer ${key}`,
    "anthropic-version": "2023-06-01",
  };

  const payload = {
    model: opts.model,
    max_tokens: input.maxTokens,
    system: input.system,
    messages: input.messages,
  };

  const controller = new AbortController();
  const timeout = opts.timeoutMs
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : undefined;

  let res: Response;
  try {
    res = await doFetch(`${opts.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "transport error";
    throw new Error(`synapse request failed: ${reason}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`synapse request failed: status ${res.status}`);
  }

  const data = (await res.json()) as AnthropicResponseBody;

  const text = (data.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");

  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;
  const costCents =
    typeof data.usage?.cost_cents === "number"
      ? data.usage.cost_cents
      : estimateCostCents(inputTokens, outputTokens, opts);

  return { text, usage: { inputTokens, outputTokens, costCents } };
};
