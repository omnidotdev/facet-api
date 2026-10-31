import { describe, expect, test } from "bun:test";

import { createSpendBreaker } from "./breaker";

const DAY_ONE = Date.UTC(2026, 9, 31, 12, 0, 0);
const DAY_TWO = Date.UTC(2026, 10, 1, 0, 30, 0);

describe("createSpendBreaker", () => {
  test("starts untripped", () => {
    const breaker = createSpendBreaker(500);
    expect(breaker.isTripped(DAY_ONE)).toBe(false);
    expect(breaker.spentTodayCents(DAY_ONE)).toBe(0);
  });

  test("stays untripped below the ceiling and trips at or above it", () => {
    const breaker = createSpendBreaker(100);
    breaker.record(60, DAY_ONE);
    expect(breaker.isTripped(DAY_ONE)).toBe(false);
    breaker.record(40, DAY_ONE);
    expect(breaker.isTripped(DAY_ONE)).toBe(true);
    expect(breaker.spentTodayCents(DAY_ONE)).toBe(100);
  });

  test("resets spend when the UTC day rolls over", () => {
    const breaker = createSpendBreaker(100);
    breaker.record(100, DAY_ONE);
    expect(breaker.isTripped(DAY_ONE)).toBe(true);
    // next UTC day: spend window resets
    expect(breaker.spentTodayCents(DAY_TWO)).toBe(0);
    expect(breaker.isTripped(DAY_TWO)).toBe(false);
  });

  test("a non-positive ceiling is never tripped (breaker disabled)", () => {
    const breaker = createSpendBreaker(0);
    breaker.record(9999, DAY_ONE);
    expect(breaker.isTripped(DAY_ONE)).toBe(false);
  });
});
