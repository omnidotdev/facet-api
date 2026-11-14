import { describe, expect, test } from "bun:test";

import { userBillingEntity } from "lib/billing/facetBilling";
import { createFacetProvisioner } from "./provisioner";

const USER = "6f1c2a8e-4b7d-4e2a-9c1f-0a1b2c3d4e5f";

/** Capture each provisioning request and answer with a fixed managed key */
const captureFetch = (status = 200) => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ apiKey: "sk-scoped" }), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

describe("createFacetProvisioner", () => {
  test("provisions a product-scoped key billed to the user", async () => {
    const { fetchImpl, calls } = captureFetch();
    const provisioner = createFacetProvisioner({
      apiUrl: "https://api.synapse.test/",
      gatewaySecret: "gw-secret",
      fetchImpl,
    });

    const key = await provisioner.resolveKey(
      USER,
      undefined,
      userBillingEntity(USER),
    );

    expect(key).toBe("sk-scoped");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.synapse.test/internal/provision-managed-key",
    );
    expect(calls[0]!.body).toEqual({
      identityProviderId: USER,
      source: "Facet",
      appId: "facet",
      billingEntity: { entityType: "user", entityId: USER },
    });
  });

  test("a provisioning failure throws with the HTTP status", async () => {
    const { fetchImpl } = captureFetch(503);
    const provisioner = createFacetProvisioner({
      apiUrl: "https://api.synapse.test",
      gatewaySecret: "gw-secret",
      fetchImpl,
    });

    await expect(
      provisioner.resolveKey(USER, undefined, userBillingEntity(USER)),
    ).rejects.toMatchObject({ status: 503 });
  });
});
