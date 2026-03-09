import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { createRateLimitMiddleware } from '../src/tenant/rate-limit-middleware';

// Mock implementations
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as any;

describe('Rate limit middleware tenant key', () => {
  it('reads tenantId from c.get("tenant").tenantId', async () => {
    const checkCalls: string[] = [];
    const mockRateLimiter = {
      check: (key: string, max: number) => {
        checkCalls.push(key);
        return { allowed: true, remaining: max - 1, retryAfterMs: 0 };
      },
    };
    const mockTenantManager = {
      getTenant: (id: string) => ({ id, plan: 'pro' }),
    };

    const middleware = createRateLimitMiddleware(
      mockRateLimiter as any,
      mockTenantManager as any,
      noopLogger
    );

    const app = new Hono();
    // Simulate auth middleware setting tenant context
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: 'tenant-123', apiKey: 'key', plan: 'pro' });
      return next();
    });
    app.use('*', middleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(checkCalls).toEqual(['tenant:tenant-123']);
  });

  it('skips rate limiting when no tenant context (single-tenant mode)', async () => {
    const checkCalls: string[] = [];
    const mockRateLimiter = {
      check: (key: string, max: number) => {
        checkCalls.push(key);
        return { allowed: true, remaining: max - 1, retryAfterMs: 0 };
      },
    };
    const mockTenantManager = {
      getTenant: () => undefined,
    };

    const middleware = createRateLimitMiddleware(
      mockRateLimiter as any,
      mockTenantManager as any,
      noopLogger
    );

    const app = new Hono();
    app.use('*', middleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    // Should not have called check at all
    expect(checkCalls).toHaveLength(0);
  });

  it('returns 429 when rate limit exceeded', async () => {
    const mockRateLimiter = {
      check: () => ({ allowed: false, remaining: 0, retryAfterMs: 5000 }),
    };
    const mockTenantManager = {
      getTenant: (id: string) => ({ id, plan: 'free' }),
    };

    const middleware = createRateLimitMiddleware(
      mockRateLimiter as any,
      mockTenantManager as any,
      noopLogger
    );

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: 'tenant-456', apiKey: 'key', plan: 'free' });
      return next();
    });
    app.use('*', middleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.error).toBe('Too Many Requests');
  });
});
