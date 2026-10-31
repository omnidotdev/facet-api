import { describe, expect, test } from "bun:test";

import { callSynapse } from "./client";

import type { SynapseClientOptions } from "./client";

/**
 * Build a mock fetch that records the last request and returns a canned
 * Anthropic-compatible response body
 */
const mockFetch = (
  body: unknown,
  status = 200,
): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
};

const anthropicResponse = (text: string, input = 100, output = 50) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
  usage: { input_tokens: input, output_tokens: output },
});

const baseOpts: SynapseClientOptions = {
  baseUrl: "https://synapse.test",
  serverApiKey: "server-key",
  model: "claude-opus-5-5",
  inputCentsPerMTok: 400,
  outputCentsPerMTok: 2000,
};

describe("callSynapse", () => {
  test("posts to /v1/messages with system, messages and max_tokens", async () => {
    const { fetchImpl, calls } = mockFetch(anthropicResponse("hello"));

    await callSynapse(
      {
        system: "SYS",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 1234,
      },
      { ...baseOpts, fetchImpl },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://synapse.test/v1/messages");
    expect(calls[0]!.init.method).toBe("POST");

    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.model).toBe("claude-opus-5-5");
    expect(sent.system).toBe("SYS");
    expect(sent.max_tokens).toBe(1234);
    expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
    // must not send sampling params (400 on current API version)
    expect(sent.temperature).toBeUndefined();
    expect(sent.top_p).toBeUndefined();
  });

  test("uses the server key when no BYOK key is given", async () => {
    const { fetchImpl, calls } = mockFetch(anthropicResponse("x"));

    await callSynapse(
      {
        system: "s",
        messages: [{ role: "user", content: "p" }],
        maxTokens: 10,
      },
      { ...baseOpts, fetchImpl },
    );

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("x-api-key")).toBe("server-key");
    expect(headers.get("authorization")).toBe("Bearer server-key");
  });

  test("uses the BYOK key when provided and never the server key", async () => {
    const { fetchImpl, calls } = mockFetch(anthropicResponse("x"));

    await callSynapse(
      {
        system: "s",
        messages: [{ role: "user", content: "p" }],
        maxTokens: 10,
        apiKey: "byok-123",
      },
      { ...baseOpts, fetchImpl },
    );

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("x-api-key")).toBe("byok-123");
    expect(headers.get("authorization")).toBe("Bearer byok-123");
    expect(String(calls[0]!.init.body)).not.toContain("server-key");
  });

  test("parses the first text block and token usage", async () => {
    const { fetchImpl } = mockFetch(
      anthropicResponse("const x = cube(10);", 200, 100),
    );

    const result = await callSynapse(
      {
        system: "s",
        messages: [{ role: "user", content: "p" }],
        maxTokens: 10,
      },
      { ...baseOpts, fetchImpl },
    );

    expect(result.text).toBe("const x = cube(10);");
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(100);
  });

  test("estimates cost from tokens and the configured per-model rate", async () => {
    const { fetchImpl } = mockFetch(
      anthropicResponse("x", 1_000_000, 1_000_000),
    );

    const result = await callSynapse(
      {
        system: "s",
        messages: [{ role: "user", content: "p" }],
        maxTokens: 10,
      },
      { ...baseOpts, fetchImpl },
    );

    // 1M input at 400 c/MTok + 1M output at 2000 c/MTok
    expect(result.usage.costCents).toBeCloseTo(2400, 5);
  });

  test("prefers an explicit cost returned by Synapse over the estimate", async () => {
    const body = {
      ...anthropicResponse("x", 1_000_000, 1_000_000),
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cost_cents: 7,
      },
    };
    const { fetchImpl } = mockFetch(body);

    const result = await callSynapse(
      {
        system: "s",
        messages: [{ role: "user", content: "p" }],
        maxTokens: 10,
      },
      { ...baseOpts, fetchImpl },
    );

    expect(result.usage.costCents).toBe(7);
  });

  test("throws a non-leaking error on a non-2xx response", async () => {
    const { fetchImpl } = mockFetch({ error: "upstream boom" }, 502);

    const call = callSynapse(
      {
        system: "s",
        messages: [{ role: "user", content: "p" }],
        maxTokens: 10,
      },
      { ...baseOpts, fetchImpl },
    );

    await expect(call).rejects.toThrow(/synapse request failed/i);
  });
});
