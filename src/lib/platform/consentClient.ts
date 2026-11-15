/**
 * Client for the Omni platform GraphQL API (omni-api) consent mutation.
 *
 * omni-api owns the fleet-wide, per-purpose consent ledger: a current-state
 * `consent_record` plus an append-only `consent_event` audit log (GDPR Art. 7).
 * Facet forwards each AI-training opt-in change the user makes in Studio here,
 * so the decision is recorded centrally and reflected across the fleet (e.g. the
 * account hub's preference center), while Facet keeps its own user row as the
 * local capture-gate projection.
 *
 * The call is made server-side (no CORS) and carries the signed-in user's own
 * Gatekeeper access token, which omni-api resolves (via the userinfo endpoint)
 * to the same subject Facet keys consent on. Forwarding is best-effort at the
 * call site: the user's choice is already persisted locally and is never blocked
 * on the central write succeeding.
 */

/** The platform consent purpose Facet's AI-training toggle maps to. */
export const AI_TRAINING_PURPOSE_KEY = "ai_training";

/** The source recorded on the central audit event for a Facet-origin change. */
const CONSENT_SOURCE = "facet";

const SET_CONSENT_MUTATION = `
  mutation FacetSetConsent($input: SetConsentInput!) {
    setConsent(input: $input) {
      purposeKey
      granted
    }
  }
`;

interface PlatformConsentClient {
  /**
   * Forward one AI-training consent change to the central ledger for the user
   * the access token identifies. Resolves on success; throws on any non-success
   * so the caller can log it (the local decision still stands)
   */
  setConsent: (accessToken: string, granted: boolean) => Promise<void>;
}

/**
 * Build a platform consent client for the given omni-api GraphQL endpoint. With
 * no endpoint (local/dev, where there is no central ledger) every call is a
 * no-op, so the caller never has to branch on configuration
 */
export const createPlatformConsentClient = (
  endpoint: string | undefined,
): PlatformConsentClient => ({
  async setConsent(accessToken, granted) {
    if (!endpoint) return;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: SET_CONSENT_MUTATION,
        variables: {
          input: {
            purposeKey: AI_TRAINING_PURPOSE_KEY,
            granted,
            source: CONSENT_SOURCE,
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`platform consent API error: ${response.status}`);
    }

    const json = (await response.json()) as {
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) {
      throw new Error(
        json.errors[0]?.message ?? "platform consent request failed",
      );
    }
  },
});
