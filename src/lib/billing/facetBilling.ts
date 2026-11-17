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
 * Facet bills the signed-in user's PERSONAL WORKSPACE (the Omni organization
 * Gatekeeper auto-creates for every user), never the user entity. The whole
 * fleet bills paid plans on a workspace: the account hub's plan checkout puts
 * the subscription, its `tier` entitlement, and its included credits on the
 * organization's billing account. Billing the user entity would split a Pro
 * subscriber into a free user with a separate balance inside Facet
 */

import type { BillingProvider } from "@omnidotdev/providers";
import type { SynapseBillingEntity } from "@omnidotdev/providers/ai";

/** Facet's Aether app id (the catalog product slug) */
export const FACET_APP_ID = "facet";

/** Entitlement feature key carrying the subscribed tier */
const TIER_FEATURE_KEY = "tier";

/** Tier every user has without a subscription */
const FREE_TIER = "free";

/** Aether entity type Facet bills: a workspace (Omni organization) */
const BILLING_ENTITY_TYPE = "organization";

/**
 * The billing entity for a workspace: Facet bills the user's personal
 * workspace, so a plan bought in the account hub applies here
 */
export const workspaceBillingEntity = (
  workspaceId: string,
): SynapseBillingEntity => ({
  entityType: BILLING_ENTITY_TYPE,
  entityId: workspaceId,
});

/** Resolve a workspace's Facet tier (e.g. "free", "pro") */
export type TierResolver = (workspaceId: string) => Promise<string>;

/** Read a workspace's pooled credit balance (retail USD), null when unknown */
export const getWorkspaceCreditBalance = async (
  billing: Pick<BillingProvider, "getCreditBalance">,
  workspaceId: string,
): Promise<number | null> => {
  const result = await billing.getCreditBalance(
    BILLING_ENTITY_TYPE,
    workspaceId,
  );
  return result ? result.balance : null;
};

/**
 * Build a tier resolver over the Aether `tier` entitlement for the facet app.
 * The entitlement is read on the workspace billing entity. Any absence or
 * Aether failure resolves to free, so an outage can only place a user under the
 * free-tier breaker, never exempt them from it. Entitlements are
 * cached in the billing provider and invalidated by the billing webhook
 */
export const createTierResolver =
  (billing: Pick<BillingProvider, "checkEntitlement">): TierResolver =>
  async (workspaceId) => {
    try {
      const value = await billing.checkEntitlement(
        BILLING_ENTITY_TYPE,
        workspaceId,
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
