import { describe, expect, test } from "bun:test";

import { SynapseRequestError } from "@omnidotdev/providers/ai";

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
        apiKey: "sk-scoped",
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

  test("sends the per-call key (the product-scoped managed key)", async () => {
    const { fetchImpl, calls } = mockFetch(anthropicResponse("x"));

    await callSynapse(
      {
        system: "s",
        messages: [{ role: "user", content: "p" }],
        maxTokens: 10,
        apiKey: "sk-scoped",
      },
      { ...baseOpts, fetchImpl },
    );

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("x-api-key")).toBe("sk-scoped");
    expect(headers.get("authorization")).toBe("Bearer sk-scoped");
  });

  test("surfaces the gateway status on a refusal (402 out of credits, 503 unavailable)", async () => {
    for (const status of [402, 503]) {
      const { fetchImpl } = mockFetch({ error: "nope" }, status);
      const call = callSynapse(
        {
          system: "s",
          messages: [{ role: "user", content: "p" }],
          maxTokens: 10,
          apiKey: "sk-scoped",
        },
        { ...baseOpts, fetchImpl },
      );
      await expect(call).rejects.toBeInstanceOf(SynapseRequestError);
      await expect(call).rejects.toMatchObject({ status });
    }
  });

  test("uses the BYOK key when provided", async () => {
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
        apiKey: "sk-scoped",
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
        apiKey: "sk-scoped",
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
        apiKey: "sk-scoped",
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
        apiKey: "sk-scoped",
      },
      { ...baseOpts, fetchImpl },
    );

    await expect(call).rejects.toThrow(/synapse request failed/i);
  });
});

/**
 * A fetch that refuses whichever model id is in `rejectModel` (as if the gateway
 * does not entitle smart routing for this key) and answers every other model
 * with a canned success, recording the model of each call in order
 */
const modelAwareFetch = (
  rejectModel: string,
  rejectStatus = 404,
): { fetchImpl: typeof fetch; models: string[] } => {
  const models: string[] = [];
  const fetchImpl = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const model = JSON.parse(String(init?.body)).model as string;
    models.push(model);
    if (model === rejectModel)
      return new Response(JSON.stringify({ error: "model not available" }), {
        status: rejectStatus,
        headers: { "content-type": "application/json" },
      });
    return new Response(JSON.stringify(anthropicResponse("ok")), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, models };
};

describe("callSynapse virtual-model routing fallback", () => {
  const ENV_KEYS = ["FACET_AI_MODEL", "FACET_AI_FALLBACK_MODEL"] as const;
  let snapshot: Record<string, string | undefined> = {};

  const setEnv = () => {
    snapshot = {};
    for (const k of ENV_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  };
  const restoreEnv = () => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  };

  const FALLBACK = "anthropic/claude-sonnet-4-5-20250929";

  test("degrades to the concrete fallback when the virtual model is refused", async () => {
    setEnv();
    try {
      process.env.FACET_AI_MODEL = "auto";
      process.env.FACET_AI_FALLBACK_MODEL = FALLBACK;
      const { fetchImpl, models } = modelAwareFetch("auto");

      const result = await callSynapse(
        {
          system: "s",
          messages: [{ role: "user", content: "p" }],
          maxTokens: 10,
          apiKey: "sk-scoped",
        },
        { fetchImpl },
      );

      expect(models).toEqual(["auto", FALLBACK]);
      expect(result.text).toBe("ok");
    } finally {
      restoreEnv();
    }
  });

  test("does not retry when the virtual model succeeds", async () => {
    setEnv();
    try {
      process.env.FACET_AI_MODEL = "auto";
      process.env.FACET_AI_FALLBACK_MODEL = FALLBACK;
      // Reject a model nobody uses, so `auto` succeeds on the first call
      const { fetchImpl, models } = modelAwareFetch("never");

      await callSynapse(
        {
          system: "s",
          messages: [{ role: "user", content: "p" }],
          maxTokens: 10,
          apiKey: "sk-scoped",
        },
        { fetchImpl },
      );

      expect(models).toEqual(["auto"]);
    } finally {
      restoreEnv();
    }
  });

  test("a concrete model failure is surfaced, never retried", async () => {
    setEnv();
    try {
      process.env.FACET_AI_MODEL = FALLBACK; // a concrete routed model
      process.env.FACET_AI_FALLBACK_MODEL =
        "anthropic/claude-haiku-4-5-20251001";
      const { fetchImpl, models } = modelAwareFetch(FALLBACK);

      const call = callSynapse(
        {
          system: "s",
          messages: [{ role: "user", content: "p" }],
          maxTokens: 10,
          apiKey: "sk-scoped",
        },
        { fetchImpl },
      );

      await expect(call).rejects.toThrow(/synapse request failed/i);
      expect(models).toEqual([FALLBACK]);
    } finally {
      restoreEnv();
    }
  });

  test("an out-of-credits refusal (402) is never retried on the backup model", async () => {
    setEnv();
    try {
      process.env.FACET_AI_MODEL = "auto";
      process.env.FACET_AI_FALLBACK_MODEL = FALLBACK;
      const { fetchImpl, models } = modelAwareFetch("auto", 402);

      const call = callSynapse(
        {
          system: "s",
          messages: [{ role: "user", content: "p" }],
          maxTokens: 10,
          apiKey: "sk-scoped",
        },
        { fetchImpl },
      );

      await expect(call).rejects.toMatchObject({ status: 402 });
      expect(models).toEqual(["auto"]);
    } finally {
      restoreEnv();
    }
  });
});
