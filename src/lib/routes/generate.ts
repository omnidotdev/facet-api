import { Elysia } from "elysia";

import { getAiConfig } from "lib/config/ai.config";
import {
  buildRepairMessages,
  buildSystemPrompt,
} from "lib/prompt/facetSystemPrompt";

import type { SpendBreaker } from "lib/cost/breaker";
import type { RateLimiter } from "lib/cost/rateLimit";
import type { callSynapse } from "lib/synapse/client";

/**
 * POST /generate - the only money-spending route.
 *
 * Money-safety is defense-in-depth and each layer is independent:
 * - the server Synapse key lives only in config, never in a response or a log
 * - the managed path requires the key and an untripped global daily breaker
 * - per-request caps (prompt length, output tokens, timeout) bound each call
 * - a per-IP sliding-window limiter throttles abuse
 * - BYOK bypasses the managed breaker and meter entirely (zero cost to us)
 *
 * Dependencies are injected so every branch is deterministically testable
 */

interface GenerateDeps {
  callSynapse: typeof callSynapse;
  breaker: SpendBreaker;
  rateLimiter: RateLimiter;
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

    // 4. managed-path gating (BYOK bypasses both checks)
    const byokKey =
      typeof input.byokKey === "string" && input.byokKey.length > 0
        ? input.byokKey
        : undefined;
    if (!byokKey) {
      if (!cfg.managedEnabled || deps.breaker.isTripped()) {
        set.status = 503;
        return { error: MESSAGES.unavailable };
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

    // 6. call Synapse (never let provider detail reach the client)
    let result: Awaited<ReturnType<typeof callSynapse>>;
    try {
      result = await deps.callSynapse({
        system: buildSystemPrompt(),
        messages,
        maxTokens: cfg.maxOutputTokens,
        apiKey: byokKey,
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
    if (!byokKey) deps.breaker.record(result.usage.costCents);

    return {
      code,
      usage: {
        credits: Math.ceil(result.usage.costCents),
        costCents: result.usage.costCents,
      },
    };
  });
