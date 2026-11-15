import { describe, expect, test } from "bun:test";

import { applyConsentChange } from "./consentConsumer";

import type { SampleStore } from "lib/routes/sampleStore";

/** A store stub that records each setConsent call. */
const makeStore = () => {
  const calls: { userId: string; consent: boolean; version?: string }[] = [];
  const store: Pick<SampleStore, "setConsent"> = {
    async setConsent(userId, consent, version) {
      calls.push({ userId, consent, version });
    },
  };
  return { store, calls };
};

describe("applyConsentChange", () => {
  test("applies an ai_training grant to the local projection", async () => {
    const { store, calls } = makeStore();
    const result = await applyConsentChange({
      store,
      payload: {
        subject: "user-1",
        purposeKey: "ai_training",
        granted: true,
        policyVersion: "2026-11-14",
      },
    });

    expect(result).toEqual({ outcome: "applied", granted: true });
    expect(calls).toEqual([
      { userId: "user-1", consent: true, version: "2026-11-14" },
    ]);
  });

  test("applies a withdrawal (which erases the user's samples)", async () => {
    const { store, calls } = makeStore();
    const result = await applyConsentChange({
      store,
      payload: {
        subject: "user-1",
        purposeKey: "ai_training",
        granted: false,
        policyVersion: "2026-11-14",
      },
    });

    expect(result).toEqual({ outcome: "applied", granted: false });
    expect(calls).toEqual([
      { userId: "user-1", consent: false, version: "2026-11-14" },
    ]);
  });

  test("ignores a purpose that is not ai_training, touching nothing", async () => {
    const { store, calls } = makeStore();
    const result = await applyConsentChange({
      store,
      payload: {
        subject: "user-1",
        purposeKey: "marketing_email",
        granted: true,
      },
    });

    expect(result.outcome).toBe("ignored");
    expect(calls).toHaveLength(0);
  });

  test("ignores an event missing a subject", async () => {
    const { store, calls } = makeStore();
    const result = await applyConsentChange({
      store,
      payload: { purposeKey: "ai_training", granted: true },
    });

    expect(result.outcome).toBe("ignored");
    expect(calls).toHaveLength(0);
  });

  test("ignores an event missing the granted flag", async () => {
    const { store, calls } = makeStore();
    const result = await applyConsentChange({
      store,
      payload: { subject: "user-1", purposeKey: "ai_training" },
    });

    expect(result.outcome).toBe("ignored");
    expect(calls).toHaveLength(0);
  });

  test("propagates a store failure so the caller can ask for redelivery", async () => {
    const store: Pick<SampleStore, "setConsent"> = {
      async setConsent() {
        throw new Error("db down");
      },
    };

    await expect(
      applyConsentChange({
        store,
        payload: {
          subject: "user-1",
          purposeKey: "ai_training",
          granted: false,
        },
      }),
    ).rejects.toThrow("db down");
  });
});
