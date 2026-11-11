import { Elysia } from "elysia";

import { fetchImport as defaultFetchImport } from "lib/import/fetchImport";
import { ImportError } from "lib/import/ssrf";

import type { RateLimiter } from "lib/cost/rateLimit";
import type { ImportResult } from "lib/import/fetchImport";

/**
 * POST /import - fetch user-supplied SVG or image art by URL, server-side, so the
 * browser's cross-origin restrictions don't block it. This spends NO AI money; it
 * is a guarded proxy. Its risk is SSRF, so every target is validated against the
 * blocked-range guards and each redirect hop is re-validated (see lib/import). It
 * is bounded by sign-in and the per-IP limiter, and returns SVG text (ready for
 * importSvg) or base64 raster bytes (for the client to vectorize).
 */

interface ImportDeps {
  rateLimiter: RateLimiter;
  authenticate: (request: Request) => Promise<{ userId: string } | null>;
  /** Injectable guarded fetch, defaulting to the real one (for tests). */
  fetchImport?: (url: string) => Promise<ImportResult>;
  /** Max accepted URL length. */
  maxUrlChars?: number;
}

/** Generic, user-safe messages. Technical detail is logged server-side only. */
const MESSAGES = {
  badUrl: "Provide a URL to import.",
  rateLimited: "Too many requests. Please slow down and try again.",
  unauthorized: "Sign in to import art from a URL.",
  failed: "Could not import from that URL.",
} as const;

interface ImportBody {
  url?: unknown;
}

/** Best-effort client IP from the usual proxy headers. */
const clientIp = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
};

const logFailure = (reason: string): void => {
  // biome-ignore lint/suspicious/noConsole: server-side failure log, no secrets
  console.error(`[import] ${reason}`);
};

export const createImportRoute = (deps: ImportDeps) => {
  const run = deps.fetchImport ?? ((url: string) => defaultFetchImport(url));
  const maxUrlChars = deps.maxUrlChars ?? 2048;

  return new Elysia().post("/import", async ({ body, request, set }) => {
    const input = (body ?? {}) as ImportBody;

    // 1. validate the URL
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (url.length === 0 || url.length > maxUrlChars) {
      set.status = 400;
      return { error: MESSAGES.badUrl };
    }

    // 2. per-IP rate limit
    if (!deps.rateLimiter.allow(clientIp(request))) {
      set.status = 429;
      return { error: MESSAGES.rateLimited };
    }

    // 3. require a signed-in identity (bounds abuse of the proxy)
    const identity = await deps.authenticate(request);
    if (identity === null) {
      set.status = 401;
      return { error: MESSAGES.unauthorized };
    }

    // 4. guarded fetch
    try {
      return await run(url);
    } catch (err) {
      if (err instanceof ImportError) {
        set.status = err.status;
        return { error: err.message };
      }
      logFailure(err instanceof Error ? err.message : "unknown import error");
      set.status = 502;
      return { error: MESSAGES.failed };
    }
  });
};
