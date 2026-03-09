import { beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createRateLimitMiddleware } from '../src/tenant/rate-limit-middleware';
import { PLAN_RATE_LIMITS } from '../src/tenant/rate-limiter';
import { tenantRoutes } from '../src/web/routes/tenants';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as any;

describe('Rate limit override — middleware', () => {
  it('uses rateLimitOverride when set on tenant', async () => {
    const checkCalls: { key: string; max: number }[] = [];
    const mockRateLimiter = {
      check: (key: string, max: number) => {
        checkCalls.push({ key, max });
        return { allowed: true, remaining: max - 1, retryAfterMs: 0 };
      },
    };
    const mockTenantManager = {
      getTenant: (id: string) => ({ id, plan: 'free', rateLimitOverride: 100 }),
    };

    const middleware = createRateLimitMiddleware(
      mockRateLimiter as any,
      mockTenantManager as any,
      noopLogger
    );

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: 'tenant-override' });
      return next();
    });
    app.use('*', middleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(checkCalls[0].max).toBe(100);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100');
  });

  it('falls back to plan default when no override', async () => {
    const checkCalls: { key: string; max: number }[] = [];
    const mockRateLimiter = {
      check: (key: string, max: number) => {
        checkCalls.push({ key, max });
        return { allowed: true, remaining: max - 1, retryAfterMs: 0 };
      },
    };
    const mockTenantManager = {
      getTenant: (id: string) => ({ id, plan: 'starter' }),
    };

    const middleware = createRateLimitMiddleware(
      mockRateLimiter as any,
      mockTenantManager as any,
      noopLogger
    );

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: 'tenant-nooverride' });
      return next();
    });
    app.use('*', middleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(checkCalls[0].max).toBe(PLAN_RATE_LIMITS.starter);
    expect(res.headers.get('X-RateLimit-Limit')).toBe(String(PLAN_RATE_LIMITS.starter));
  });
});

describe('Rate limit override — admin endpoint', () => {
  let app: Hono;
  let tenants: Map<string, any>;

  beforeEach(() => {
    tenants = new Map();
    tenants.set('t1', {
      id: 't1',
      name: 'Test Tenant',
      email: 'test@test.com',
      plan: 'free',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      usageQuota: {
        messagesPerMonth: 500,
        apiCallsPerMonth: 1000,
        storageBytes: 100 * 1024 * 1024,
      },
    });

    const mockTenantManager = {
      getTenant: (id: string) => tenants.get(id),
      updateTenant: (id: string, updates: any) => {
        const tenant = tenants.get(id);
        if (!tenant) return undefined;
        Object.assign(tenant, updates, { updatedAt: new Date().toISOString() });
        // Simulate clearing undefined fields from JSON serialization
        if (updates.rateLimitOverride === undefined) {
          tenant.rateLimitOverride = undefined;
        }
        return tenant;
      },
      listTenants: () => Array.from(tenants.values()),
      getCurrentMonthUsage: () => ({ messages: 0, apiCalls: 0, storage: 0 }),
    };

    const routes = tenantRoutes({
      tenantManager: mockTenantManager as any,
      botManager: {} as any,
      config: {} as any,
      logger: noopLogger,
    });

    app = new Hono();
    app.route('/tenants', routes);
  });

  it('PATCH /:id/rate-limit sets override', async () => {
    const res = await app.request('/tenants/t1/rate-limit', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxRequestsPerMinute: 200 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.tenant.rateLimitOverride).toBe(200);
    expect(body.tenant.effectiveRateLimit).toBe(200);
    expect(tenants.get('t1').rateLimitOverride).toBe(200);
  });

  it('PATCH /:id/rate-limit with null clears override', async () => {
    // First set an override
    tenants.get('t1').rateLimitOverride = 150;

    const res = await app.request('/tenants/t1/rate-limit', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxRequestsPerMinute: null }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.tenant.rateLimitOverride).toBeNull();
    expect(body.tenant.effectiveRateLimit).toBe(PLAN_RATE_LIMITS.free);
  });

  it('rejects non-positive numbers', async () => {
    for (const bad of [0, -5, 3.14, 'abc']) {
      const res = await app.request('/tenants/t1/rate-limit', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxRequestsPerMinute: bad }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('returns 404 for unknown tenant', async () => {
    const res = await app.request('/tenants/unknown/rate-limit', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxRequestsPerMinute: 100 }),
    });
    expect(res.status).toBe(404);
  });

  it('GET /:id includes rate limit info', async () => {
    tenants.get('t1').rateLimitOverride = 75;

    const res = await app.request('/tenants/t1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.tenant.rateLimitOverride).toBe(75);
    expect(body.tenant.effectiveRateLimit).toBe(75);
  });

  it('GET /:id shows plan default when no override', async () => {
    const res = await app.request('/tenants/t1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.tenant.rateLimitOverride).toBeNull();
    expect(body.tenant.effectiveRateLimit).toBe(PLAN_RATE_LIMITS.free);
  });
});
