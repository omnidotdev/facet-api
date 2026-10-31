/**
 * Sliding-window per-IP rate limiter.
 *
 * Keeps request timestamps per IP and allows a request only when fewer than
 * `max` hits fall inside the trailing `windowMs`. In-memory for Phase A.
 *
 * TODO Phase C: add a per-user dimension and back this with a shared store so
 * the limit holds across instances
 */

export interface RateLimiter {
  /** Test and, when allowed, record a hit for this IP. Returns whether it is allowed. */
  allow(ip: string, nowMs?: number): boolean;
}

interface RateLimitOptions {
  windowMs: number;
  max: number;
}

/**
 * Create an in-memory sliding-window limiter. A non-positive `max` disables
 * limiting (every request is allowed)
 */
export const createRateLimiter = (opts: RateLimitOptions): RateLimiter => {
  const hits = new Map<string, number[]>();
  const now = () => Date.now();

  return {
    allow(ip, nowMs = now()) {
      if (opts.max <= 0) return true;

      const cutoff = nowMs - opts.windowMs;
      const recent = (hits.get(ip) ?? []).filter((t) => t > cutoff);

      if (recent.length >= opts.max) {
        hits.set(ip, recent);
        return false;
      }

      recent.push(nowMs);
      hits.set(ip, recent);
      return true;
    },
  };
};
