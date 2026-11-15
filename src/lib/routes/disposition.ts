import { Elysia } from "elysia";

import { resolveGenerationId } from "lib/routes/telemetry";

import type { RateLimiter } from "lib/cost/rateLimit";
import type { GenerationEvents } from "lib/routes/telemetry";

/**
 * POST /disposition - the human-in-the-loop signal, and the one datum the
 * server cannot see on its own: what the user did with a generation (kept it,
 * discarded it, or regenerated). It is the label that turns raw usage telemetry
 * into a quality signal ("what share of drafts, by model, does a user keep?"),
 * the groundwork for later model and prompt improvement.
 *
 * This route spends no money and stores nothing: it emits one metadata-only
 * CloudEvent correlated to the generation id, carrying the disposition and (when
 * resolvable) the user, never the prompt or the code. It is unauthenticated so a
 * BYOK user's signal is not lost, and bounded only by validation and the per-IP
 * limiter, since a spoofed disposition pollutes analytics at worst, never spend
 */

interface DispositionDeps {
  rateLimiter: RateLimiter;
  /**
   * Resolve the signed-in identity for a best-effort `subject`. Optional and
   * never gating: an absent or invalid identity still records the disposition
   * (BYOK users are not signed in), just without a user
   */
  authenticate?: (request: Request) => Promise<{ userId: string } | null>;
  /** Fire-and-forget telemetry sink; a failure never affects the response. */
  events?: GenerationEvents;
}

interface DispositionBody {
  generationId?: unknown;
  disposition?: unknown;
}

/**
 * What the user did with a generation:
 * - `kept`: applied or left the generated code in place (the implicit accept)
 * - `discarded`: dismissed it without keeping the result
 * - `regenerated`: triggered another pass (a refine or a fresh attempt)
 */
const DISPOSITIONS = new Set(["kept", "discarded", "regenerated"]);

const MESSAGES = {
  badInput: "Missing or invalid disposition.",
  rateLimited: "Too many requests. Please slow down and try again.",
} as const;

/** Best-effort client IP for rate limiting. */
const clientIp = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
};

const logFailure = (reason: string): void => {
  // biome-ignore lint/suspicious/noConsole: server-side failure log, no secrets
  console.error(`[disposition] ${reason}`);
};

export const createDispositionRoute = (deps: DispositionDeps) =>
  new Elysia().post("/disposition", async ({ body, request, set }) => {
    const input = (body ?? {}) as DispositionBody;

    // 1. validate: a bounded generation id and a known disposition
    const disposition =
      typeof input.disposition === "string" ? input.disposition : "";
    if (
      typeof input.generationId !== "string" ||
      input.generationId.length === 0 ||
      !DISPOSITIONS.has(disposition)
    ) {
      set.status = 400;
      return { error: MESSAGES.badInput };
    }
    const generationId = resolveGenerationId(input.generationId);

    // 2. per-IP rate limit (the only abuse bound; no spend to protect)
    if (!deps.rateLimiter.allow(clientIp(request))) {
      set.status = 429;
      return { error: MESSAGES.rateLimited };
    }

    // 3. best-effort identity for the subject, never gating
    let userId: string | undefined;
    try {
      userId = (await deps.authenticate?.(request))?.userId;
    } catch {
      userId = undefined;
    }

    // 4. emit the disposition correlated to the generation (fire-and-forget)
    void deps.events
      ?.emit({
        type: `facet.generation.${disposition}`,
        correlationId: generationId,
        data: { userId: userId ?? null },
        ...(userId ? { subject: userId } : {}),
      })
      .catch((err: unknown) => {
        logFailure(
          `event emit failed: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      });

    return { ok: true };
  });
