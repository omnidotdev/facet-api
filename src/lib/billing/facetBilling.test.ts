import { describe, expect, test } from "bun:test";

import {
  FACET_APP_ID,
  createTierResolver,
  getWorkspaceCreditBalance,
  isPaidTier,
  workspaceBillingEntity,
} from "./facetBilling";

const WORKSPACE = "6f1c2a8e-4b7d-4e2a-9c1f-0a1b2c3d4e5f";

describe("facet billing scope", () => {
  test("Facet bills under its own Aether app id", () => {
    expect(FACET_APP_ID).toBe("facet");
  });

  test("bills the workspace (organization), never the user entity", () => {
    expect(workspaceBillingEntity(WORKSPACE)).toEqual({
      entityType: "organization",
      entityId: WORKSPACE,
    });
  });
});

describe("getWorkspaceCreditBalance", () => {
  test("reads the workspace's pooled balance on the organization entity", async () => {
    const seen: unknown[] = [];
    const balance = await getWorkspaceCreditBalance(
      {
        async getCreditBalance(...args) {
          seen.push(args);
          return { billingAccountId: "acct-1", balance: 4.2 };
        },
      },
      WORKSPACE,
    );
    expect(balance).toBe(4.2);
    expect(seen).toEqual([["organization", WORKSPACE]]);
  });

  test("an unknown balance is null", async () => {
    expect(
      await getWorkspaceCreditBalance(
        { getCreditBalance: async () => null },
        WORKSPACE,
      ),
    ).toBeNull();
  });
});

describe("createTierResolver", () => {
  test("reads the workspace's tier entitlement for the facet app", async () => {
    const seen: unknown[] = [];
    const resolve = createTierResolver({
      async checkEntitlement(...args) {
        seen.push(args);
        return "pro";
      },
    });

    expect(await resolve(WORKSPACE)).toBe("pro");
    expect(seen).toEqual([["organization", WORKSPACE, "facet", "tier"]]);
  });

  test("normalizes the tier value", async () => {
    const resolve = createTierResolver({
      checkEntitlement: async () => "  Pro ",
    });
    expect(await resolve(WORKSPACE)).toBe("pro");
  });

  test("no entitlement resolves to free", async () => {
    const resolve = createTierResolver({ checkEntitlement: async () => null });
    expect(await resolve(WORKSPACE)).toBe("free");
  });

  test("an Aether failure degrades to free, never paid", async () => {
    const resolve = createTierResolver({
      checkEntitlement: async () => {
        throw new Error("aether down");
      },
    });
    expect(await resolve(WORKSPACE)).toBe("free");
  });
});

describe("isPaidTier", () => {
  test("only a non-free tier is paid", () => {
    expect(isPaidTier("free")).toBe(false);
    expect(isPaidTier("pro")).toBe(true);
  });
});
