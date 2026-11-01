import { describe, expect, test } from "bun:test";

import { createDrizzleCreditStore } from "lib/cost/creditStore.drizzle";
import {
  createEntitlementCapResolver,
  createStaticCapResolver,
} from "lib/cost/entitlementCap";

import type {
  BillingProvider,
  EntitlementsResponse,
} from "@omnidotdev/providers";
import type { dbPool } from "lib/db";

type GetEntitlements = BillingProvider["getEntitlements"];

/**
 * Build an entitlements response carrying a single included_credits value, so a
 * tier is simulated without a live Aether. A null value models an entitlement
 * present but unset
 */
const entitlementsWith = (
  includedCredits: string | null,
): EntitlementsResponse => ({
  billingAccountId: "acct-1",
  entityType: "user",
  entityId: "user-1",
  entitlementVersion: 1,
  entitlements: [
    {
      id: "ent-1",
      productId: "facet",
      featureKey: "included_credits",
      value: includedCredits,
      source: "catalog",
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: null,
    },
  ],
});

/** Fake billing provider exposing only getEntitlements, as the resolver needs. */
const fakeBilling = (
  getEntitlements: GetEntitlements,
): Pick<BillingProvider, "getEntitlements"> => ({ getEntitlements });

/**
 * Fake Drizzle db whose monthly-usage query resolves to `used` credits, so the
 * credit store is exercised with no database
 */
const fakeDb = (used: number) =>
  ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ used: String(used) }]),
      }),
    }),
    insert: () => ({ values: () => Promise.resolve() }),
  }) as unknown as Pick<typeof dbPool, "select" | "insert">;

describe("createEntitlementCapResolver", () => {
  test("free entitlement resolves the cap to 100", async () => {
    const resolve = createEntitlementCapResolver({
      billing: fakeBilling(async () => entitlementsWith("100")),
      fallbackCredits: 100,
    });

    expect(await resolve("user-1")).toBe(100);
  });

  test("pro entitlement (included_credits 2000) resolves the cap to 2000", async () => {
    const resolve = createEntitlementCapResolver({
      billing: fakeBilling(async () => entitlementsWith("2000")),
      fallbackCredits: 100,
    });

    expect(await resolve("user-1")).toBe(2000);
  });

  test("passes the Facet product id and user entity to Aether", async () => {
    const calls: {
      entityType: string;
      entityId: string;
      productId?: string;
    }[] = [];
    const resolve = createEntitlementCapResolver({
      billing: fakeBilling(async (entityType, entityId, productId) => {
        calls.push({ entityType, entityId, productId });
        return entitlementsWith("2000");
      }),
      fallbackCredits: 100,
    });

    await resolve("user-42");

    expect(calls).toEqual([
      { entityType: "user", entityId: "user-42", productId: "facet" },
    ]);
  });

  test("falls back to the free cap when Aether returns no entitlements", async () => {
    const resolve = createEntitlementCapResolver({
      billing: fakeBilling(async () => null),
      fallbackCredits: 100,
    });

    expect(await resolve("user-1")).toBe(100);
  });

  test("falls back to the free cap when Aether is unreachable", async () => {
    const resolve = createEntitlementCapResolver({
      billing: fakeBilling(async () => {
        throw new Error("ECONNREFUSED");
      }),
      fallbackCredits: 100,
    });

    expect(await resolve("user-1")).toBe(100);
  });

  test("falls back to the free cap when included_credits is missing", async () => {
    const resolve = createEntitlementCapResolver({
      billing: fakeBilling(async () => ({
        billingAccountId: "acct-1",
        entityType: "user",
        entityId: "user-1",
        entitlementVersion: 1,
        entitlements: [],
      })),
      fallbackCredits: 100,
    });

    expect(await resolve("user-1")).toBe(100);
  });

  test("falls back to the free cap when the entitlement value is unparseable", async () => {
    const resolve = createEntitlementCapResolver({
      billing: fakeBilling(async () => entitlementsWith("not-a-number")),
      fallbackCredits: 100,
    });

    expect(await resolve("user-1")).toBe(100);
  });
});

describe("createStaticCapResolver", () => {
  test("always returns the static cap", async () => {
    const resolve = createStaticCapResolver(100);

    expect(await resolve("user-1")).toBe(100);
    expect(await resolve("user-2")).toBe(100);
  });
});

describe("createDrizzleCreditStore with a tier-aware resolver", () => {
  test("reports the pro cap for an entitled user", async () => {
    const store = createDrizzleCreditStore(
      fakeDb(500),
      createEntitlementCapResolver({
        billing: fakeBilling(async () => entitlementsWith("2000")),
        fallbackCredits: 100,
      }),
    );

    const usage = await store.getMonthlyUsage("user-1");

    expect(usage).toEqual({ usedCredits: 500, capCredits: 2000 });
  });

  test("reports the free fallback cap when Aether is unreachable", async () => {
    const store = createDrizzleCreditStore(
      fakeDb(10),
      createEntitlementCapResolver({
        billing: fakeBilling(async () => {
          throw new Error("ECONNREFUSED");
        }),
        fallbackCredits: 100,
      }),
    );

    const usage = await store.getMonthlyUsage("user-1");

    expect(usage).toEqual({ usedCredits: 10, capCredits: 100 });
  });

  test("a free user at the fallback cap reads as over cap", async () => {
    const store = createDrizzleCreditStore(
      fakeDb(100),
      createEntitlementCapResolver({
        billing: fakeBilling(async () => entitlementsWith("100")),
        fallbackCredits: 100,
      }),
    );

    const usage = await store.getMonthlyUsage("user-1");

    expect(usage.usedCredits).toBeGreaterThanOrEqual(usage.capCredits);
  });
});
