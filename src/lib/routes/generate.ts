import { Elysia } from "elysia";

import { getAiConfig } from "lib/config/ai.config";
import {
  buildRepairMessages,
  buildSystemPrompt,
} from "lib/prompt/facetSystemPrompt";

import type { SpendBreaker } from "lib/cost/breaker";
import type { CreditStore } from "lib/cost/creditStore";
import type { RateLimiter } from "lib/cost/rateLimit";
import type { callSynapse } from "lib/synapse/client";

/**
 * POST /generate - the only money-spending route.
 *
 * Money-safety is defense-in-depth and each layer is independent:
 * - the server Synapse key lives only in config, never in a response or a log
 * - the managed path requires the key and an untripped global daily breaker
 * - the managed path requires a signed-in Omni identity (no anonymous paid inference)
 * - the managed path is hard-capped per user per UTC month with no overage
 * - per-request caps (prompt length, output tokens, timeout) bound each call
 * - a per-IP sliding-window limiter throttles abuse
 * - BYOK bypasses auth, the managed breaker, and the meter entirely (zero cost to us)
 *
 * Dependencies are injected so every branch is deterministically testable
 */

interface GenerateDeps {
  callSynapse: typeof callSynapse;
  breaker: SpendBreaker;
  rateLimiter: RateLimiter;
  /** Resolve the signed-in Omni identity for a request, or null when absent/invalid. */
  authenticate: (request: Request) => Promise<{ userId: string } | null>;
  /** Per-user monthly credit meter for the managed path. */
  creditStore: CreditStore;
  /**
   * Optional per-user managed-key provisioner. When present, a managed call uses
   * a per-user Synapse key (so Synapse attributes usage per user) instead of the
   * shared server key. The local credit ledger still enforces the hard monthly
   * cap, so this never widens the money-loss surface; a provisioning failure
   * falls back to the shared key rather than blocking generation
   */
  provisioner?: { resolveKey: (userId: string) => Promise<string> };
  /**
   * Optional events provider for fleet AI-usage telemetry. A successful
   * generation emits `facet.generation.completed` (usage metadata only, never
   * the prompt or code). Fire-and-forget: a failure never affects the response.
   * Omitted in tests that do not assert on events
   */
  events?: {
    emit: (event: {
      type: string;
      data: Record<string, unknown>;
      subject?: string;
    }) => Promise<unknown>;
  };
}

interface GenerateBody {
  prompt?: unknown;
  byokKey?: unknown;
  previous?: { code?: unknown; error?: unknown };
  attempt?: unknown;
}

/** Generic, user-safe messages. Technical detail is logged server-side only. */
const MESSAGES = {
  badPrompt: "Prompt is missing or too long.",
  rateLimited: "Too many requests. Please slow down and try again.",
  repairLimited:
    "Too many repair attempts. Please adjust your prompt and try again.",
  unauthorized:
    "Sign in to use managed AI generation, or provide your own key.",
  overCap:
    "You have used all of your AI credits for this month. Upgrade for more, or provide your own key.",
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

    // 4. managed-path gating (BYOK bypasses every managed check)
    const byokKey =
      typeof input.byokKey === "string" && input.byokKey.length > 0
        ? input.byokKey
        : undefined;
    let userId: string | undefined;
    if (!byokKey) {
      if (!cfg.managedEnabled || deps.breaker.isTripped()) {
        set.status = 503;
        return { error: MESSAGES.unavailable };
      }

      // require a signed-in Omni identity before spending our key
      const identity = await deps.authenticate(request);
      if (!identity) {
        set.status = 401;
        return { error: MESSAGES.unauthorized };
      }
      userId = identity.userId;

      // enforce the per-user hard monthly credit cap before any spend
      const usage = await deps.creditStore.getMonthlyUsage(userId);
      if (usage.usedCredits >= usage.capCredits) {
        set.status = 402;
        return { error: MESSAGES.overCap };
      }
    }

    // 5. build the grounded conversation
    const userTurn = { role: "user" as const, content: prompt };
    const previous = input.previous;
    const messages =
      previous &&
      typeof previous.code === "string" &&
      typeof previous.error === "string"
        ? [userTurn, ...buildRepairMessages(previous.code, previous.error)]
        : [userTurn];

    // 5b. resolve a per-user managed key when provisioning is enabled, so Synapse
    // attributes usage per user. The local ledger still hard-caps below; on any
    // provisioning failure, fall back to the shared server key (never block)
    let managedKey: string | undefined;
    if (!byokKey && userId && deps.provisioner) {
      try {
        managedKey = await deps.provisioner.resolveKey(userId);
      } catch (err) {
        logFailure(
          `per-user key provisioning failed, using shared key: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      }
    }

    // 6. call Synapse (never let provider detail reach the client). A BYOK key
    // wins; else the per-user managed key when provisioned; else the shared key
    let result: Awaited<ReturnType<typeof callSynapse>>;
    try {
      result = await deps.callSynapse({
        system: buildSystemPrompt(),
        messages,
        maxTokens: cfg.maxOutputTokens,
        apiKey: byokKey ?? managedKey,
      });
    } catch (err) {
      logFailure(err instanceof Error ? err.message : "unknown upstream error");
      set.status = 502;
      return { error: MESSAGES.failed };
    }

    // 7. extract the code
    const code = extractCode(result.text);
    if (!code) {
      set.status = 422;
      return { error: MESSAGES.noCode };
    }

    // 8. meter managed spend only (BYOK is billed to the caller)
    const credits = Math.ceil(result.usage.costCents);
    if (!byokKey && userId) {
      deps.breaker.record(result.usage.costCents);
      // the spend already happened upstream, so a meter write failure must not
      // fail the response or lose the user's code; log and fall through
      try {
        await deps.creditStore.recordSpend(userId, credits);
      } catch (err) {
        logFailure(
          `credit record failed: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      }
    }

    // 9. emit an AI-usage event for fleet analytics (fire-and-forget: never
    // blocks or fails the response). Usage metadata only, no prompt or code
    void deps.events
      ?.emit({
        type: "facet.generation.completed",
        data: {
          byok: Boolean(byokKey),
          userId: userId ?? null,
          model: cfg.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costCents: result.usage.costCents,
          credits,
          repaired: attempt > 0,
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

    return {
      code,
      usage: {
        credits,
        costCents: result.usage.costCents,
      },
    };
  });
