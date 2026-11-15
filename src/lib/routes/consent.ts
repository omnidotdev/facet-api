import { Elysia } from "elysia";

import { AI_TRAINING_CONSENT_VERSION } from "lib/routes/sampleStore";

import type { SampleStore } from "lib/routes/sampleStore";
import type { GenerationEvents } from "lib/routes/telemetry";

/**
 * POST /consent - set the caller's opt-in for AI training data.
 *
 * This is the switch behind the consented generation-sample dataset: with it on,
 * `/generate` retains the user's prompt and final code as training/eval data;
 * with it off, nothing is stored and everything previously stored for the user
 * is deleted (the store does the erasure). It spends no money and touches only
 * the caller's own record.
 *
 * Unlike `/disposition`, this route is authenticated: consent is a per-user
 * setting, so an unauthenticated request is refused rather than silently
 * recording consent against no one. The body is a single boolean; the store
 * upserts the user's row, so a brand-new user can opt in on their first call
 */

interface ConsentDeps {
  authenticate: (request: Request) => Promise<{ userId: string } | null>;
  /** Persistence for the consent flag (and the erase-on-withdrawal it triggers). */
  store: Pick<SampleStore, "setConsent">;
  /**
   * Audit sink. Each grant or withdrawal emits an immutable
   * `facet.user.consent_changed` event (user, new state, terms version), the
   * append-only record that lets us demonstrate consent for the period data was
   * retained (GDPR Art. 7). Best-effort: a sink failure is logged but never
   * fails the user's toggle
   */
  events?: GenerationEvents;
  /**
   * Forward the decision to the central consent ledger (omni-api), so it is
   * recorded fleet-wide and reflected on other surfaces (e.g. the account hub).
   * Best-effort: a failure is logged but never fails the user's toggle, since
   * the local write above is already the capture-gate (and erased on withdrawal)
   */
  forwardConsent?: (accessToken: string, granted: boolean) => Promise<void>;
}

interface ConsentBody {
  consent?: unknown;
}

/** Generic, user-safe messages. Technical detail is logged server-side only. */
const MESSAGES = {
  badInput: "Missing or invalid consent value.",
  unauthorized: "Sign in to change this setting.",
  failed: "Could not update the setting. Please try again.",
} as const;

const logFailure = (reason: string): void => {
  // biome-ignore lint/suspicious/noConsole: server-side failure log, no secrets
  console.error(`[consent] ${reason}`);
};

export const createConsentRoute = (deps: ConsentDeps) =>
  new Elysia().post("/consent", async ({ body, request, set }) => {
    const input = (body ?? {}) as ConsentBody;

    // 1. the body must carry an explicit boolean, never a coerced value
    if (typeof input.consent !== "boolean") {
      set.status = 400;
      return { error: MESSAGES.badInput };
    }

    // 2. consent is per-user: an unauthenticated request has no one to record
    // it against, so it is refused (this is the one AI route that requires auth)
    const identity = await deps.authenticate(request).catch(() => null);
    if (!identity) {
      set.status = 401;
      return { error: MESSAGES.unauthorized };
    }

    // 3. persist the choice (and, on withdrawal, erase prior samples)
    try {
      await deps.store.setConsent(identity.userId, input.consent);
    } catch (err) {
      logFailure(err instanceof Error ? err.message : "unknown error");
      set.status = 500;
      return { error: MESSAGES.failed };
    }

    // 4. forward to the central ledger so the decision is recorded fleet-wide
    // and other surfaces (e.g. the account hub) reflect it. Best-effort: the
    // local write above already took effect (incl. erasure on withdrawal), so a
    // failure here only risks a transient cross-surface mismatch the next change
    // resolves, never the user's own setting
    const accessToken = request.headers
      .get("authorization")
      ?.split("Bearer ")[1];
    if (accessToken && deps.forwardConsent) {
      try {
        await deps.forwardConsent(accessToken, input.consent);
      } catch (err) {
        logFailure(
          `central consent forward failed: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      }
    }

    // 5. record the change in the append-only audit stream. Awaited so the
    // record has the best chance of landing, but a sink failure never fails the
    // toggle: the user's choice is already persisted and is the live record
    try {
      await deps.events?.emit({
        type: "facet.user.consent_changed",
        data: {
          userId: identity.userId,
          consent: input.consent,
          version: AI_TRAINING_CONSENT_VERSION,
        },
        subject: identity.userId,
      });
    } catch (err) {
      logFailure(
        `consent audit event failed: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      );
    }

    return { consent: input.consent };
  });
