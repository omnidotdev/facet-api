import { describe, expect, test } from "bun:test";

import {
  FACET_APP_ID,
  createTierResolver,
  isPaidTier,
  userBillingEntity,
} from "./facetBilling";

const USER = "6f1c2a8e-4b7d-4e2a-9c1f-0a1b2c3d4e5f";

describe("facet billing scope", () => {
  test("Facet bills under its own Aether app id", () => {
    expect(FACET_APP_ID).toBe("facet");
  });

  test("a personal product bills the user themselves", () => {
    expect(userBillingEntity(USER)).toEqual({
      entityType: "user",
      entityId: USER,
    });
  });
});

describe("createTierResolver", () => {
  test("reads the user's tier entitlement for the facet app", async () => {
    const seen: unknown[] = [];
    const resolve = createTierResolver({
      async checkEntitlement(...args) {
        seen.push(args);
        return "pro";
      },
    });

    expect(await resolve(USER)).toBe("pro");
    expect(seen).toEqual([["user", USER, "facet", "tier"]]);
  });

  test("normalizes the tier value", async () => {
    const resolve = createTierResolver({
      checkEntitlement: async () => "  Pro ",
    });
    expect(await resolve(USER)).toBe("pro");
  });

  test("no entitlement resolves to free", async () => {
    const resolve = createTierResolver({ checkEntitlement: async () => null });
    expect(await resolve(USER)).toBe("free");
  });

  test("an Aether failure degrades to free, never paid", async () => {
    const resolve = createTierResolver({
      checkEntitlement: async () => {
        throw new Error("aether down");
      },
    });
    expect(await resolve(USER)).toBe("free");
  });
});

describe("isPaidTier", () => {
  test("only a non-free tier is paid", () => {
    expect(isPaidTier("free")).toBe(false);
    expect(isPaidTier("pro")).toBe(true);
  });
});
