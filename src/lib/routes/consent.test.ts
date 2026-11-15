import { describe, expect, test } from "bun:test";

import { Elysia } from "elysia";

import { createConsentRoute } from "./consent";
import { AI_TRAINING_CONSENT_VERSION } from "./sampleStore";

type Events = NonNullable<Parameters<typeof createConsentRoute>[0]["events"]>;
type Authenticate = Parameters<typeof createConsentRoute>[0]["authenticate"];
type Store = Parameters<typeof createConsentRoute>[0]["store"];

/** An events stub that records every emitted event. */
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

/** A store stub that records each setConsent call. */
const makeStore = () => {
  const calls: { userId: string; consent: boolean }[] = [];
  const store: Store = {
    async setConsent(userId, consent) {
      calls.push({ userId, consent });
    },
  };
  return { store, calls };
};

interface Overrides {
  authenticate?: Authenticate;
  store?: Store;
  events?: Events;
}

const makeApp = (overrides: Overrides = {}) => {
  const app = new Elysia().use(
    createConsentRoute({
      authenticate:
        overrides.authenticate ?? (async () => ({ userId: "user-1" })),
      store: overrides.store ?? makeStore().store,
      events: overrides.events,
    }),
  );
  return (body: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request("http://test/consent", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
};

describe("POST /consent", () => {
  test("records a grant and returns the new state", async () => {
    const { store, calls } = makeStore();
    const res = await makeApp({ store })({ consent: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ consent: true });
    expect(calls).toEqual([{ userId: "user-1", consent: true }]);
  });

  test("records a withdrawal", async () => {
    const { store, calls } = makeStore();
    const res = await makeApp({ store })({ consent: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ consent: false });
    expect(calls).toEqual([{ userId: "user-1", consent: false }]);
  });

  test("emits an immutable consent-change audit event with the user, state, and terms version", async () => {
    const { events, emitted } = makeEvents();
    await makeApp({ events })({ consent: true });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "facet.user.consent_changed",
      subject: "user-1",
      data: {
        userId: "user-1",
        consent: true,
        version: AI_TRAINING_CONSENT_VERSION,
      },
    });
  });

  test("rejects a non-boolean consent value without touching the store", async () => {
    const { store, calls } = makeStore();
    const res = await makeApp({ store })({ consent: "yes" });

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("rejects an unauthenticated request, recording nothing", async () => {
    const { store, calls } = makeStore();
    const { events, emitted } = makeEvents();
    const res = await makeApp({
      authenticate: async () => null,
      store,
      events,
    })({ consent: true });

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  test("a store failure is a 500 and emits no audit event", async () => {
    const { events, emitted } = makeEvents();
    const failing: Store = {
      async setConsent() {
        throw new Error("db down");
      },
    };
    const res = await makeApp({ store: failing, events })({ consent: true });

    expect(res.status).toBe(500);
    expect(emitted).toHaveLength(0);
  });

  test("an audit-sink failure never fails the toggle (the choice is already persisted)", async () => {
    const { store, calls } = makeStore();
    const events: Events = {
      async emit() {
        throw new Error("bus down");
      },
    };
    const res = await makeApp({ store, events })({ consent: true });

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ userId: "user-1", consent: true }]);
  });
});
