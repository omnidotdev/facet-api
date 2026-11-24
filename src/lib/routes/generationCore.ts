import { getAiConfig } from "lib/config/ai.config";
import {
  buildEditMessages,
  buildRefineMessages,
  buildRepairMessages,
  buildSystemPrompt,
} from "lib/prompt/facetSystemPrompt";
import { ERROR_CODES } from "lib/routes/errorCodes";
import {
  classifyUpstreamFailure,
  recordFreeSpend,
} from "lib/routes/managedAccess";
import { resolveGenerationId } from "lib/routes/telemetry";

import type { SpendBreaker } from "@omnidotdev/providers";
import type { GenerationJobKind } from "lib/db/schema";
import type { ErrorReason } from "lib/routes/errorCodes";
import type { ManagedGrant } from "lib/routes/managedAccess";
import type { SampleStore } from "lib/routes/sampleStore";
import type { GenerationEvents } from "lib/routes/telemetry";
import type { callSynapse } from "lib/synapse/client";

/**
 * The generation itself, shared by the synchronous `POST /generate` route and
 * the background job worker so both do exactly the same thing: build the
 * grounded conversation, make ONE Synapse call, record non-paying spend, pull
 * the code out of the reply, emit usage telemetry, and capture a consented
 * sample. Gating (auth, payment, breaker, rate limit, caps) happens before this,
 * in the route that accepts the request
 */

/** Generic, user-safe messages. Technical detail is logged server-side only. */
export const GENERATE_MESSAGES = {
  badPrompt: "Prompt is missing or too long.",
  badInput: "Background generation is not available with your own key.",
  rateLimited: "Too many requests. Please slow down and try again.",
  repairLimited:
    "Too many repair attempts. Please adjust your prompt and try again.",
  tooManyJobs:
    "You already have the most generations running at once. Wait for one to finish, then try again.",
  unauthorized:
    "Sign in to use managed AI generation, or provide your own key.",
  reauth: "Sign in again to keep using AI generation.",
  notAllowed: "Managed AI generation is in limited preview.",
  notFound: "That generation was not found.",
  paymentRequired:
    "AI generation uses Omni credits. Buy credits or upgrade to Pro to start, or use your own key.",
  planRequired:
    "Your plan does not include managed AI generation. Upgrade your plan, or provide your own key.",
  usageLimited:
    "You have reached your AI usage limit. Try again later or upgrade your plan, or provide your own key.",
  outOfCredits:
    "You are out of AI credits. Buy more credits to keep generating, or provide your own key.",
  unavailable: "AI generation is temporarily unavailable.",
  interrupted: "Generation was interrupted. Try again.",
  noCode: "Could not generate valid code. Try rephrasing your request.",
  truncated:
    "That part was too complex to finish in one go. Try describing a simpler version, then add detail.",
  failed: "AI generation failed. Please try again.",
} as const satisfies Partial<Record<ErrorReason, string>>;

export type GenerateReason = keyof typeof GENERATE_MESSAGES;

/**
 * A user-safe error body: the human message plus a stable `code` the client
 * branches on (e.g. `payment_required` versus `out_of_credits`)
 */
export const errorBody = (reason: GenerateReason) => ({
  error: GENERATE_MESSAGES[reason],
  code: ERROR_CODES[reason],
});

/** Best-effort client IP for rate limiting. */
export const clientIp = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
};

/** Extract the first fenced code block (ts/js tagged or untagged); null if none. */
const extractCode = (text: string): string | null => {
  const match = text.match(
    /```(?:ts|tsx|typescript|js|jsx|javascript)?[ \t]*\r?\n([\s\S]*?)```/,
  );
  const code = match?.[1]?.trim();
  return code ? code : null;
};

/** The request body both generation routes accept */
export interface GenerationBody {
  prompt?: unknown;
  byokKey?: unknown;
  previous?: { code?: unknown; error?: unknown };
  /** A render-critic refine pass: prior code plus the critic's visual suggestion. */
  refine?: { code?: unknown; suggestion?: unknown };
  /**
   * An edit: the model open in the user's editor, which the prompt asks to
   * change. Kept on that edit's repairs too, so a fix still knows the request
   */
  edit?: { code?: unknown; params?: unknown };
  attempt?: unknown;
  /**
   * The generation id of the chain this call belongs to. The client echoes the
   * id from the original draft on a refine or repair re-entry so the whole loop
   * correlates in telemetry; absent on a first draft (one is minted)
   */
  generationId?: unknown;
}

/** Parameter slider values by name, as an edit sends them */
export type EditParams = Record<string, number | boolean | string>;

// How many parameter values an edit may carry, and how long a name or a text
// value may be, so the field cannot be used to smuggle a large input
const MAX_EDIT_PARAMS = 64;
const MAX_PARAM_NAME = 80;
const MAX_PARAM_TEXT = 200;

