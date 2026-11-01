/**
 * Tier-aware monthly credit cap, sourced from Aether entitlements.
 *
 * The managed generation cap is no longer a flat free allowance: it is the
 * user's `included_credits` entitlement for the Facet product, which Aether
 * syncs from the omni-api catalog `operationalLimits` (Free resolves to 100,
 * Facet Pro to 2000). A workspace that upgrades gets the larger cap without a
 * redeploy, and the billing webhook invalidates the cached value on change.
 *
 * The resolver degrades safely and is the only place that reads the
 * entitlement: any billing outage, a missing entitlement, or an unparseable
 * value falls back to the static free cap, so the service never crashes and
 * never hands out an unbounded cap on error. Entitlements are cached inside the
 * billing provider (invalidated by the billing webhook), so this reads through
 * that cache rather than keeping its own, mirroring keystone-api
 */

import type { BillingProvider } from "@omnidotdev/providers";

/** Catalog product id whose entitlements set the Facet managed credit cap */
const PRODUCT_ID = "facet";

/** Entity type for the per-user credit cap (the managed cap is keyed per user) */
const ENTITY_TYPE = "user";

/** Operational-limit feature key, mirrored from omni-api planConfigs */
const INCLUDED_CREDITS_KEY = "included_credits";

/** Resolve the monthly managed credit cap for a user. */
export type CapResolver = (userId: string) => Promise<number>;

interface EntitlementCapResolverDeps {
  /** Billing provider (Aether) that serves entitlements */
  billing: Pick<BillingProvider, "getEntitlements">;
  /** Static fallback cap used when Aether is unreachable or has no entitlement */
  fallbackCredits: number;
}

/**
 * Build a cap resolver that reads a user's `included_credits` entitlement for
 * the Facet product from Aether, falling back to the static free cap on any
 * failure or absence.
 */
export const createEntitlementCapResolver =
  ({ billing, fallbackCredits }: EntitlementCapResolverDeps): CapResolver =>
  async (userId) => {
    try {
      const response = await billing.getEntitlements(
        ENTITY_TYPE,
        userId,
        PRODUCT_ID,
      );
      if (!response) return fallbackCredits;

      const entitlement = response.entitlements.find(
        (e) => e.featureKey === INCLUDED_CREDITS_KEY,
      );

      const parsed = Number.parseInt(entitlement?.value ?? "", 10);

      // a non-negative integer is a real cap; anything else degrades to free
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallbackCredits;
    } catch {
      // degrade to the static free cap, never crash or grant an unbounded cap
      return fallbackCredits;
    }
  };

/**
 * Cap resolver that always returns the static cap, used when billing is not
 * configured so the service still boots and enforces the free cap.
 */
export const createStaticCapResolver =
  (capCredits: number): CapResolver =>
  async () =>
    capCredits;
