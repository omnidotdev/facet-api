import { afterEach, describe, expect, test } from "bun:test";

import { createPlatformConsentClient } from "./consentClient";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace fetch with a stub that records the request and returns `response`. */
const stubFetch = (response: Response) => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as typeof fetch;
  return calls;
};

const okResponse = () =>
  new Response(JSON.stringify({ data: { setConsent: { granted: true } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("createPlatformConsentClient", () => {
  test("is a no-op with no endpoint (never calls fetch)", async () => {
    const calls = stubFetch(okResponse());
    const client = createPlatformConsentClient(undefined);

    await client.setConsent("tok", true);

    expect(calls).toHaveLength(0);
  });

  test("posts the setConsent mutation with the bearer token and ai_training input", async () => {
    const calls = stubFetch(okResponse());
    const client = createPlatformConsentClient("https://api.test/graphql");

    await client.setConsent("tok-123", true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.test/graphql");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.variables.input).toEqual({
      purposeKey: "ai_training",
      granted: true,
      source: "facet",
    });
  });

  test("throws on a non-ok response", async () => {
    stubFetch(new Response("nope", { status: 502 }));
    const client = createPlatformConsentClient("https://api.test/graphql");

    await expect(client.setConsent("tok", false)).rejects.toThrow("502");
  });

  test("throws when the GraphQL response carries errors", async () => {
    stubFetch(
      new Response(
        JSON.stringify({ errors: [{ message: "Unauthenticated" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = createPlatformConsentClient("https://api.test/graphql");

    await expect(client.setConsent("tok", true)).rejects.toThrow(
      "Unauthenticated",
    );
  });
});
