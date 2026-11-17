import { extractOrgClaims, resolveAccessToken } from "@omnidotdev/providers";

import { AUTH_BASE_URL } from "lib/config/env.config";

import type { UserInfoClaims } from "@omnidotdev/providers";

/**
 * The signed-in user's personal workspace: the Omni organization Gatekeeper
 * auto-creates for every user (`type: "personal"`), 1:1 with the user and
 * never deletable. Facet bills managed AI to it, the same billing account the
 * account hub's plan checkout puts a paid plan and its included credits on
 */
export interface PersonalWorkspace {
  /** Organization id (the Aether billing entity id) */
  id: string;
  /** Organization slug (for account-hub links) */
  slug: string;
}

/** A resolved Omni identity */
export interface AuthenticatedUser {
  /** Gatekeeper user id: identity concerns (whitelist, consent, telemetry) */
  userId: string;
  /**
   * The user's personal workspace, the billing scope for managed AI. Null when
   * the userinfo response carries no personal organization (e.g. a token issued
   * without the `organization` scope), in which case managed AI fails closed
   */
  personalWorkspace: PersonalWorkspace | null;
}

/** Resolve the signed-in Omni identity for a request, or null when absent/invalid */
export type Authenticate = (
  request: Request,
) => Promise<AuthenticatedUser | null>;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Pick the personal workspace out of Gatekeeper's userinfo claims. Userinfo
 * always carries the rich organizations claim (id, slug, type), read through the
 * shared fleet helper. Entries are validated defensively, so a malformed claim
 * resolves to null (fail closed) rather than a partial workspace
 */
export const resolvePersonalWorkspace = (
  claims: UserInfoClaims,
): PersonalWorkspace | null => {
  // the claim is untrusted wire data, so guard the array shape too
  const claimed: unknown = extractOrgClaims(claims);
  if (!Array.isArray(claimed)) return null;

  for (const org of claimed) {
    if (typeof org !== "object" || org === null) continue;
    const { id, slug, type } = org as Record<string, unknown>;
    if (type === "personal" && nonEmptyString(id) && nonEmptyString(slug)) {
      return { id, slug };
    }
  }

  return null;
};

/**
 * Resolve the signed-in Omni identity for a request.
 *
 * A browser user authenticates to the fleet with a Better Auth / Gatekeeper
 * access token sent as `Authorization: Bearer <token>`. The token is resolved
 * through the shared provider helper, which verifies a JWT locally via the
 * Gatekeeper JWKS (and enriches it from userinfo) or validates an opaque token
 * against the userinfo endpoint. This mirrors the GraphQL authentication plugin
 * in this service and arbor-api's `resolveUserFromToken`, so the managed path
 * uses the fleet's real mechanism rather than a bespoke scheme. The userinfo
 * response also names the user's personal workspace (see
 * `resolvePersonalWorkspace`).
 *
 * Returns null for any missing, malformed, or unverifiable credential so the
 * caller can answer a generic 401 without leaking why
 */
export const authenticateUser: Authenticate = async (request) => {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, ...rest] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer") return null;

  const token = rest.join(" ").trim();
  if (!token) return null;

  if (!AUTH_BASE_URL) return null;

  try {
    const claims = await resolveAccessToken(token, {
      authBaseUrl: AUTH_BASE_URL,
      userinfoUrl: `${AUTH_BASE_URL}/oauth2/userinfo`,
    });

    if (!claims?.sub) return null;

    return {
      userId: claims.sub,
      personalWorkspace: resolvePersonalWorkspace(claims),
    };
  } catch (err) {
    console.error(
      `[generate] identity resolution failed: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    );
    return null;
  }
};
