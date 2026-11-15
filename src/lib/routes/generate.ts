import { Elysia } from "elysia";

import { getAiConfig } from "lib/config/ai.config";
import {
  buildRefineMessages,
  buildRepairMessages,
  buildSystemPrompt,
} from "lib/prompt/facetSystemPrompt";
import {
  classifyUpstreamFailure,
  recordFreeSpend,
  resolveManagedAccess,
} from "lib/routes/managedAccess";
import { resolveGenerationId } from "lib/routes/telemetry";

import type { RateLimiter } from "lib/cost/rateLimit";
import type { ManagedDeps } from "lib/routes/managedAccess";
import type { SampleStore } from "lib/routes/sampleStore";
import type { GenerationEvents } from "lib/routes/telemetry";
import type { callSynapse } from "lib/synapse/client";

/**
 * POST /generate - a money-spending route.
 *
 * Billing is the Synapse gateway's: a managed call carries a product-scoped key
 * for the facet Aether app, so the gateway checks the user's pooled credit
 * balance (402 before any spend when it is empty), meters the call, and debits
 * the balance. Facet computes no credits of its own. Money-safety around that is
 * defense-in-depth and each layer is independent (see `managedAccess.ts`):
 * - managed generation requires a signed-in Omni identity and a provisioned
 *   product-scoped key; there is no shared key to fall back to, so a
 *   provisioning failure is a 503, never unbilled spend
 * - the global daily breaker (real cents) gates the FREE tier only, so free-tier
 *   abuse (Sybil farming) cannot exhaust the ceiling and block paying users
 * - per-request caps (prompt length, output tokens, timeout) bound each call
 * - a per-IP sliding-window limiter throttles abuse
 * - BYOK bypasses auth, the breaker, and provisioning entirely (the caller's
 *   own key, zero cost to us)
 *
 * Dependencies are injected so every branch is deterministically testable
 */

interface GenerateDeps extends ManagedDeps {
  callSynapse: typeof callSynapse;
  rateLimiter: RateLimiter;
  /**
   * Optional events provider for fleet AI-usage telemetry. A successful
   * generation emits `facet.generation.completed` (usage metadata only, never
   * the prompt or code). Fire-and-forget: a failure never affects the response.
   * Omitted in tests that do not assert on events
   */
  events?: GenerationEvents;
  /**
   * Optional consented-sample store. When present, a successful managed
   * generation persists the prompt and final code as AI training/eval data, but
   * ONLY for a signed-in user who has opted in (the store enforces the consent
   * gate and stores nothing otherwise). Fire-and-forget: a failure never affects
   * the response, and a BYOK or anonymous call never reaches it. Omitted in
   * tests and whenever the database is unavailable
   */
  samples?: Pick<SampleStore, "capture">;
}

interface GenerateBody {
  prompt?: unknown;
  byokKey?: unknown;
  previous?: { code?: unknown; error?: unknown };
  /** A render-critic refine pass: prior code plus the critic's visual suggestion. */
  refine?: { code?: unknown; suggestion?: unknown };
  attempt?: unknown;
  /**
   * The generation id of the chain this call belongs to. The client echoes the
   * id from the original draft on a refine or repair re-entry so the whole loop
   * correlates in telemetry; absent on a first draft (one is minted)
   */
  generationId?: unknown;
}

/** Generic, user-safe messages. Technical detail is logged server-side only. */
const MESSAGES = {
  badPrompt: "Prompt is missing or too long.",
  rateLimited: "Too many requests. Please slow down and try again.",
  repairLimited:
    "Too many repair attempts. Please adjust your prompt and try again.",
  unauthorized:
    "Sign in to use managed AI generation, or provide your own key.",
  notAllowed: "Managed AI generation is in limited preview.",
  outOfCredits:
    "You are out of AI credits. Buy more credits to keep generating, or provide your own key.",
  unavailable: "AI generation is temporarily unavailable.",
  noCode: "Could not generate valid code. Try rephrasing your request.",
  failed: "AI generation failed. Please try again.",
} as const;

/** Extract the first fenced code block (ts/js tagged or untagged); null if none. */
const extractCode = (text: string): string | null => {
  const match = text.match(
    /```(?:ts|tsx|typescript|js|jsx|javascript)?[ \t]*\r?\n([\s\S]*?)```/,
  );
  const code = match?.[1]?.trim();
  return code ? code : null;
};

/** Best-effort client IP for rate limiting. */
const clientIp = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
};

/** Log a technical failure server-side without leaking secrets or the request body. */
const logFailure = (reason: string): void => {
  // biome-ignore lint/suspicious/noConsole: server-side failure log, no secrets
  console.error(`[generate] ${reason}`);
};

