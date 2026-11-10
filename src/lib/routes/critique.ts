import { Elysia } from "elysia";

import { getAiConfig } from "lib/config/ai.config";

import type { SpendBreaker } from "lib/cost/breaker";
import type { CreditStore } from "lib/cost/creditStore";
import type { RateLimiter } from "lib/cost/rateLimit";
import type { SynapseContentBlock, callSynapse } from "lib/synapse/client";

/**
 * POST /critique - a money-spending route: hand a rendered image of a generated
 * part to a vision model and ask whether it matches the user's request. This is
 * the grounding step of the render-and-critique generation loop: instead of the
 * model guessing blindly, it reacts to what its code actually produced.
 *
 * Money-safety is IDENTICAL to /generate (same injected deps, same gating), so
 * every spend is bounded the same way: signed-in Omni identity on the managed
 * path, the limited-preview allowlist, the per-user hard monthly credit cap, the
 * free-tier daily breaker, the per-IP limiter, per-request caps, and BYOK
 * bypasses all of it at zero cost to us. Keep this in lockstep with generate.ts
 */

interface CritiqueDeps {
  callSynapse: typeof callSynapse;
  breaker: SpendBreaker;
  rateLimiter: RateLimiter;
  authenticate: (request: Request) => Promise<{ userId: string } | null>;
  creditStore: CreditStore;
  provisioner?: { resolveKey: (userId: string) => Promise<string> };
}

interface CritiqueImage {
  /** Base64 (no data: prefix) of a PNG/JPEG/WebP render of the result. */
  data?: unknown;
  mediaType?: unknown;
}

interface CritiqueBody {
  prompt?: unknown;
  code?: unknown;
  image?: CritiqueImage;
  byokKey?: unknown;
}

/** The structured verdict returned to the client. */
interface Critique {
  ok: boolean;
  score: number;
  issues: string[];
  suggestedFix: string | null;
}

/** Generic, user-safe messages. Technical detail is logged server-side only. */
const MESSAGES = {
  badInput: "Missing prompt, code, or render image.",
  rateLimited: "Too many requests. Please slow down and try again.",
  unauthorized: "Sign in to use managed AI critique, or provide your own key.",
  notAllowed: "Managed AI generation is in limited preview.",
  overCap:
    "You have used all of your AI credits for this month. Upgrade for more, or provide your own key.",
  unavailable: "AI critique is temporarily unavailable.",
  failed: "AI critique failed. Please try again.",
} as const;

const ALLOWED_MEDIA = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Best-effort client IP for rate limiting. */
const clientIp = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
};

const logFailure = (reason: string): void => {
  // biome-ignore lint/suspicious/noConsole: server-side failure log, no secrets
  console.error(`[critique] ${reason}`);
};

/** Parse the model's JSON verdict defensively; null if it is not usable. */
const parseCritique = (text: string): Critique | null => {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const ok = r.ok === true;
  const score =
    typeof r.score === "number" && Number.isFinite(r.score)
      ? Math.max(0, Math.min(1, r.score))
      : ok
        ? 1
        : 0;
  const issues = Array.isArray(r.issues)
    ? r.issues.filter((i): i is string => typeof i === "string").slice(0, 10)
    : [];
  const suggestedFix =
    typeof r.suggestedFix === "string" && r.suggestedFix.trim().length > 0
      ? r.suggestedFix
      : null;
  return { ok, score, issues, suggestedFix };
};

const CRITIQUE_SYSTEM = [
  "You are a strict reviewer of generated 3D CAD parts.",
  "You are given the user's request, the code that was generated, and a rendered image of the resulting geometry.",
  "Judge ONLY whether the rendered result matches the user's request. Be concrete and visual.",
  "Reply with exactly one JSON object and nothing else:",
  '{ "ok": boolean, "score": number (0..1), "issues": string[], "suggestedFix": string }',
  "ok is true only when the result clearly matches the request. issues are short, concrete observations.",
  "suggestedFix is one actionable sentence describing how to change the code to fix the biggest issue (empty string if ok).",
].join("\n");

