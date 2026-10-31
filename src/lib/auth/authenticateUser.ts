import { resolveAccessToken } from "@omnidotdev/providers";

import { AUTH_BASE_URL } from "lib/config/env.config";

/**
 * Resolve the signed-in Omni identity for a request.
 *
 * A browser user authenticates to the fleet with a Better Auth / Gatekeeper
 * access token sent as `Authorization: Bearer <token>`. The token is resolved
 * through the shared provider helper, which verifies a JWT locally via the
 * Gatekeeper JWKS (and enriches it from userinfo) or validates an opaque token
 * against the userinfo endpoint. This mirrors the GraphQL authentication plugin
 * in this service and arbor-api's `resolveUserFromToken`, so the managed path
 * uses the fleet's real mechanism rather than a bespoke scheme.
 *
 * Returns null for any missing, malformed, or unverifiable credential so the
 * caller can answer a generic 401 without leaking why
 */
export const authenticateUser = async (
  request: Request,
): Promise<{ userId: string } | null> => {
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

    return { userId: claims.sub };
  } catch (err) {
    console.error(
      `[generate] identity resolution failed: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    );
    return null;
  }
};
