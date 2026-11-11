import { describe, expect, test } from "bun:test";

import { fetchImport } from "./fetchImport";
import { ImportError } from "./ssrf";

const publicResolver = async () => ["93.184.216.34"];

const res = (
  body: string | Uint8Array,
  init: { status?: number; headers?: Record<string, string> } = {},
) =>
  new Response(body as BodyInit, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });

describe("fetchImport", () => {
  test("returns SVG text for an image/svg+xml response", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L1 0 L1 1 Z"/></svg>`;
    const result = await fetchImport("https://example.com/icon.svg", {
      resolveHost: publicResolver,
      fetchImpl: async () =>
        res(svg, { headers: { "content-type": "image/svg+xml" } }),
    });
    expect(result).toEqual({ kind: "svg", svg });
  });

  test("returns base64 image data for a raster response", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const result = await fetchImport("https://example.com/logo.png", {
      resolveHost: publicResolver,
      fetchImpl: async () =>
        res(bytes, { headers: { "content-type": "image/png" } }),
    });
    expect(result.kind).toBe("image");
    if (result.kind === "image") {
      expect(result.contentType).toBe("image/png");
      expect(Buffer.from(result.dataBase64, "base64")).toEqual(
        Buffer.from(bytes),
      );
    }
  });

  test("rejects a disallowed content type (e.g. text/html)", async () => {
    await expect(
      fetchImport("https://example.com/page", {
        resolveHost: publicResolver,
        fetchImpl: async () =>
          res("<html></html>", { headers: { "content-type": "text/html" } }),
      }),
    ).rejects.toBeInstanceOf(ImportError);
  });

  test("rejects when Content-Length exceeds the cap", async () => {
    await expect(
      fetchImport("https://example.com/huge.png", {
        resolveHost: publicResolver,
        maxBytes: 100,
        fetchImpl: async () =>
          res(new Uint8Array(10), {
            headers: { "content-type": "image/png", "content-length": "99999" },
          }),
      }),
    ).rejects.toBeInstanceOf(ImportError);
  });

  test("rejects when the body is larger than the cap (no Content-Length)", async () => {
    await expect(
      fetchImport("https://example.com/huge.svg", {
        resolveHost: publicResolver,
        maxBytes: 8,
        fetchImpl: async () =>
          res("x".repeat(64), { headers: { "content-type": "image/svg+xml" } }),
      }),
    ).rejects.toBeInstanceOf(ImportError);
  });

  test("blocks a non-public target before fetching", async () => {
    let fetched = false;
    await expect(
      fetchImport("http://169.254.169.254/latest/meta-data", {
        resolveHost: publicResolver,
        fetchImpl: async () => {
          fetched = true;
          return res("secret");
        },
      }),
    ).rejects.toBeInstanceOf(ImportError);
    expect(fetched).toBe(false);
  });

  test("follows a redirect but re-validates the hop (blocks redirect to internal)", async () => {
    await expect(
      fetchImport("https://example.com/icon.svg", {
        resolveHost: publicResolver,
        fetchImpl: async () =>
          res("", {
            status: 302,
            headers: { location: "http://169.254.169.254/" },
          }),
      }),
    ).rejects.toBeInstanceOf(ImportError);
  });

  test("follows a redirect to a public SVG and returns it", async () => {
    const svg = `<svg><rect x="0" y="0" width="2" height="2"/></svg>`;
    let hop = 0;
    const result = await fetchImport("https://example.com/start", {
      resolveHost: publicResolver,
      fetchImpl: async (input) => {
        hop += 1;
        if (hop === 1)
          return res("", {
            status: 301,
            headers: { location: "https://cdn.example.com/icon.svg" },
          });
        expect(String(input)).toContain("cdn.example.com");
        return res(svg, { headers: { "content-type": "image/svg+xml" } });
      },
    });
    expect(result).toEqual({ kind: "svg", svg });
  });

  test("stops after too many redirects", async () => {
    await expect(
      fetchImport("https://example.com/loop", {
        resolveHost: publicResolver,
        maxRedirects: 2,
        fetchImpl: async () =>
          res("", {
            status: 302,
            headers: { location: "https://example.com/loop" },
          }),
      }),
    ).rejects.toBeInstanceOf(ImportError);
  });
});
