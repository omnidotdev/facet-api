import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { handleConsentDelivery } from "./consentWebhook";

import type { ConsentChangeResult } from "./consentConsumer";

const SECRET = "test-secret";

const sign = (body: string) =>
  createHmac("sha256", SECRET).update(body).digest("hex");

const envelope = (data: Record<string, unknown>) =>
  JSON.stringify({
    type: "platform.consent.changed",
    source: "omni.platform",
    data,
  });

/** Records what apply received, returning an "applied" result. */
const makeApply = () => {
  const seen: Record<string, unknown>[] = [];
  const apply = async (
    payload: Record<string, unknown>,
  ): Promise<ConsentChangeResult> => {
    seen.push(payload);
    return { outcome: "applied", granted: Boolean(payload.granted) };
  };
  return { apply, seen };
};

describe("handleConsentDelivery", () => {
  test("verifies the signature and applies the event's data payload", async () => {
    const { apply, seen } = makeApply();
    const body = envelope({
      subject: "user-1",
      purposeKey: "ai_training",
      granted: false,
    });

    const result = await handleConsentDelivery({
      rawBody: body,
      signature: sign(body),
      secret: SECRET,
      apply,
    });

    expect(result.status).toBe(200);
    expect(seen).toEqual([
      { subject: "user-1", purposeKey: "ai_training", granted: false },
    ]);
  });

  test("refuses when no signing secret is configured, without applying", async () => {
    const { apply, seen } = makeApply();
    const body = envelope({ subject: "user-1" });

    const result = await handleConsentDelivery({
      rawBody: body,
      signature: sign(body),
      secret: undefined,
      apply,
    });

    expect(result.status).toBe(503);
    expect(seen).toHaveLength(0);
  });

  test("rejects a missing signature", async () => {
    const { apply, seen } = makeApply();
    const result = await handleConsentDelivery({
      rawBody: envelope({ subject: "user-1" }),
      signature: undefined,
      secret: SECRET,
      apply,
    });

    expect(result.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("rejects an invalid signature, never applying", async () => {
    const { apply, seen } = makeApply();
    const body = envelope({ subject: "user-1", purposeKey: "ai_training" });

    const result = await handleConsentDelivery({
      rawBody: body,
      signature: sign(`${body}tampered`),
      secret: SECRET,
      apply,
    });

    expect(result.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("drops an authentic non-consent event with 200", async () => {
    const { apply, seen } = makeApply();
    const body = JSON.stringify({
      type: "platform.user.created",
      data: { subject: "user-1" },
    });

    const result = await handleConsentDelivery({
      rawBody: body,
      signature: sign(body),
      secret: SECRET,
      apply,
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe("Ignored");
    expect(seen).toHaveLength(0);
  });

  test("drops a malformed authentic body with 200 (a retry cannot help)", async () => {
    const { apply, seen } = makeApply();
    const body = "not json";

    const result = await handleConsentDelivery({
      rawBody: body,
      signature: sign(body),
      secret: SECRET,
      apply,
    });

    expect(result.status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  test("returns 500 when apply throws, so Vortex redelivers", async () => {
    const body = envelope({
      subject: "user-1",
      purposeKey: "ai_training",
      granted: false,
    });

    const result = await handleConsentDelivery({
      rawBody: body,
      signature: sign(body),
      secret: SECRET,
      apply: async () => {
        throw new Error("db down");
      },
    });

    expect(result.status).toBe(500);
  });
});
