import { eq } from "drizzle-orm";

import { generationSampleTable, userTable } from "lib/db/schema";

import type { dbPool } from "lib/db";

/**
 * Version of the AI-training consent terms (what is collected and why). Bump
 * this whenever that scope materially changes, alongside the privacy policy and
 * the toggle copy. Capture is gated on an exact match, so a bumped version
 * silently pauses collection for anyone whose consent predates the change until
 * they opt in again under the new terms, rather than relying on a stale grant.
 * Recorded on the user's row and on every consent-change event for audit
 */
export const AI_TRAINING_CONSENT_VERSION = "2026-11-14";

/**
 * Consented generation-sample store: the persistence behind the opt-in AI
 * training/eval dataset, and the only place in the service that stores a user's
 * prompt or generated code.
 *
 * Every write is gated on the user's own consent flag (`user.aiTrainingConsent`):
 * `capture` stores nothing unless the user has opted in, and `setConsent(false)`
 * deletes everything previously stored for that user, so the dataset never
 * outlives the permission it rests on. Consent is keyed by identity-provider
 * subject (the id `authenticateUser` resolves), and setting it upserts the
 * user's row, so a user need not have been seen before to opt in.
 *
 * The database surface is narrowed and injected so the store is deterministically
 * testable without a live database
 */

/** The minimal Drizzle surface the store needs, for injection in tests. */
type SampleDb = Pick<typeof dbPool, "select" | "insert" | "delete">;

export interface GenerationSampleInput {
  /** Correlates the sample to the generation's CloudEvents. */
  generationId: string;
  /** The opted-in user, by identity-provider subject. */
  userId: string;
  /** The user's request. */
  prompt: string;
  /** The model's final generated code. */
  code: string;
  /** The model that produced the code, for per-model eval slicing. */
  model?: string;
}

export interface SampleStore {
  /**
   * Persist a generation's prompt and code, but ONLY when the user has opted in.
   * A user with consent off (or never seen) stores nothing. Upserts by
   * `generationId` so a refine or repair re-entry overwrites the draft with the
   * final code of the same chain
   */
  capture: (sample: GenerationSampleInput) => Promise<void>;
  /**
   * Set a user's AI-training consent, upserting their row. Turning it off also
   * deletes every sample previously stored for the user, so withdrawal is a real
   * erasure, not just a stop on future collection
   */
  setConsent: (userId: string, consent: boolean) => Promise<void>;
  /** Read a user's current consent (false when the user has never opted in). */
  getConsent: (userId: string) => Promise<boolean>;
}

export const createSampleStore = (db: SampleDb): SampleStore => ({
  async capture({ generationId, userId, prompt, code, model }) {
    const [row] = await db
      .select({
        consent: userTable.aiTrainingConsent,
        version: userTable.aiTrainingConsentVersion,
      })
      .from(userTable)
      .where(eq(userTable.identityProviderId, userId));
    // store nothing without an explicit opt-in under the CURRENT terms: a grant
    // that predates a scope change (stale version) does not authorize capture
    if (!row?.consent || row.version !== AI_TRAINING_CONSENT_VERSION) return;

    await db
      .insert(generationSampleTable)
      .values({ generationId, identityProviderId: userId, prompt, code, model })
      .onConflictDoUpdate({
        target: generationSampleTable.generationId,
        set: { prompt, code, model, updatedAt: new Date().toISOString() },
      });
  },

  async setConsent(userId, consent) {
    // record the moment of the change and the terms in effect when the user
    // acted, for both a grant and a withdrawal (the row is the current state;
    // the event stream is the history)
    const now = new Date().toISOString();
    await db
      .insert(userTable)
      .values({
        identityProviderId: userId,
        aiTrainingConsent: consent,
        aiTrainingConsentAt: now,
        aiTrainingConsentVersion: AI_TRAINING_CONSENT_VERSION,
      })
      .onConflictDoUpdate({
        target: userTable.identityProviderId,
        set: {
          aiTrainingConsent: consent,
          aiTrainingConsentAt: now,
          aiTrainingConsentVersion: AI_TRAINING_CONSENT_VERSION,
          updatedAt: now,
        },
      });

    // withdrawal erases what was already collected, not just future capture
    if (!consent) {
      await db
        .delete(generationSampleTable)
        .where(eq(generationSampleTable.identityProviderId, userId));
    }
  },

  async getConsent(userId) {
    const [row] = await db
      .select({ consent: userTable.aiTrainingConsent })
      .from(userTable)
      .where(eq(userTable.identityProviderId, userId));
    return row?.consent ?? false;
  },
});
