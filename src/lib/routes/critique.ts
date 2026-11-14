import { Elysia } from "elysia";

import { getAiConfig } from "lib/config/ai.config";
import {
  classifyUpstreamFailure,
  recordFreeSpend,
  resolveManagedAccess,
} from "lib/routes/managedAccess";

import type { RateLimiter } from "lib/cost/rateLimit";
import type { ManagedDeps } from "lib/routes/managedAccess";
import type { SynapseContentBlock, callSynapse } from "lib/synapse/client";

/**
 * POST /critique - a money-spending route: hand a rendered image of a generated
 * part to a vision model and ask whether it matches the user's request. This is
 * the grounding step of the render-and-critique generation loop: instead of the
 * model guessing blindly, it reacts to what its code actually produced.
 *
 * Money-safety is IDENTICAL to /generate (the same shared managed gating in
 * `managedAccess.ts`): a signed-in Omni identity, the limited-preview
 * allowlist, the free-tier daily breaker, a product-scoped key billed by the
 * gateway against the user's pooled balance (no shared-key fallback), the
 * per-IP limiter, and per-request caps. BYOK bypasses all of it at zero cost
 * to us. Keep this in lockstep with generate.ts
 */

interface CritiqueDeps extends ManagedDeps {
  callSynapse: typeof callSynapse;
  rateLimiter: RateLimiter;
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
  outOfCredits:
    "You are out of AI credits. Buy more credits to keep going, or provide your own key.",
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

    // 3. managed-path gating and the product-scoped key (BYOK bypasses every
    // managed check) - mirrors generate
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
    const apiKey = byokKey ?? grant?.apiKey;
    if (!apiKey) {
      set.status = 503;
      return { error: MESSAGES.unavailable };
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

    // 5. call the (multimodal) model; never let provider detail reach the client
    let result: Awaited<ReturnType<typeof callSynapse>>;
    try {
      result = await deps.callSynapse({
        system: CRITIQUE_SYSTEM,
        messages: [{ role: "user", content }],
        maxTokens: cfg.maxOutputTokens,
        apiKey,
      });
    } catch (err) {
      logFailure(err instanceof Error ? err.message : "unknown upstream error");
      // BYOK failures stay generic; a managed refusal maps the gateway status
      const failure = grant
        ? classifyUpstreamFailure(err)
        : { status: 502, reason: "failed" as const };
      set.status = failure.status;
      return { error: MESSAGES[failure.reason] };
    }

    // 6. record free-tier real spend against the breaker - mirrors generate
    if (grant) {
      await recordFreeSpend(
        deps.breaker,
        grant,
        result.usage.costCents,
        logFailure,
      );
    }

    const critique = parseCritique(result.text);
    if (!critique) {
      set.status = 422;
      return { error: MESSAGES.failed };
    }

    return critique;
  });
