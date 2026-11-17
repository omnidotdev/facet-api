import { creditsFromBalanceUsd } from "@omnidotdev/providers";
import { Elysia } from "elysia";

import { getWorkspaceCreditBalance } from "lib/billing/facetBilling";
import { getAiConfig } from "lib/config/ai.config";

import type { BillingProvider } from "@omnidotdev/providers";
import type { Authenticate } from "lib/auth/authenticateUser";
import type { TierResolver } from "lib/billing/facetBilling";
import type { SampleStore } from "lib/routes/sampleStore";

interface CapabilitiesDeps {
  authenticate: Authenticate;
  /** Aether, for the personal workspace's pooled credit balance */
  billing: Pick<BillingProvider, "getCreditBalance">;
  /** Resolve the workspace's Facet tier from Aether (free on any failure) */
  resolveTier: TierResolver;
  /**
   * Read the user's AI-training-data consent, so the client can reflect the
   * current state of the opt-in toggle. Optional and never gating: an absent
   * store or a read failure degrades to a false (off) default
   */
  store?: Pick<SampleStore, "getConsent">;
}

/**
 * Reports what the calling user may do, so the client can gate the AI surface
 * without duplicating (or hardcoding) the server's access rules. The managed
 * allowlist lives only in env; this never discloses who is on it, only the
 * caller's own yes/no. Used by the Studio to show the "describe a part" panel
 * only to users who can actually use managed generation, instead of showing it
 * to everyone and relying on a 403 after the fact.
 *
 * For a user who can use managed generation it also returns the tier and real
 * credit balance of their PERSONAL WORKSPACE (the billing account the account
 * hub puts a paid plan on): ONE pooled Aether balance per billing account,
 * shared across every Omni product, converted from retail USD to whole display
 * credits with the shared helper (rounded down, never overstated). Facet keeps
 * no ledger of its own; the gateway debits this balance. It also returns the
 * workspace slug (`workspace.slug`) so the client can link to that workspace's
 * plan and credits in the account hub
 */
export const createCapabilitiesRoute = (deps: CapabilitiesDeps) =>
  new Elysia().get("/capabilities", async ({ request }) => {
    const cfg = getAiConfig();
    const identity = await deps.authenticate(request).catch(() => null);

    // Mirror the managed gate in the generate route: managed is available when
    // provisioning is configured, the user is signed in, either no whitelist
    // is set (open) or the user is on it, and they have a personal workspace
    // to bill. A token without one must re-authenticate (the managed path
    // answers 401), so the client is told to sign in again
    const whitelisted =
      cfg.managedAllowlist.length === 0 ||
      (identity !== null && cfg.managedAllowlist.includes(identity.userId));

    const workspace = identity?.personalWorkspace ?? null;

    const managedGeneration =
      cfg.managedEnabled &&
      identity !== null &&
      whitelisted &&
      workspace !== null;

    if (
      cfg.managedEnabled &&
      identity !== null &&
      whitelisted &&
      workspace === null
    ) {
      return { signedIn: true, managedGeneration: false, reauthRequired: true };
    }

    if (!managedGeneration || !identity || !workspace) {
      return { signedIn: identity !== null, managedGeneration };
    }

    // A balance, tier, or consent lookup failure degrades to omitting it (or a
    // false default), never blocks the capability probe. Tier and balance are
    // the workspace's (billing); consent is the user's own (identity)
    const [tier, balance, aiTrainingConsent] = await Promise.all([
      deps.resolveTier(workspace.id),
      getWorkspaceCreditBalance(deps.billing, workspace.id)
        .then((usd) => (usd !== null ? creditsFromBalanceUsd(usd) : null))
        .catch(() => null),
      deps.store?.getConsent(identity.userId).catch(() => false) ?? false,
    ]);

    return {
      signedIn: true,
      managedGeneration,
      tier,
      aiTrainingConsent,
      workspace: { slug: workspace.slug },
      ...(balance !== null ? { credits: { balance } } : {}),
    };
  });
