import { beforeEach, describe, expect, it } from 'bun:test';
import { PLAN_RATE_LIMITS, RateLimiter } from '../src/tenant/rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(60_000);
  });

  it('allows requests under the limit', () => {
    const result = limiter.check('key1', 5);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.retryAfterMs).toBe(0);
  });

  it('tracks remaining count accurately', () => {
    limiter.check('key1', 3); // 1 of 3
    limiter.check('key1', 3); // 2 of 3
    limiter.check('key1', 3); // 3 of 3
    // 4th request should be blocked
    const result = limiter.check('key1', 3);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('blocks requests at the limit', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('key1', 5);
    }
    const result = limiter.check('key1', 5);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('isolates keys', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('key1', 5);
    }
    const result = limiter.check('key2', 5);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('peek does not consume a slot', () => {
    limiter.check('key1', 5);
    const count = limiter.peek('key1');
    expect(count).toBe(1);
    const result = limiter.check('key1', 5);
    expect(result.remaining).toBe(3); // 5 - 2 = 3
  });

  it('peek returns 0 for unknown key', () => {
    expect(limiter.peek('unknown')).toBe(0);
  });

  it('reset clears state for a key', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('key1', 5);
    }
    limiter.reset('key1');
    const result = limiter.check('key1', 5);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('cleanup removes empty entries', () => {
    limiter.check('key1', 5);
    limiter.reset('key1');
    limiter.cleanup();
    // After cleanup, peek should be 0 (entry removed)
    expect(limiter.peek('key1')).toBe(0);
  });

  it('uses a short window for fast expiry', () => {
    const fastLimiter = new RateLimiter(10); // 10ms window
    fastLimiter.check('key1', 1);
    // Request should be blocked immediately
    let result = fastLimiter.check('key1', 1);
    expect(result.allowed).toBe(false);

    // Wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 15) {
      // busy wait
    }
    result = fastLimiter.check('key1', 1);
    expect(result.allowed).toBe(true);
  });
});

describe('PLAN_RATE_LIMITS', () => {
  it('defines limits for all plans', () => {
    expect(PLAN_RATE_LIMITS.free).toBe(30);
    expect(PLAN_RATE_LIMITS.starter).toBe(60);
    expect(PLAN_RATE_LIMITS.pro).toBe(200);
    expect(PLAN_RATE_LIMITS.enterprise).toBe(500);
  });

  it('free has the lowest limit', () => {
    const values = Object.values(PLAN_RATE_LIMITS);
    expect(Math.min(...values)).toBe(PLAN_RATE_LIMITS.free);
  });
});
