import { Elysia } from "elysia";

import { getAiConfig } from "lib/config/ai.config";

interface CapabilitiesDeps {
  authenticate: (request: Request) => Promise<{ userId: string } | null>;
}

/**
 * Reports what the calling user may do, so the client can gate the AI surface
 * without duplicating (or hardcoding) the server's access rules. The managed
 * allowlist lives only in env; this never discloses who is on it, only the
 * caller's own yes/no. Used by the Studio to show the "describe a part" panel
 * only to users who can actually use managed generation, instead of showing it
 * to everyone and relying on a 403 after the fact.
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

    return {
      signedIn: identity !== null,
      managedGeneration: cfg.managedEnabled && identity !== null && allowlisted,
    };
  });
