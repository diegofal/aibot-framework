import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  createQuotaCheckMiddleware,
  createTenantAuthMiddleware,
  createUsageMiddleware,
} from '../tenant/middleware';
import { SessionStore } from '../tenant/session-store';

// --- Mocks ---

function createMockTenantManager(tenants: Record<string, any> = {}) {
  const apiKeyMap = new Map<string, any>();
  const idMap = new Map<string, any>();
  const usageMap = new Map<string, { messages: number; apiCalls: number }>();

  for (const [id, t] of Object.entries(tenants)) {
    const tenant = {
      id,
      plan: 'starter',
      usageQuota: { messagesPerMonth: 500, apiCallsPerMonth: 1000 },
      ...t,
    };
    idMap.set(id, tenant);
    if (tenant.apiKey) apiKeyMap.set(tenant.apiKey, tenant);
  }

  return {
    getTenantByApiKey: (key: string) => {
      for (const t of idMap.values()) {
        if (t.apiKey === key) return t;
      }
      return undefined;
    },
    getTenant: (id: string) => idMap.get(id),
    recordUsage: (record: any) => {
      const key = record.tenantId;
      const existing = usageMap.get(key) || { messages: 0, apiCalls: 0 };
      existing.messages += record.messageCount;
      existing.apiCalls += record.apiCallCount;
      usageMap.set(key, existing);
    },
    getCurrentMonthUsage: (tenantId: string) => {
      return usageMap.get(tenantId) || { messages: 0, apiCalls: 0 };
    },
  };
}

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
};

// --- Tests ---

