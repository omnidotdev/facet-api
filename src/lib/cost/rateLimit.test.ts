import { describe, expect, test } from "bun:test";

import { createRateLimiter } from "./rateLimit";

describe("createRateLimiter", () => {
  test("allows up to max requests per IP within the window", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2 });
    expect(limiter.allow("1.1.1.1", 0)).toBe(true);
    expect(limiter.allow("1.1.1.1", 100)).toBe(true);
    expect(limiter.allow("1.1.1.1", 200)).toBe(false);
  });

  test("tracks each IP independently", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.allow("1.1.1.1", 0)).toBe(true);
    expect(limiter.allow("2.2.2.2", 0)).toBe(true);
    expect(limiter.allow("1.1.1.1", 0)).toBe(false);
  });

  test("frees capacity as the sliding window advances", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.allow("1.1.1.1", 0)).toBe(true);
    expect(limiter.allow("1.1.1.1", 500)).toBe(false);
    // once the first hit ages out of the window, a new request is allowed
    expect(limiter.allow("1.1.1.1", 1001)).toBe(true);
  });

  test("a non-positive max disables the limiter (always allows)", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 0 });
    expect(limiter.allow("1.1.1.1", 0)).toBe(true);
    expect(limiter.allow("1.1.1.1", 0)).toBe(true);
  });
});
