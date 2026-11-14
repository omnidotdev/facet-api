import { creditsFromBalanceUsd } from "@omnidotdev/providers";
import { Elysia } from "elysia";

import { getAiConfig } from "lib/config/ai.config";

import type { BillingProvider } from "@omnidotdev/providers";
import type { TierResolver } from "lib/billing/facetBilling";

interface CapabilitiesDeps {
  authenticate: (request: Request) => Promise<{ userId: string } | null>;
  /** Aether, for the user's pooled credit balance */
  billing: Pick<BillingProvider, "getCreditBalance">;
  /** Resolve the user's Facet tier from Aether (free on any failure) */
  resolveTier: TierResolver;
}

/**
 * Reports what the calling user may do, so the client can gate the AI surface
 * without duplicating (or hardcoding) the server's access rules. The managed
 * allowlist lives only in env; this never discloses who is on it, only the
 * caller's own yes/no. Used by the Studio to show the "describe a part" panel
 * only to users who can actually use managed generation, instead of showing it
 * to everyone and relying on a 403 after the fact.
 *
 * For a user who can use managed generation it also returns their tier and
 * their real credit balance: ONE pooled Aether balance per billing account,
 * shared across every Omni product, converted from retail USD to whole display
 * credits with the shared helper (rounded down, never overstated). Facet keeps
 * no ledger of its own; the gateway debits this balance
 */
export const createCapabilitiesRoute = (deps: CapabilitiesDeps) =>
  new Elysia().get("/capabilities", async ({ request }) => {
    const cfg = getAiConfig();
    const identity = await deps.authenticate(request).catch(() => null);

    // Mirror the managed gate in the generate route: managed is available when
    // provisioning is configured, the user is signed in, and either no
    // allowlist is set (open) or the user is on it
    const allowlisted =
      cfg.managedAllowlist.length === 0 ||
      (identity !== null && cfg.managedAllowlist.includes(identity.userId));

    const managedGeneration =
      cfg.managedEnabled && identity !== null && allowlisted;

    if (!managedGeneration || !identity) {
      return { signedIn: identity !== null, managedGeneration };
    }

    // A balance or tier lookup failure degrades to omitting it, never blocks
    // the capability probe
    const [tier, balance] = await Promise.all([
      deps.resolveTier(identity.userId),
      deps.billing
        .getCreditBalance("user", identity.userId)
        .then((result) =>
          result ? creditsFromBalanceUsd(result.balance) : null,
        )
        .catch(() => null),
    ]);

    return {
      signedIn: true,
      managedGeneration,
      tier,
      ...(balance !== null ? { credits: { balance } } : {}),
    };
  });