export const createGenerateRoute = (deps: GenerateDeps) =>
  new Elysia().post("/generate", async ({ body, request, set }) => {
    const cfg = getAiConfig();
    const input = (body ?? {}) as GenerateBody;

    // 1. validate the prompt
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (prompt.trim().length === 0 || prompt.length > cfg.maxPromptChars) {
      set.status = 400;
      return { error: MESSAGES.badPrompt };
    }

    // the correlation id for this generation chain: minted on a first draft,
    // echoed by the client on a refine or repair re-entry so the whole loop
    // (draft, critique, refine) threads together in telemetry
    const generationId = resolveGenerationId(input.generationId);

    // 2. per-IP rate limit
    if (!deps.rateLimiter.allow(clientIp(request))) {
      set.status = 429;
      return { error: MESSAGES.rateLimited };
    }

    // 3. per-request repair-attempt ceiling
    const attempt =
      typeof input.attempt === "number" && Number.isFinite(input.attempt)
        ? input.attempt
        : 0;
    if (attempt > cfg.maxRepairAttempts) {
      set.status = 429;
      return { error: MESSAGES.repairLimited };
    }

    // 4. managed-path gating and the product-scoped key (BYOK bypasses every
    // managed check)
    const byokKey =
      typeof input.byokKey === "string" && input.byokKey.length > 0
        ? input.byokKey
        : undefined;
    const access = byokKey
      ? undefined
      : await resolveManagedAccess(deps, request, logFailure);
    if (access && !access.ok) {
      set.status = access.status;
      return { error: MESSAGES[access.reason] };
    }
    const grant = access?.ok ? access : undefined;

    // 5. build the grounded conversation. Two mutually exclusive follow-up paths
    // extend the original user turn: a kernel-error repair (prior code + the
    // thrown error) or a render-critic refine (prior code + a visual suggestion).
    // Repair wins if both are somehow present, since an error is the harder stop
    const userTurn = { role: "user" as const, content: prompt };
    const previous = input.previous;
    const refine = input.refine;
    let messages: { role: "user" | "assistant"; content: string }[];
    if (
      previous &&
      typeof previous.code === "string" &&
      typeof previous.error === "string"
    ) {
      messages = [
        userTurn,
        ...buildRepairMessages(previous.code, previous.error),
      ];
    } else if (
      refine &&
      typeof refine.code === "string" &&
      typeof refine.suggestion === "string"
    ) {
      messages = [
        userTurn,
        ...buildRefineMessages(refine.code, refine.suggestion),
      ];
    } else {
      messages = [userTurn];
    }

    // 6. call Synapse with the BYOK key or the product-scoped managed key
    // (never let provider detail reach the client)
    const apiKey = byokKey ?? grant?.apiKey;
    if (!apiKey) {
      set.status = 503;
      return { error: MESSAGES.unavailable };
    }
    let result: Awaited<ReturnType<typeof callSynapse>>;
    try {
      result = await deps.callSynapse({
        system: buildSystemPrompt(),
        messages,
        maxTokens: cfg.maxOutputTokens,
        apiKey,
      });
    } catch (err) {
      logFailure(err instanceof Error ? err.message : "unknown upstream error");
      // BYOK failures stay generic; a managed refusal maps the gateway status
      // (402 out of credits, 503 unavailable) onto the user's next step
      const failure = grant
        ? classifyUpstreamFailure(err)
        : { status: 502, reason: "failed" as const };
      set.status = failure.status;
      return { error: MESSAGES[failure.reason] };
    }

    // 7. record free-tier spend against the breaker (real cents from the
    // gateway when reported, else the estimate). The call already happened, so
    // this runs even when the output carries no code
    if (grant) {
      await recordFreeSpend(
        deps.breaker,
        grant,
        result.usage.costCents,
        logFailure,
      );
    }

    // 8. extract the code
    const code = extractCode(result.text);
    if (!code) {
      set.status = 422;
      return { error: MESSAGES.noCode };
    }

    // 9. emit an AI-usage event for fleet analytics (fire-and-forget: never
    // blocks or fails the response). Usage metadata only, no prompt or code,
    // and no credits: the gateway owns billing
    const userId = grant?.userId;
    void deps.events
      ?.emit({
        type: "facet.generation.completed",
        correlationId: generationId,
        data: {
          byok: Boolean(byokKey),
          userId: userId ?? null,
          model: cfg.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costCents: result.usage.costCents,
          repaired: attempt > 0,
          refined: Boolean(
            refine &&
              typeof refine.code === "string" &&
              typeof refine.suggestion === "string",
          ),
        },
        ...(userId ? { subject: userId } : {}),
      })
      .catch((err: unknown) => {
        logFailure(
          `event emit failed: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      });

    // 10. consented eval capture: retain the prompt and final code as AI
    // training data, but ONLY for a signed-in managed user who opted in (the
    // store enforces the consent gate). Fire-and-forget and best-effort: never
    // blocks or fails the response, and a BYOK or anonymous call (no `userId`)
    // never reaches it
    if (userId) {
      void deps.samples
        ?.capture({ generationId, userId, prompt, code, model: cfg.model })
        .catch((err: unknown) => {
          logFailure(
            `sample capture failed: ${
              err instanceof Error ? err.message : "unknown error"
            }`,
          );
        });
    }

    // the client echoes generationId on a refine/repair re-entry and on the
    // disposition report, so the whole loop correlates in telemetry
    return { code, generationId };
  });
