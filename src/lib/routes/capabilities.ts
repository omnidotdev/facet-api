import { Elysia } from "elysia";

import { getAiConfig } from "lib/config/ai.config";

import type { CreditStore } from "lib/cost/creditStore";

interface CapabilitiesDeps {
  authenticate: (request: Request) => Promise<{ userId: string } | null>;
  /** Per-user monthly credit meter, to report the remaining managed balance. */
  creditStore: CreditStore;
}

/**
 * Reports what the calling user may do, so the client can gate the AI surface
 * without duplicating (or hardcoding) the server's access rules. The managed
 * allowlist lives only in env; this never discloses who is on it, only the
 * caller's own yes/no. Used by the Studio to show the "describe a part" panel
 * only to users who can actually use managed generation, instead of showing it
 * to everyone and relying on a 403 after the fact.
 *
 * For a user who can spend managed credits it also returns the monthly balance
 * (used / cap / remaining), so the UI can show how many generations are left
 * and give the per-generation credit cost meaning rather than a bare number.
 */
export const createCapabilitiesRoute = (deps: CapabilitiesDeps) =>
  new Elysia().get("/capabilities", async ({ request }) => {
    const cfg = getAiConfig();
    const identity = await deps.authenticate(request).catch(() => null);

    // Mirror the managed gate in the generate route: managed is available when
    // the key is configured, the user is signed in, and either no allowlist is
    // set (open) or the user is on it
    const allowlisted =
      cfg.managedAllowlist.length === 0 ||
      (identity !== null && cfg.managedAllowlist.includes(identity.userId));

    const managedGeneration =
      cfg.managedEnabled && identity !== null && allowlisted;

    // The monthly managed credit balance, only for a user who can actually
    // spend it. A meter failure degrades to omitting the balance, never blocks
    // the capability probe
    let credits: { used: number; cap: number; remaining: number } | undefined;
    if (managedGeneration && identity) {
      try {
        const usage = await deps.creditStore.getMonthlyUsage(identity.userId);
        credits = {
          used: usage.usedCredits,
          cap: usage.capCredits,
          remaining: Math.max(0, usage.capCredits - usage.usedCredits),
        };
      } catch {
        // omit the balance on any meter failure; the panel still works without it
      }
    }

    return {
      signedIn: identity !== null,
      managedGeneration,
      ...(credits ? { credits } : {}),
    };
  });
