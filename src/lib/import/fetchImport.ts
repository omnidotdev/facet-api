/**
 * The import proxy's guarded fetch. Validates a user URL against the SSRF guards,
 * fetches it server-side with a timeout, follows redirects while re-validating
 * every hop, enforces a content-type whitelist and a byte cap, and returns either
 * SVG text or base64 raster bytes for the client to vectorize. Every rejection is
 * an ImportError carrying a generic, user-safe message.
 */

import { promises as dns } from "node:dns";

import { ImportError, assertPublicUrl } from "./ssrf";

export type ImportResult =
  | { kind: "svg"; svg: string }
  | { kind: "image"; contentType: string; dataBase64: string };

/** The slice of `fetch` this module uses (looser than `typeof fetch` for test stubs). */
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FetchImportDeps {
  /** Injectable fetch, defaulting to the global (for tests). */
  fetchImpl?: FetchLike;
  /** Resolve a hostname to its IPs, defaulting to a real DNS lookup. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Max response size in bytes (default 3 MB). */
  maxBytes?: number;
  /** Per-request timeout in ms (default 8000). */
  timeoutMs?: number;
  /** Max redirects to follow (default 4). */
  maxRedirects?: number;
}

/** Real DNS resolver: every A/AAAA record for the host. */
const defaultResolveHost = async (hostname: string): Promise<string[]> => {
  try {
    const records = await dns.lookup(hostname, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
};

/** Raster content types the client can vectorize. */
const RASTER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

/** Strip any charset/parameters from a Content-Type header. */
const baseType = (ct: string | null): string =>
  (ct ?? "").split(";")[0].trim().toLowerCase();

export async function fetchImport(
  rawUrl: string,
  deps: FetchImportDeps = {},
): Promise<ImportResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const maxBytes = deps.maxBytes ?? 3_000_000;
  const timeoutMs = deps.timeoutMs ?? 8000;
  const maxRedirects = deps.maxRedirects ?? 4;

  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    if (hop > maxRedirects)
      throw new ImportError("That URL redirected too many times.", 400);

    // Re-validate the target on every hop (initial URL and each redirect)
    const url = await assertPublicUrl(current, resolveHost);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "image/svg+xml,image/*" },
      });
    } catch {
      throw new ImportError("Could not fetch that URL.", 502);
    } finally {
      clearTimeout(timer);
    }

    // Manual redirect: validate the next hop before following it
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location)
        throw new ImportError("That URL returned an invalid redirect.", 502);
      current = new URL(location, url).toString();
      continue;
    }

    if (!response.ok)
      throw new ImportError("That URL could not be fetched.", 502);

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new ImportError("That file is too large to import.", 413);

    const type = baseType(response.headers.get("content-type"));
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes)
      throw new ImportError("That file is too large to import.", 413);

    const looksSvg =
      type === "image/svg+xml" ||
      ((type === "text/xml" ||
        type === "application/xml" ||
        type === "text/plain" ||
        type === "") &&
        /\.svg(\?|$)/i.test(url.pathname));
    if (looksSvg) return { kind: "svg", svg: new TextDecoder().decode(buf) };

    if (RASTER_TYPES.has(type))
      return {
        kind: "image",
        contentType: type,
        dataBase64: Buffer.from(buf).toString("base64"),
      };

    throw new ImportError(
      "That URL is not an SVG or image we can import.",
      415,
    );
  }
}
