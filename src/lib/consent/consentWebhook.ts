import { Elysia } from "elysia";

import { CONSENT_WEBHOOK_SECRET } from "lib/config/env.config";
import { applyConsentChange } from "lib/consent/consentConsumer";
import verifyHmacSignature from "lib/crypto/verifyHmacSignature";
import { dbPool } from "lib/db";
import { createSampleStore } from "lib/routes/sampleStore";

import type { ConsentChangeResult } from "lib/consent/consentConsumer";

/**
 * Vortex webhook receiver for central consent changes.
 *
 * Consumes platform.consent.changed (and ignores anything else) so a consent
 * withdrawal made on another surface (e.g. the account hub) also erases the
 * user's samples held here. Signature-gated service-to-service, so it sits
 * outside the authenticated AI routes. The verify/parse/route decision is a
 * pure, dependency-injected handleConsentDelivery (unit tested with an injected
 * apply, no module mocks, which bun applies globally); the Elysia route is a
 * thin adapter backed by the live sample store.
 *
 * Mounted at /webhooks/consent, distinct from the authenticated /consent AI
 * route (the in-app toggle) that writes the local row and forwards to the ledger
 */

/** The one event type this receiver acts on. */
const CONSENT_CHANGED_TYPE = "platform.consent.changed";

/**
 * Extract the CloudEvent `type` and `data` from a delivered body, handling both
 * Vortex payload modes: "envelope" delivers `{ type, source, data, ... }`,
 * "data" delivers the data object directly (type then unknown).
 */
const extractEvent = (
  body: unknown,
): { type: string | null; data: Record<string, unknown> } => {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : null;
    if (typeof record.data === "object" && record.data !== null) {
      return { type, data: record.data as Record<string, unknown> };
    }
    return { type, data: record };
  }
  return { type: null, data: {} };
};

/** An HTTP result for the route adapter to return. */
interface DeliveryResult {
  status: number;
  body: string;
}

/**
 * Pure verify/parse/route-decision for one Vortex delivery.
 *
 * Verifies the HMAC signature (401 on missing/invalid, never processed), applies
 * platform.consent.changed via the injected `apply`, and drops anything else
 * with 200. A malformed authentic body is dropped (200, a retry cannot help); an
 * error from `apply` returns 500 so Vortex retries. Never leaks internal detail.
 */
export const handleConsentDelivery = async ({
  rawBody,
  signature,
  secret,
  apply,
}: {
  rawBody: string;
  signature: string | undefined;
  secret: string | undefined;
  apply: (payload: Record<string, unknown>) => Promise<ConsentChangeResult>;
}): Promise<DeliveryResult> => {
  // Vortex delivery is signed; without a configured secret we cannot verify any
  // event, so refuse rather than process an unverifiable payload
  if (!secret) {
    console.error(
      "[consent webhook] CONSENT_WEBHOOK_SECRET not set, cannot verify event",
    );
    return { status: 503, body: "Webhook signing secret not configured" };
  }

  if (!signature) return { status: 401, body: "Missing signature" };

  if (!verifyHmacSignature(rawBody, signature, secret)) {
    return { status: 401, body: "Invalid signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    console.warn("[consent webhook] malformed JSON body, dropping");
    return { status: 200, body: "Ignored" };
  }

  const { type, data } = extractEvent(parsed);

  // only consent-change events are acted on; ignore other event types
  if (type && type !== CONSENT_CHANGED_TYPE) {
    return { status: 200, body: "Ignored" };
  }

  try {
    const result = await apply(data);
    return {
      status: 200,
      body: result.outcome === "applied" ? "Applied" : "Ignored",
    };
  } catch (err) {
    // an apply/db failure is retryable: 500 so Vortex redelivers
    console.error("[consent webhook] failed to apply consent change:", err);
    return { status: 500, body: "Internal Server Error" };
  }
};

// one store instance for the receiver, over the shared pool (stateless)
const store = createSampleStore(dbPool);

/**
 * Vortex webhook receiver route. Thin adapter: reads the raw body and delegates
 * to handleConsentDelivery, backing apply with the live sample store.
 */
const consentWebhook = new Elysia().post(
  "/consent",
  async ({ body, headers, set }) => {
    // `type: "text"` keeps the body an unparsed string, so the HMAC is verified
    // over the exact bytes Vortex signed. Reading request.text() instead throws
    // "Body already used" once Elysia has parsed a JSON body
    const { status, body: responseBody } = await handleConsentDelivery({
      rawBody: typeof body === "string" ? body : "",
      signature: headers["x-vortex-signature"],
      secret: CONSENT_WEBHOOK_SECRET,
      apply: (payload) => applyConsentChange({ store, payload }),
    });

    set.status = status;
    return responseBody;
  },
  { parse: "text" },
);

export default consentWebhook;
