import { describe, expect, test } from "bun:test";

import { Elysia } from "elysia";

import { createRateLimiter } from "lib/cost/rateLimit";
import { createDispositionRoute } from "./disposition";

import type { RateLimiter } from "lib/cost/rateLimit";

type Events = NonNullable<
  Parameters<typeof createDispositionRoute>[0]["events"]
>;
type Authenticate = NonNullable<
  Parameters<typeof createDispositionRoute>[0]["authenticate"]
>;

interface Overrides {
  rateLimiter?: RateLimiter;
  authenticate?: Authenticate;
  events?: Events;
}

/** Build an events stub that records every emitted event. */
const makeEvents = () => {
  const emitted: {
    type: string;
    data: Record<string, unknown>;
    subject?: string;
    correlationId?: string;
  }[] = [];
  const events: Events = {
    async emit(event) {
      emitted.push(event);
      return undefined;
    },
  };
  return { events, emitted };
};

const makeApp = (overrides: Overrides = {}) => {
  const app = new Elysia().use(
    createDispositionRoute({
      rateLimiter:
        overrides.rateLimiter ??
        createRateLimiter({ windowMs: 60_000, max: 100 }),
      authenticate:
        overrides.authenticate ?? (async () => ({ userId: "user-1" })),
      events: overrides.events,
    }),
  );
  return (body: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request("http://test/disposition", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
};

describe("POST /disposition", () => {
  test("emits facet.generation.kept correlated to the generation, with the user", async () => {
    const { events, emitted } = makeEvents();
    const res = await makeApp({ events })({
      generationId: "gen-1",
      disposition: "kept",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    await Promise.resolve();
    expect(emitted).toHaveLength(1);
    const event = emitted[0]!;
    expect(event.type).toBe("facet.generation.kept");
    expect(event.correlationId).toBe("gen-1");
    expect(event.subject).toBe("user-1");
    expect(event.data).toEqual({ userId: "user-1" });
  });

  test("records a disposition for a BYOK (signed-out) user without a subject", async () => {
    const { events, emitted } = makeEvents();
    const res = await makeApp({ events, authenticate: async () => null })({
      generationId: "gen-2",
      disposition: "discarded",
    });

    expect(res.status).toBe(200);
    await Promise.resolve();
    expect(emitted[0]!.type).toBe("facet.generation.discarded");
    expect(emitted[0]!.subject).toBeUndefined();
    expect(emitted[0]!.data).toEqual({ userId: null });
  });

  test("records a disposition even when identity resolution throws", async () => {
    const { events, emitted } = makeEvents();
    const res = await makeApp({
      events,
      authenticate: async () => {
        throw new Error("auth service down");
      },
    })({ generationId: "gen-3", disposition: "regenerated" });

    expect(res.status).toBe(200);
    await Promise.resolve();
    expect(emitted[0]!.type).toBe("facet.generation.regenerated");
    expect(emitted[0]!.data).toEqual({ userId: null });
  });

  test("400 on an unknown disposition", async () => {
    const { events, emitted } = makeEvents();
    const res = await makeApp({ events })({
      generationId: "gen-4",
      disposition: "loved-it",
    });

    expect(res.status).toBe(400);
    await Promise.resolve();
    expect(emitted).toHaveLength(0);
  });

  test("400 when the generation id is missing", async () => {
    const res = await makeApp()({ disposition: "kept" });
    expect(res.status).toBe(400);
  });

  test("429 when the per-IP rate limit is exceeded", async () => {
    const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    const request = makeApp({ rateLimiter });
    const headers = { "x-forwarded-for": "9.9.9.9" };
    const body = { generationId: "gen-5", disposition: "kept" };

    expect((await request(body, headers)).status).toBe(200);
    expect((await request(body, headers)).status).toBe(429);
  });

  test("the response never carries a prompt, code, or key", async () => {
    const res = await makeApp()({ generationId: "gen-6", disposition: "kept" });
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ ok: true }));
  });
});
