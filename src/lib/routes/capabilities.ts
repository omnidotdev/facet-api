import { creditsFromBalanceUsd } from "@omnidotdev/providers";
import { Elysia } from "elysia";

import {
  getWorkspaceCreditBalance,
  resolveManagedEligibility,
} from "lib/billing/facetBilling";
import { getAiConfig } from "lib/config/ai.config";

import type { BillingProvider } from "@omnidotdev/providers";
import type { Authenticate } from "lib/auth/authenticateUser";
import type {
  CardOfferResolver,
  FundingResolver,
  TierResolver,
} from "lib/billing/facetBilling";
import type { SampleStore } from "lib/routes/sampleStore";

interface CapabilitiesDeps {
  authenticate: Authenticate;
  /** Aether, for the personal workspace's pooled credit balance */
  billing: Pick<BillingProvider, "getCreditBalance">;
  /** Resolve the workspace's Facet tier from Aether (free on any failure) */
  resolveTier: TierResolver;
  /**
   * Resolve whether the workspace has bought Omni credits (not funded on any
   * failure). Read only for a free tier
   */
  resolveFunding: FundingResolver;
  /**
   * Whether Aether offers card-verified free AI credits, so a refused user is
   * offered "Add a card" only while the offer is live. Optional: absent or
   * failing means no offer
   */
  resolveCardOffer?: CardOfferResolver;
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
 * plan and credits in the account hub.
 *
 * Managed AI is for paying customers (a paid tier, or a workspace that
 * bought credits) and the card-verified free allowance (`freeAllowance: true`,
 * served the free model), mirroring the gate in `managedAccess.ts`. A
 * signed-in, whitelisted user whose workspace has neither gets `managedGeneration:
 * false` with `paymentRequired: true`, plus the tier, workspace slug, and
 * balance when known, so the app can offer buy credits, upgrade, or BYOK
 */
export const createCapabilitiesRoute = (deps: CapabilitiesDeps) =>
  new Elysia().get("/capabilities", async ({ request }) => {
    const cfg = getAiConfig();
    const identity = await deps.authenticate(request).catch(() => null);

    // Mirror the managed gate in the generate route: managed is available when
    // provisioning is configured, the user is signed in, either no whitelist
    // is set (open) or the user is on it, they have a personal workspace to
    // bill, and that workspace is a paying customer (checked below). A token
    // without a workspace must re-authenticate (the managed path answers 401),
    // so the client is told to sign in again
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

    // A balance or consent lookup failure degrades to omitting it (or a false
    // default), never blocks the capability probe. Eligibility fails closed (a
    // funding failure reads as not paying). Tier, funding, and balance are the
    // workspace's (billing); consent is the user's own (identity)
    const [
      { tier, isPayingCustomer, freeAllowance },
      balance,
      aiTrainingConsent,
    ] = await Promise.all([
      resolveManagedEligibility(deps, workspace.id),
      getWorkspaceCreditBalance(deps.billing, workspace.id)
        .then((usd) => (usd !== null ? creditsFromBalanceUsd(usd) : null))
        .catch(() => null),
      deps.store?.getConsent(identity.userId).catch(() => false) ?? false,
    ]);
    const credits = balance !== null ? { credits: { balance } } : {};

    if (!isPayingCustomer && !freeAllowance) {
      const cardOffer = deps.resolveCardOffer
        ? await deps.resolveCardOffer().catch(() => null)
        : null;
      return {
        signedIn: true,
        managedGeneration: false,
        paymentRequired: true,
        tier,
        workspace: { slug: workspace.slug },
        ...credits,
        ...(cardOffer ? { cardOffer } : {}),
      };
    }

    return {
      signedIn: true,
      managedGeneration,
      tier,
      ...(freeAllowance ? { freeAllowance: true } : {}),
      aiTrainingConsent,
      workspace: { slug: workspace.slug },
      ...credits,
    };
  });
