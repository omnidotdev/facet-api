import { describe, expect, test } from "bun:test";

import { createSpendBreaker } from "@omnidotdev/providers";

import { recordFreeSpend } from "./managedAccess";

type Grant = Parameters<typeof recordFreeSpend>[1];

const grant = (isPayingCustomer: boolean): Grant => ({
  ok: true,
  userId: "user-1",
  workspaceId: "ws-user-1",
  apiKey: "sk-scoped-user-1",
  isPayingCustomer,
});

describe("recordFreeSpend (the belt-and-braces breaker)", () => {
  test("records a non-paying grant's real spend", async () => {
    const breaker = createSpendBreaker(500);
    await recordFreeSpend(breaker, grant(false), 3, () => {});
    expect(await breaker.spentTodayCents()).toBe(3);
  });

  test("never records a paying customer's spend", async () => {
    const breaker = createSpendBreaker(500);
    await recordFreeSpend(breaker, grant(true), 3, () => {});
    expect(await breaker.spentTodayCents()).toBe(0);
  });

  test("a breaker write failure is logged, never raised", async () => {
    const logged: string[] = [];
    await recordFreeSpend(
      {
        isTripped: async () => false,
        spentTodayCents: async () => 0,
        record: async () => {
          throw new Error("db down");
        },
      },
      grant(false),
      3,
      (reason) => logged.push(reason),
    );
    expect(logged).toEqual(["breaker record failed: db down"]);
  });
});