export const createCritiqueRoute = (deps: CritiqueDeps) =>
  new Elysia().post("/critique", async ({ body, request, set }) => {
    const cfg = getAiConfig();
    const input = (body ?? {}) as CritiqueBody;

    // 1. validate inputs
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const code = typeof input.code === "string" ? input.code : "";
    const imgData =
      typeof input.image?.data === "string" ? input.image.data : "";
    const mediaType =
      typeof input.image?.mediaType === "string"
        ? input.image.mediaType
        : "image/png";
    if (
      prompt.trim().length === 0 ||
      prompt.length > cfg.maxPromptChars ||
      code.trim().length === 0 ||
      imgData.length === 0 ||
      !ALLOWED_MEDIA.has(mediaType)
    ) {
      set.status = 400;
      return { error: MESSAGES.badInput };
    }

    // 2. per-IP rate limit
    if (!deps.rateLimiter.allow(clientIp(request))) {
      set.status = 429;
      return { error: MESSAGES.rateLimited };
    }

    // 3. managed-path gating (BYOK bypasses every managed check) - mirrors generate
    const byokKey =
      typeof input.byokKey === "string" && input.byokKey.length > 0
        ? input.byokKey
        : undefined;
    let userId: string | undefined;
    let isPaid = false;
    if (!byokKey) {
      if (!cfg.managedEnabled) {
        set.status = 503;
        return { error: MESSAGES.unavailable };
      }
      const identity = await deps.authenticate(request);
      if (!identity) {
        set.status = 401;
        return { error: MESSAGES.unauthorized };
      }
      userId = identity.userId;
      if (
        cfg.managedAllowlist.length > 0 &&
        !cfg.managedAllowlist.includes(userId)
      ) {
        set.status = 403;
        return { error: MESSAGES.notAllowed };
      }
      const usage = await deps.creditStore.getMonthlyUsage(userId);
      if (usage.usedCredits >= usage.capCredits) {
        set.status = 402;
        return { error: MESSAGES.overCap };
      }
      isPaid = usage.capCredits > cfg.freeMonthlyCredits;
      if (!isPaid && (await deps.breaker.isTripped())) {
        set.status = 503;
        return { error: MESSAGES.unavailable };
      }
    }

    // 4. build the multimodal critique turn (text + the render)
    const content: SynapseContentBlock[] = [
      {
        type: "text",
        text: `Request:\n${prompt}\n\nGenerated code:\n${code}\n\nDoes the rendered result match the request?`,
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType as "image/png",
          data: imgData,
        },
      },
    ];

    // 5. resolve a per-user managed key when provisioning is enabled
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

    // 6. call the (multimodal) model; never let provider detail reach the client
    let result: Awaited<ReturnType<typeof callSynapse>>;
    try {
      result = await deps.callSynapse({
        system: CRITIQUE_SYSTEM,
        messages: [{ role: "user", content }],
        maxTokens: cfg.maxOutputTokens,
        apiKey: byokKey ?? managedKey,
      });
    } catch (err) {
      logFailure(err instanceof Error ? err.message : "unknown upstream error");
      set.status = 502;
      return { error: MESSAGES.failed };
    }

    const critique = parseCritique(result.text);
    if (!critique) {
      set.status = 422;
      return { error: MESSAGES.failed };
    }

    // 7. meter managed spend only (BYOK is billed to the caller) - mirrors generate
    const credits = Math.ceil(result.usage.costCents * cfg.creditCogsMarkup);
    if (!byokKey && userId) {
      if (!isPaid) {
        try {
          await deps.breaker.record(result.usage.costCents);
        } catch (err) {
          logFailure(
            `breaker record failed: ${
              err instanceof Error ? err.message : "unknown error"
            }`,
          );
        }
      }
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

    return critique;
  });
