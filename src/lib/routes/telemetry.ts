/**
 * Shared AI-usage telemetry surface for the generation routes.
 *
 * The product (not the shared Synapse client) is the only place a prompt, the
 * generated code, the user, and the usage all coexist, so fleet AI-usage events
 * are emitted here. Every event is metadata only: a model id, token counts, real
 * cents, a verdict score, a disposition. The prompt and the generated code are
 * NEVER emitted, and no credits (the gateway owns billing). A `generationId`
 * threads one logical generation across its calls (the first draft, the vision
 * critique, any refine or repair re-entry) and the user's later disposition, so
 * the whole loop reads as one correlated chain in the event store
 */

import type { EventInput } from "@omnidotdev/providers";

/**
 * The CloudEvents emit surface the AI routes depend on, narrowed from the
 * provider's `EventsProvider`. Injected so a route stays deterministically
 * testable and so events degrade to a noop when Vortex is not configured.
 * Carries `correlationId` (the generation id) so the loop's events thread
 * together; emits are fire-and-forget, so a failure never affects the response
 */
export interface GenerationEvents {
  emit: (
    event: Pick<EventInput, "type" | "data" | "subject" | "correlationId">,
  ) => Promise<unknown>;
}

/** A generation id is a correlation key, so it is bounded but otherwise opaque. */
const MAX_GENERATION_ID_CHARS = 64;

/**
 * Resolve the generation id for a call: honor a client-supplied one (a refine,
 * repair, critique, or disposition re-entry echoes the original so the chain
 * stays linked), otherwise mint a fresh one. It is a low-stakes analytics
 * correlation key, never an authorization or billing input, so a supplied value
 * is only length-bounded, never trusted further
 */
export const resolveGenerationId = (raw: unknown): string =>
  typeof raw === "string" &&
  raw.length > 0 &&
  raw.length <= MAX_GENERATION_ID_CHARS
    ? raw
    : crypto.randomUUID();
