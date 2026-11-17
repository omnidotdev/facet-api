import { Elysia } from "elysia";

import { getAiConfig } from "lib/config/ai.config";
import {
  clientIp,
  errorBody,
  parseGenerationRequest,
  runGeneration,
} from "lib/routes/generationCore";
import { resolveManagedAccess } from "lib/routes/managedAccess";

import type { RateLimiter } from "lib/cost/rateLimit";
import type {
  GenerationAuth,
  GenerationBody,
  GenerationCoreDeps,
} from "lib/routes/generationCore";
import type { ManagedDeps } from "lib/routes/managedAccess";

/**
 * POST /generate - a money-spending route.
 *
 * Billing is the Synapse gateway's: a managed call carries a product-scoped key
 * for the facet Aether app billed to the user's personal workspace, so the
 * gateway checks that workspace's plan and pooled credit balance (402 before
 * any spend when it is empty), meters the call, and debits the balance. Facet
 * computes no credits of its own. Money-safety around that is defense-in-depth
 * and each layer is independent (see `managedAccess.ts`):
 * - managed generation requires a signed-in Omni identity with a personal
 *   workspace and a provisioned product-scoped key; there is no shared key to
 *   fall back to, so a provisioning failure is a 503, never unbilled spend
 * - managed generation is for PAYING CUSTOMERS only (a paid tier, or a
 *   workspace that bought credits); a free, never-paid workspace is refused
 *   with 402 `payment_required` before any key or spend, so farmed free
 *   accounts cannot spend the managed budget on free grants
 * - the global daily breaker (real cents) is belt-and-braces for non-paying
 *   calls only, so it never blocks a paying customer
 * - per-request caps (prompt length, output tokens, timeout) bound each call
 * - a per-IP sliding-window limiter throttles abuse
 * - BYOK bypasses auth, the payment gate, the breaker, and provisioning
 *   entirely (the caller's own key, zero cost to us)
 *
 * Managed clients prefer `POST /generations`, which runs the same gates and the
 * same generation as a background job (see `generations.ts`). This synchronous
 * route stays for BYOK, whose key is never stored, and for older clients.
 * Both share the generation itself (`generationCore.ts`)
 *
 * Dependencies are injected so every branch is deterministically testable
 */

type GenerateDeps = ManagedDeps &
  GenerationCoreDeps & {
    rateLimiter: RateLimiter;
  };

/** Log a technical failure server-side without leaking secrets or the request body. */
const logFailure = (reason: string): void => {
  // biome-ignore lint/suspicious/noConsole: server-side failure log, no secrets
  console.error(`[generate] ${reason}`);
};

export const createGenerateRoute = (deps: GenerateDeps) =>
  new Elysia().post("/generate", async ({ body, request, set }) => {
    const cfg = getAiConfig();
    const input = (body ?? {}) as GenerationBody;

    // 1. validate the prompt
    const parsed = parseGenerationRequest(input);
    if (!parsed) {
      set.status = 400;
      return errorBody("badPrompt");
    }

    // 2. per-IP rate limit
    if (!deps.rateLimiter.allow(clientIp(request))) {
      set.status = 429;
      return errorBody("rateLimited");
    }

    // 3. per-request repair-attempt ceiling
    if (parsed.attempt > cfg.maxRepairAttempts) {
      set.status = 429;
      return errorBody("repairLimited");
    }

    // 4. managed-path gating and the product-scoped key (BYOK bypasses every
    // managed check)
    let auth: GenerationAuth;
    if (typeof input.byokKey === "string" && input.byokKey.length > 0) {
      auth = { byokKey: input.byokKey };
    } else {
      const access = await resolveManagedAccess(deps, request, logFailure);
      if (!access.ok) {
        set.status = access.status;
        return errorBody(access.reason);
      }
      auth = { grant: access };
    }

    // 5. the generation itself: one Synapse call, spend, code, telemetry, and
    // a consented sample (shared with the background job worker)
    const outcome = await runGeneration(deps, parsed, auth, logFailure);
    if (!outcome.ok) {
      set.status = outcome.status;
      return errorBody(outcome.reason);
    }

    // the client echoes generationId on a refine/repair re-entry and on the
    // disposition report, so the whole loop correlates in telemetry
    return { code: outcome.code, generationId: parsed.generationId };
  });
