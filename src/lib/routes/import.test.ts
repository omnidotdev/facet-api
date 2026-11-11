import { describe, expect, test } from "bun:test";

import { ImportError } from "lib/import/ssrf";
import { createImportRoute } from "./import";

import type { ImportResult } from "lib/import/fetchImport";

const allowAll = { allow: () => true };
const denyAll = { allow: () => false };
const signedIn = async () => ({ userId: "u1" });
const signedOut = async () => null;

const call = (
  overrides: {
    rateLimiter?: { allow: () => boolean };
    authenticate?: () => Promise<{ userId: string } | null>;
    fetchImport?: (url: string) => Promise<ImportResult>;
  } = {},
) => {
  const app = createImportRoute({
    rateLimiter: overrides.rateLimiter ?? allowAll,
    authenticate: overrides.authenticate ?? signedIn,
    fetchImport:
      overrides.fetchImport ??
      (async () => ({ kind: "svg", svg: "<svg></svg>" })),
  });
  return (body: unknown) =>
    app.handle(
      new Request("http://test/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
};

describe("POST /import", () => {
  test("returns the imported SVG for a signed-in user", async () => {
    const res = await call({
      fetchImport: async () => ({ kind: "svg", svg: "<svg>ok</svg>" }),
    })({ url: "https://example.com/icon.svg" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "svg", svg: "<svg>ok</svg>" });
  });

  test("rejects a missing URL with 400", async () => {
    const res = await call()({});
    expect(res.status).toBe(400);
  });

  test("rate-limits with 429", async () => {
    const res = await call({ rateLimiter: denyAll })({
      url: "https://example.com/icon.svg",
    });
    expect(res.status).toBe(429);
  });

  test("requires sign-in (401)", async () => {
    const res = await call({ authenticate: signedOut })({
      url: "https://example.com/icon.svg",
    });
    expect(res.status).toBe(401);
  });

  test("maps an ImportError to its status and message", async () => {
    const res = await call({
      fetchImport: async () => {
        throw new ImportError("That host is not allowed.", 403);
      },
    })({ url: "http://169.254.169.254/" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "That host is not allowed." });
  });

  test("never leaks a non-ImportError detail (generic 502)", async () => {
    const res = await call({
      fetchImport: async () => {
        throw new Error("ECONNREFUSED 10.0.0.5 internal stack trace");
      },
    })({ url: "https://example.com/icon.svg" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|stack/);
  });
});
