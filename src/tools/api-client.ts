/**
 * Shared API client utilities for external service integrations.
 * Provides authenticated fetch with timeout/error handling and token-bucket rate limiting.
 */

export interface ApiRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/**
 * Authenticated fetch with timeout, JSON parsing, and structured errors.
 */
export async function apiRequest<T>(
  url: string,
  opts: ApiRequestOptions = {}
): Promise<ApiResult<T>> {
  const { method = 'GET', headers = {}, body, timeout = 30_000 } = opts;

  const fetchOpts: RequestInit = {
    method,
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(timeout),
  };

  if (body !== undefined) {
    fetchOpts.body = JSON.stringify(body);
    (fetchOpts.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, fetchOpts);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return {
      ok: false,
      status: response.status,
      message: text.slice(0, 500) || response.statusText,
    };
  }

  const data = (await response.json()) as T;
  return { ok: true, data };
}

/**
 * Token-bucket rate limiter. Blocks callers until a token is available.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private maxRequests: number,
    private windowMs: number
  ) {
    this.tokens = maxRequests;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    // Wait until next refill adds at least one token
    const elapsed = Date.now() - this.lastRefill;
    const waitMs = this.windowMs - elapsed;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.refill();
    this.tokens--;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;

    if (elapsed >= this.windowMs) {
      this.tokens = this.maxRequests;
      this.lastRefill = now;
    }
  }
}