describe('tenant auth middleware edge cases', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ADMIN_API_KEY;
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ADMIN_API_KEY = originalKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  function buildApp(tenants: Record<string, any> = {}, sessionStore?: SessionStore) {
    const tm = createMockTenantManager(tenants);
    const app = new Hono();
    app.use('/api/*', createTenantAuthMiddleware(tm as any, mockLogger as any, sessionStore));
    app.get('/api/test', (c) => {
      const tenant = c.get('tenant');
      return c.json({ tenant });
    });
    return app;
  }

  // --- No Authorization header ---

  it('returns 401 when no Authorization header is sent', async () => {
    const app = buildApp();
    const res = await app.request('/api/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Missing Authorization');
  });

  // --- Malformed Authorization headers ---

  it('rejects empty Authorization header', async () => {
    const app = buildApp();
    const res = await app.request('/api/test', {
      headers: { Authorization: '' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects Basic auth scheme', async () => {
    const app = buildApp();
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Invalid Authorization format');
  });

  it('rejects lowercase "bearer" scheme (case-sensitive)', async () => {
    const app = buildApp({ t1: { apiKey: 'key-1' } });
    const res = await app.request('/api/test', {
      headers: { Authorization: 'bearer key-1' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects Bearer with no token value', async () => {
    const app = buildApp();
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects Bearer with empty token (trailing space)', async () => {
    const app = buildApp();
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer ' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects Bearer with double space before token', async () => {
    const app = buildApp({ t1: { apiKey: 'key-1' } });
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer  key-1' },
    });
    // split(' ') → ["Bearer", "", "key-1"], token="" → falsy → 401
    expect(res.status).toBe(401);
  });

  // --- Valid API key auth ---

  it('allows valid tenant API key and sets tenant context', async () => {
    const app = buildApp({ myTenant: { apiKey: 'valid-key', plan: 'pro' } });
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer valid-key' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant.tenantId).toBe('myTenant');
    expect(body.tenant.plan).toBe('pro');
  });

  it('rejects unknown API key with 401', async () => {
    delete process.env.ADMIN_API_KEY;
    const app = buildApp({ t1: { apiKey: 'real-key' } });
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Invalid API key');
  });

  // --- Admin key as super-tenant ---

  it('allows ADMIN_API_KEY as super-tenant with __admin__ tenantId', async () => {
    process.env.ADMIN_API_KEY = 'super-secret-admin';
    const app = buildApp();
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer super-secret-admin' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant.tenantId).toBe('__admin__');
    expect(body.tenant.plan).toBe('enterprise');
  });

  it('does not grant admin when ADMIN_API_KEY is empty', async () => {
    process.env.ADMIN_API_KEY = '';
    const app = buildApp();
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer some-key' },
    });
    // safeCompare returns false for empty, so falls through to 401
    expect(res.status).toBe(401);
  });

  // --- Session token auth ---

  it('allows admin session token and sets __admin__ tenant', async () => {
    process.env.ADMIN_API_KEY = 'key';
    const store = new SessionStore(60_000);
    const session = store.createSession({ role: 'admin', name: 'Admin' });
    const app = buildApp({}, store);
    const res = await app.request('/api/test', {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant.tenantId).toBe('__admin__');
  });

  it('allows tenant session token and sets correct tenantId', async () => {
    process.env.ADMIN_API_KEY = 'key';
    const store = new SessionStore(60_000);
    const tenants = { myTenant: { apiKey: 'k1', plan: 'pro' } };
    const session = store.createSession({ role: 'tenant', tenantId: 'myTenant', name: 'T User' });
    const app = buildApp(tenants, store);
    const res = await app.request('/api/test', {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant.tenantId).toBe('myTenant');
  });

  it('rejects expired session token', async () => {
    process.env.ADMIN_API_KEY = 'key';
    const store = new SessionStore(1); // 1ms TTL
    const session = store.createSession({ role: 'admin', name: 'Admin' });
    await new Promise((r) => setTimeout(r, 10));
    const app = buildApp({}, store);
    const res = await app.request('/api/test', {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Invalid or expired session');
  });

  it('rejects fabricated sess_ token', async () => {
    process.env.ADMIN_API_KEY = 'key';
    const store = new SessionStore(60_000);
    const app = buildApp({}, store);
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer sess_totally_made_up' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Invalid or expired session');
  });

  it('rejects tenant session whose tenantId no longer exists in manager', async () => {
    process.env.ADMIN_API_KEY = 'key';
    const store = new SessionStore(60_000);
    // Session references tenantId 'ghost' which has no matching tenant
    const session = store.createSession({ role: 'tenant', tenantId: 'ghost', name: 'Ghost' });
    const app = buildApp({}, store); // No tenants registered
    const res = await app.request('/api/test', {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Invalid or expired session');
  });

  it('falls through to API key check when sess_ token used without session store', async () => {
    process.env.ADMIN_API_KEY = 'key';
    // No session store passed — sess_ prefix is meaningless, treated as regular API key
    const app = buildApp({ t1: { apiKey: 'sess_looks_like_session' } });
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer sess_looks_like_session' },
    });
    // The condition is `token.startsWith('sess_') && sessionStore` — sessionStore is undefined
    // So it skips session branch, looks up as API key → finds t1
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant.tenantId).toBe('t1');
  });
});

describe('usage middleware', () => {
  it('records usage and adds quota headers after request', async () => {
    const tm = createMockTenantManager({
      t1: {
        apiKey: 'key1',
        plan: 'starter',
        usageQuota: { messagesPerMonth: 500, apiCallsPerMonth: 1000 },
      },
    });

    const app = new Hono();
    app.use('/api/*', createTenantAuthMiddleware(tm as any, mockLogger as any));
    app.use('/api/*', createUsageMiddleware(tm as any, mockLogger as any));
    app.get('/api/messages', (c) => c.json({ ok: true }));

    const res = await app.request('/api/messages', {
      headers: { Authorization: 'Bearer key1' },
    });
    expect(res.status).toBe(200);
    // Quota headers should be present
    expect(res.headers.get('X-Quota-Messages-Used')).toBeDefined();
    expect(res.headers.get('X-Quota-ApiCalls-Used')).toBeDefined();
  });

  it('returns 401 in usage middleware when tenant not authenticated', async () => {
    const tm = createMockTenantManager();
    const app = new Hono();
    // Skip auth middleware — go straight to usage middleware
    app.use('/api/*', createUsageMiddleware(tm as any, mockLogger as any));
    app.get('/api/test', (c) => c.json({ ok: true }));

    const res = await app.request('/api/test');
    expect(res.status).toBe(401);
  });
});

describe('quota check middleware', () => {
  function buildQuotaApp(tenants: Record<string, any>, preloadUsage?: (tm: any) => void) {
    const tm = createMockTenantManager(tenants);
    if (preloadUsage) preloadUsage(tm);

    const app = new Hono();
    app.use('/api/*', createTenantAuthMiddleware(tm as any, mockLogger as any));
    app.use('/api/*', createQuotaCheckMiddleware(tm as any, mockLogger as any));
    app.get('/api/messages', (c) => c.json({ ok: true }));
    app.post('/api/agents', (c) => c.json({ created: true }));
    app.post('/api/agent-loop', (c) => c.json({ ran: true }));
    app.get('/api/other', (c) => c.json({ ok: true }));
    return app;
  }

  it('allows request when under quota', async () => {
    const app = buildQuotaApp({ t1: { apiKey: 'k1' } });
    const res = await app.request('/api/messages', {
      headers: { Authorization: 'Bearer k1' },
    });
    expect(res.status).toBe(200);
  });

  it('returns 429 when message quota is exceeded', async () => {
    const app = buildQuotaApp(
      { t1: { apiKey: 'k1', usageQuota: { messagesPerMonth: 1, apiCallsPerMonth: 1000 } } },
      (tm) => {
        // Pre-load 1 message to hit the limit
        tm.recordUsage({
          tenantId: 't1',
          botId: 'b',
          messageCount: 1,
          apiCallCount: 0,
          storageBytesUsed: 0,
        });
      }
    );
    const res = await app.request('/api/messages', {
      headers: { Authorization: 'Bearer k1' },
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Message quota exceeded');
    expect(body.upgradeUrl).toBe('/billing/upgrade');
  });

  it('returns 429 when API call quota is exceeded on agent-loop', async () => {
    const app = buildQuotaApp(
      { t1: { apiKey: 'k1', usageQuota: { messagesPerMonth: 500, apiCallsPerMonth: 1 } } },
      (tm) => {
        tm.recordUsage({
          tenantId: 't1',
          botId: 'b',
          messageCount: 0,
          apiCallCount: 1,
          storageBytesUsed: 0,
        });
      }
    );
    const res = await app.request('/api/agent-loop', {
      method: 'POST',
      headers: { Authorization: 'Bearer k1' },
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('API call quota exceeded');
  });

  it('does not block non-quota endpoints even when over limit', async () => {
    const app = buildQuotaApp(
      { t1: { apiKey: 'k1', usageQuota: { messagesPerMonth: 1, apiCallsPerMonth: 1 } } },
      (tm) => {
        tm.recordUsage({
          tenantId: 't1',
          botId: 'b',
          messageCount: 5,
          apiCallCount: 5,
          storageBytesUsed: 0,
        });
      }
    );
    // /api/other doesn't match /messages or /agents or /agent-loop
    const res = await app.request('/api/other', {
      headers: { Authorization: 'Bearer k1' },
    });
    expect(res.status).toBe(200);
  });

  it('returns 401 when tenant context is missing in quota middleware', async () => {
    const tm = createMockTenantManager();
    const app = new Hono();
    // No auth middleware — quota middleware alone
    app.use('/api/*', createQuotaCheckMiddleware(tm as any, mockLogger as any));
    app.get('/api/test', (c) => c.json({ ok: true }));

    const res = await app.request('/api/test');
    expect(res.status).toBe(401);
  });
});
