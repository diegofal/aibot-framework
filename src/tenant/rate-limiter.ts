/**
 * In-memory sliding window rate limiter.
 * Tracks request timestamps per key and enforces per-minute limits.
 */

export interface RateLimitConfig {
  /** Requests allowed per window */
  maxRequests: number;
  /** Window size in milliseconds (default 60_000 = 1 minute) */
  windowMs: number;
}

/** Per-plan rate limits (requests per minute) */
export const PLAN_RATE_LIMITS: Record<string, number> = {
  free: 20,
  starter: 60,
  pro: 200,
  enterprise: 500,
};

interface SlidingWindow {
  timestamps: number[];
}

export class RateLimiter {
  private windows: Map<string, SlidingWindow> = new Map();
  private defaultWindowMs: number;

  constructor(defaultWindowMs = 60_000) {
    this.defaultWindowMs = defaultWindowMs;
  }

  /**
   * Check if a request is allowed and consume a slot if so.
   * Returns { allowed, remaining, retryAfterMs }.
   */
  check(
    key: string,
    maxRequests: number,
    windowMs?: number
  ): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const now = Date.now();
    const window = windowMs ?? this.defaultWindowMs;

    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // Prune expired timestamps
    const cutoff = now - window;
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= maxRequests) {
      // Rate limited — compute when the oldest entry in window expires
      const oldest = entry.timestamps[0];
      const retryAfterMs = oldest + window - now;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, retryAfterMs),
      };
    }

    entry.timestamps.push(now);
    return {
      allowed: true,
      remaining: maxRequests - entry.timestamps.length,
      retryAfterMs: 0,
    };
  }

  /**
   * Get current count without consuming a slot.
   */
  peek(key: string, windowMs?: number): number {
    const now = Date.now();
    const window = windowMs ?? this.defaultWindowMs;
    const entry = this.windows.get(key);
    if (!entry) return 0;
    const cutoff = now - window;
    return entry.timestamps.filter((t) => t > cutoff).length;
  }

  /**
   * Reset rate limit state for a key.
   */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /**
   * Purge all expired entries to prevent memory leaks.
   * Call periodically (e.g. every 5 minutes).
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter((t) => t > now - this.defaultWindowMs);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }
}