/** Read an edit's parameter values, or null when they are malformed */
const parseEditParams = (input: unknown): EditParams | null => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_EDIT_PARAMS) return null;
  const params: EditParams = {};
  for (const [name, value] of entries) {
    if (name.length === 0 || name.length > MAX_PARAM_NAME) return null;
    const ok =
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean" ||
      (typeof value === "string" && value.length <= MAX_PARAM_TEXT);
    if (!ok) return null;
    params[name] = value;
  }
  return params;
};

/**
 * What a request does. An edit runs only in the foreground (`POST /generate`),
 * so it is not a background job kind
 */
export type GenerationKind = GenerationJobKind | "edit";

/** A validated generation request, the same whether it runs now or as a job */
export interface GenerationRequest {
  prompt: string;
  kind: GenerationKind;
  /** Prior code plus its kernel error, on a repair */
  previous?: { code: string; error: string };
  /** Prior code plus the critic's suggestion, on a refine */
  refine?: { code: string; suggestion: string };
  /**
   * The open model the prompt asks to change, on an edit and its repairs, with
   * the values its parameter sliders are set to right now
   */
  edit?: { code: string; params?: EditParams };
  attempt: number;
  generationId: string;
}

/** A request a background job can run: anything but an edit */
export type QueuedGenerationRequest = GenerationRequest & {
  kind: GenerationJobKind;
  edit?: undefined;
};

/** Whether a request can run as a background job (an edit cannot) */
export const isQueueable = (
  request: GenerationRequest,
): request is QueuedGenerationRequest =>
  request.kind !== "edit" && request.edit === undefined;

/**
 * Read a generation request from a body, or null when the prompt is missing or
 * over the cap, or an edit's code is empty or over its cap. Two mutually
 * exclusive follow-up paths extend the original user turn: a kernel-error
 * repair (prior code plus the thrown error) or a render-critic refine (prior
 * code plus a visual suggestion). Repair wins if both are somehow present,
 * since an error is the harder stop. An edit (the open model plus a requested
 * change) replaces the original user turn, and a repair of the edited code
 * keeps it
 */
export const parseGenerationRequest = (
  input: GenerationBody,
): GenerationRequest | null => {
  const cfg = getAiConfig();
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (prompt.trim().length === 0 || prompt.length > cfg.maxPromptChars) {
    return null;
  }

  const attempt =
    typeof input.attempt === "number" && Number.isFinite(input.attempt)
      ? input.attempt
      : 0;
  // the correlation id for this generation chain: minted on a first draft,
  // echoed by the client on a refine or repair re-entry so the whole loop
  // (draft, critique, refine) threads together in telemetry
  const generationId = resolveGenerationId(input.generationId);
  const { previous, refine } = input;

  let edit: GenerationRequest["edit"];
  if (input.edit !== undefined) {
    const code = input.edit?.code;
    if (
      typeof code !== "string" ||
      code.trim().length === 0 ||
      code.length > cfg.maxCodeChars
    ) {
      return null;
    }
    edit = { code };
    if (input.edit?.params !== undefined) {
      const params = parseEditParams(input.edit.params);
      if (!params) return null;
      if (Object.keys(params).length > 0) edit.params = params;
    }
  }

  if (
    previous &&
    typeof previous.code === "string" &&
    typeof previous.error === "string"
  ) {
    return {
      prompt,
      kind: "repair",
      previous: { code: previous.code, error: previous.error },
      ...(edit ? { edit } : {}),
      attempt,
      generationId,
    };
  }
  if (
    refine &&
    typeof refine.code === "string" &&
    typeof refine.suggestion === "string"
  ) {
    return {
      prompt,
      kind: "refine",
      refine: { code: refine.code, suggestion: refine.suggestion },
      attempt,
      generationId,
    };
  }
  if (edit) return { prompt, kind: "edit", edit, attempt, generationId };
  return { prompt, kind: "draft", attempt, generationId };
};

/** Build the grounded conversation for a request */
const buildMessages = (
  request: GenerationRequest,
): { role: "user" | "assistant"; content: string }[] => {
  // an edit opens on the user's model and the change they asked for
  const opening = request.edit
    ? buildEditMessages(request.edit.code, request.prompt, request.edit.params)
    : [{ role: "user" as const, content: request.prompt }];
  if (request.previous) {
    return [
      ...opening,
      ...buildRepairMessages(request.previous.code, request.previous.error),
    ];
  }
  if (request.refine) {
    return [
      ...opening,
      ...buildRefineMessages(request.refine.code, request.refine.suggestion),
    ];
  }
  return opening;
};

