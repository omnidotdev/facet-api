import { describe, expect, test } from "bun:test";

import { SynapseProvisioner } from "./provisioner";

/** Build a fetch stub recording calls and returning a scripted response. */
const makeFetch = (
  responses: { status: number; body?: unknown }[],
): {
  fetchImpl: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

describe("SynapseProvisioner", () => {
  test("provisions a per-user key with the gateway secret and Facet source", async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: { apiKey: "sk-user-1" } },
    ]);
    const p = new SynapseProvisioner({
      apiUrl: "https://api.synapse.example.com",
      gatewaySecret: "secret-xyz",
      fetchImpl,
    });

    expect(await p.resolveKey("user-1")).toBe("sk-user-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.synapse.example.com/internal/provision-managed-key",
    );
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["x-gateway-secret"]).toBe("secret-xyz");
    expect(JSON.parse(calls[0]!.init?.body as string)).toMatchObject({
      identityProviderId: "user-1",
      source: "Facet",
    });
  });

  test("caches the key so a second resolve does not re-provision", async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: { apiKey: "sk-user-1" } },
    ]);
    const p = new SynapseProvisioner({
      apiUrl: "https://api.synapse.example.com",
      gatewaySecret: "secret-xyz",
      fetchImpl,
      now: () => 1000,
    });

    await p.resolveKey("user-1");
    await p.resolveKey("user-1");
    expect(calls).toHaveLength(1);
  });

  test("re-provisions a different user", async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: { apiKey: "sk-a" } },
      { status: 200, body: { apiKey: "sk-b" } },
    ]);
    const p = new SynapseProvisioner({
      apiUrl: "https://api.synapse.example.com",
      gatewaySecret: "s",
      fetchImpl,
    });
    expect(await p.resolveKey("a")).toBe("sk-a");
    expect(await p.resolveKey("b")).toBe("sk-b");
    expect(calls).toHaveLength(2);
  });

  test("throws on a non-2xx response (caller falls back to the shared key)", async () => {
    const { fetchImpl } = makeFetch([{ status: 403 }]);
    const p = new SynapseProvisioner({
      apiUrl: "https://api.synapse.example.com",
      gatewaySecret: "s",
      fetchImpl,
    });
    await expect(p.resolveKey("user-1")).rejects.toThrow();
  });

  test("throws when the response carries no apiKey", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: { keyHint: "x" } }]);
    const p = new SynapseProvisioner({
      apiUrl: "https://api.synapse.example.com",
      gatewaySecret: "s",
      fetchImpl,
    });
    await expect(p.resolveKey("user-1")).rejects.toThrow();
  });
});
