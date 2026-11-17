import { describe, expect, test } from "bun:test";

import { workspaceBillingEntity } from "lib/billing/facetBilling";
import { createFacetProvisioner } from "./provisioner";

const USER = "6f1c2a8e-4b7d-4e2a-9c1f-0a1b2c3d4e5f";
const WORKSPACE = "0b6f3c1e-8f0a-4d7e-9a51-2c4d6e8f0a1b";

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
  test("provisions a product-scoped key for the user billed to their workspace", async () => {
    const { fetchImpl, calls } = captureFetch();
    const provisioner = createFacetProvisioner({
      apiUrl: "https://api.synapse.test/",
      gatewaySecret: "gw-secret",
      fetchImpl,
    });

    const key = await provisioner.resolveKey(
      USER,
      undefined,
      workspaceBillingEntity(WORKSPACE),
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
      billingEntity: { entityType: "organization", entityId: WORKSPACE },
    });
  });

  test("never reuses a key minted for the user entity once billing the workspace", async () => {
    // a key provisioned before the move to workspace billing (user entity) must
    // not serve a workspace-billed call; the cache keys by billing entity
    const { fetchImpl, calls } = captureFetch();
    const provisioner = createFacetProvisioner({
      apiUrl: "https://api.synapse.test",
      gatewaySecret: "gw-secret",
      fetchImpl,
    });

    await provisioner.resolveKey(USER, undefined, {
      entityType: "user",
      entityId: USER,
    });
    await provisioner.resolveKey(
      USER,
      undefined,
      workspaceBillingEntity(WORKSPACE),
    );
    await provisioner.resolveKey(
      USER,
      undefined,
      workspaceBillingEntity(WORKSPACE),
    );

    expect(calls.map((c) => c.body.billingEntity)).toEqual([
      { entityType: "user", entityId: USER },
      { entityType: "organization", entityId: WORKSPACE },
    ]);
  });

  test("a provisioning failure throws with the HTTP status", async () => {
    const { fetchImpl } = captureFetch(503);
    const provisioner = createFacetProvisioner({
      apiUrl: "https://api.synapse.test",
      gatewaySecret: "gw-secret",
      fetchImpl,
    });

    await expect(
      provisioner.resolveKey(
        USER,
        undefined,
        workspaceBillingEntity(WORKSPACE),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});
