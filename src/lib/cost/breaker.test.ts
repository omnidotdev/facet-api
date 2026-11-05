import { describe, expect, test } from "bun:test";

import { createSpendBreaker } from "./breaker";

const DAY_ONE = Date.UTC(2026, 9, 31, 12, 0, 0);
const DAY_TWO = Date.UTC(2026, 10, 1, 0, 30, 0);

describe("createSpendBreaker", () => {
  test("starts untripped", async () => {
    const breaker = createSpendBreaker(500);
    expect(await breaker.isTripped(DAY_ONE)).toBe(false);
    expect(await breaker.spentTodayCents(DAY_ONE)).toBe(0);
  });

  test("stays untripped below the ceiling and trips at or above it", async () => {
    const breaker = createSpendBreaker(100);
    await breaker.record(60, DAY_ONE);
    expect(await breaker.isTripped(DAY_ONE)).toBe(false);
    await breaker.record(40, DAY_ONE);
    expect(await breaker.isTripped(DAY_ONE)).toBe(true);
    expect(await breaker.spentTodayCents(DAY_ONE)).toBe(100);
  });

  test("resets spend when the UTC day rolls over", async () => {
    const breaker = createSpendBreaker(100);
    await breaker.record(100, DAY_ONE);
    expect(await breaker.isTripped(DAY_ONE)).toBe(true);
    // next UTC day: spend window resets
    expect(await breaker.spentTodayCents(DAY_TWO)).toBe(0);
    expect(await breaker.isTripped(DAY_TWO)).toBe(false);
  });

  test("a non-positive ceiling is never tripped (breaker disabled)", async () => {
    const breaker = createSpendBreaker(0);
    await breaker.record(9999, DAY_ONE);
    expect(await breaker.isTripped(DAY_ONE)).toBe(false);
  });
});