export interface GenerationCoreDeps {
  callSynapse: typeof callSynapse;
  /** Free-tier daily spend breaker; only a non-paying grant is recorded */
  breaker: SpendBreaker;
  /**
   * Optional events provider for fleet AI-usage telemetry. A successful
   * generation emits `facet.generation.completed` (usage metadata only, never
   * the prompt or code). Fire-and-forget: a failure never affects the result
   */
  events?: GenerationEvents;
  /**
   * Optional consented-sample store. A successful managed generation persists
   * the prompt and final code as AI training/eval data, but ONLY for a
   * signed-in user who has opted in (the store enforces the consent gate).
   * Fire-and-forget: a failure never affects the result
   */
  samples?: Pick<SampleStore, "capture">;
}

/** Who pays for a call: the caller's own key, or a granted managed key */
export type GenerationAuth = { byokKey: string } | { grant: ManagedGrant };

/** How a generation ended: the code, or the status and reason to report */
type GenerationOutcome =
  | { ok: true; code: string }
  | { ok: false; status: number; reason: GenerateReason };

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : "unknown error";

/**
 * Run one generation: exactly one Synapse call, never retried here (each call
 * may be billed). Never throws for an upstream failure; the outcome carries
 * the user-safe reason and the status the synchronous route answers with
 */
export const runGeneration = async (
  deps: GenerationCoreDeps,
  request: GenerationRequest,
  auth: GenerationAuth,
  logFailure: (reason: string) => void,
): Promise<GenerationOutcome> => {
  const cfg = getAiConfig();
  const grant = "grant" in auth ? auth.grant : undefined;
  const byok = "byokKey" in auth;

  // call Synapse with the BYOK key or the product-scoped managed key (never
  // let provider detail reach the client)
  let result: Awaited<ReturnType<typeof callSynapse>>;
  try {
    result = await deps.callSynapse({
      system: buildSystemPrompt(),
      messages: buildMessages(request),
      maxTokens: cfg.maxOutputTokens,
      apiKey: grant ? grant.apiKey : (auth as { byokKey: string }).byokKey,
    });
  } catch (err) {
    logFailure(err instanceof Error ? err.message : "unknown upstream error");
    // BYOK failures stay generic; a managed refusal maps the gateway status
    // (402 out of credits, 403 plan, 429 usage limit, 503 unavailable) onto
    // the user's next step
    return {
      ok: false,
      ...(grant
        ? classifyUpstreamFailure(err)
        : { status: 502, reason: "failed" as const }),
    };
  }

  // record non-paying spend against the breaker (real cents from the gateway
  // when reported, else the estimate; a paying customer's spend is never
  // recorded). The call already happened, so this runs even when the output
  // carries no code
  if (grant) {
    await recordFreeSpend(
      deps.breaker,
      grant,
      result.usage.costCents,
      logFailure,
    );
  }

  const code = extractCode(result.text);
  if (!code) {
    // the model's hidden thinking counts toward the output ceiling, so a
    // response that used the whole budget was cut off before its code
    // finished, which is a different fix than a model that declined
    const truncated = result.usage.outputTokens >= cfg.maxOutputTokens;
    logFailure(
      truncated
        ? `output truncated at the ${cfg.maxOutputTokens}-token ceiling`
        : "model returned no fenced code block",
    );
    return {
      ok: false,
      status: 422,
      reason: truncated ? "truncated" : "noCode",
    };
  }

  // emit an AI-usage event for fleet analytics (fire-and-forget). Usage
  // metadata only, no prompt or code, and no credits: the gateway owns billing
  const userId = grant?.userId;
  void deps.events
    ?.emit({
      type: "facet.generation.completed",
      correlationId: request.generationId,
      data: {
        byok,
        userId: userId ?? null,
        model: cfg.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costCents: result.usage.costCents,
        repaired: request.attempt > 0,
        refined: request.kind === "refine",
        edited: request.edit !== undefined,
      },
      ...(userId ? { subject: userId } : {}),
    })
    .catch((err: unknown) => {
      logFailure(`event emit failed: ${errorText(err)}`);
    });

  // consented eval capture: retain the prompt and final code as AI training
  // data, but ONLY for a signed-in managed user who opted in (the store
  // enforces the consent gate). A BYOK call (no `userId`) never reaches it.
  // An edit is not captured: its prompt is a change to code the sample would
  // not hold, and the consent covers prompts and the models generated from them
  if (userId && !request.edit) {
    void deps.samples
      ?.capture({
        generationId: request.generationId,
        userId,
        prompt: request.prompt,
        code,
        model: cfg.model,
      })
      .catch((err: unknown) => {
        logFailure(`sample capture failed: ${errorText(err)}`);
      });
  }

  return { ok: true, code };
};
