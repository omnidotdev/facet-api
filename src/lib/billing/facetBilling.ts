/**
 * Facet's billing scope.
 *
 * Managed AI is billed by the Synapse gateway, never here: a managed call uses a
 * product-scoped Synapse key, and the gateway checks the entitlement, refuses
 * with 402 before any spend when the balance is empty, meters the call, and
 * debits the pooled Aether credit balance. Facet only names WHO pays (the
 * Aether app and the billing entity) and reads the tier to decide whether the
 * free-tier daily spend breaker applies.
 *
 * Facet is a personal product (a user's own parts, no workspace-owned
 * resources), so the billing entity is the signed-in user themselves
 */

import type { BillingProvider } from "@omnidotdev/providers";
import type { SynapseBillingEntity } from "@omnidotdev/providers/ai";

/** Facet's Aether app id (the catalog product slug) */
export const FACET_APP_ID = "facet";

/** Entitlement feature key carrying the subscribed tier */
const TIER_FEATURE_KEY = "tier";

/** Tier every user has without a subscription */
const FREE_TIER = "free";

/** The billing entity for a user: Facet bills the user personally */
export const userBillingEntity = (userId: string): SynapseBillingEntity => ({
  entityType: "user",
  entityId: userId,
});

/** Resolve a user's Facet tier (e.g. "free", "pro") */
export type TierResolver = (userId: string) => Promise<string>;

/**
 * Build a tier resolver over the Aether `tier` entitlement for the facet app.
 * Any absence or Aether failure resolves to free, so an outage can only place a
 * user under the free-tier breaker, never exempt them from it. Entitlements are
 * cached in the billing provider and invalidated by the billing webhook
 */
export const createTierResolver =
  (billing: Pick<BillingProvider, "checkEntitlement">): TierResolver =>
  async (userId) => {
    try {
      const value = await billing.checkEntitlement(
        "user",
        userId,
        FACET_APP_ID,
        TIER_FEATURE_KEY,
      );
      const tier = value?.trim().toLowerCase();
      return tier ? tier : FREE_TIER;
    } catch {
      return FREE_TIER;
    }
  };

/** Whether a tier is a paid subscription (exempt from the free-tier breaker) */
export const isPaidTier = (tier: string): boolean => tier !== FREE_TIER;
