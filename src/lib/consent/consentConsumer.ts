import { AI_TRAINING_PURPOSE_KEY } from "lib/platform/consentClient";

import type { SampleStore } from "lib/routes/sampleStore";

/**
 * Consumer for the platform.consent.changed event.
 *
 * omni-api owns the fleet-wide consent ledger; when a user grants or withdraws a
 * purpose on any surface (the account hub, Facet Studio, ...) it emits
 * platform.consent.changed. Facet receives it (signature-verified) at
 * /webhooks/consent and applies the AI-training purpose here: the user's local
 * row is set to match, and because `setConsent(false)` erases their stored
 * samples, a withdrawal made anywhere (not just in Facet) deletes what Facet
 * retained. The local row stays the capture-gate; this keeps it in step with the
 * authoritative ledger.
 *
 * Pure and dependency-injected so it is unit testable independent of the HTTP
 * route. Fail-closed and idempotent: other purposes, malformed payloads, and
 * re-deliveries are handled without surprise (re-applying the same change simply
 * re-writes the same values). A store failure is thrown so the caller can ask
 * Vortex to retry
 */

/** The `data` payload of a platform.consent.changed CloudEvent. */
interface ConsentChangePayload {
  /** The identity-provider subject the decision is about (Facet's user key). */
  subject?: string;
  /** Which consent purpose changed; only ai_training concerns Facet. */
  purposeKey?: string;
  /** The new state: false is the withdrawal that triggers erasure. */
  granted?: boolean;
  /** The ledger's consent-terms version in effect for this decision. */
  policyVersion?: string;
}

/** Outcome of processing one consent-change event. */
export type ConsentChangeResult =
  | { outcome: "applied"; granted: boolean }
  | { outcome: "ignored"; reason: string };

interface ApplyConsentChangeArgs {
  store: Pick<SampleStore, "setConsent">;
  payload: ConsentChangePayload;
}

/**
 * Apply a verified consent change to the local projection.
 *
 * The caller (the webhook route) verifies the HMAC signature before this runs;
 * this trusts the input is authentic but still validates its shape and ignores
 * anything it is not responsible for.
 */
export const applyConsentChange = async ({
  store,
  payload,
}: ApplyConsentChangeArgs): Promise<ConsentChangeResult> => {
  // only the AI-training purpose maps to Facet-held data; ignore the rest of the
  // fleet's purposes that share this event stream
  if (payload.purposeKey !== AI_TRAINING_PURPOSE_KEY) {
    return { outcome: "ignored", reason: "not the ai_training purpose" };
  }

  if (!payload.subject) {
    console.warn("[consent consumer] event missing subject, ignoring");
    return { outcome: "ignored", reason: "missing subject" };
  }

  if (typeof payload.granted !== "boolean") {
    console.warn("[consent consumer] event missing granted flag, ignoring");
    return { outcome: "ignored", reason: "missing granted flag" };
  }

  // upserts the local row to match (and, on a withdrawal, erases the user's
  // stored samples). A failure throws so the webhook route returns 500 and
  // Vortex redelivers
  await store.setConsent(
    payload.subject,
    payload.granted,
    payload.policyVersion,
  );

  return { outcome: "applied", granted: payload.granted };
};
