import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Logger } from '../src/logger';
import type { TenantManager } from '../src/tenant/manager';
import { createTenantAuthMiddleware } from '../src/tenant/middleware';
import { SessionStore } from '../src/tenant/session-store';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const ADMIN_KEY = 'admin-key-12345';
const TENANT_KEY = 'tenant-key-67890';

const mockTenant = {
  id: 'tenant-1',
  name: 'Test Tenant',
  plan: 'pro' as const,
  apiKey: TENANT_KEY,
};

const mockTenantManager = {
  getTenantByApiKey: (key: string) => (key === TENANT_KEY ? mockTenant : undefined),
  getTenant: (id: string) => (id === 'tenant-1' ? mockTenant : undefined),
} as unknown as TenantManager;

describe('Tenant Auth Middleware - Admin key passthrough', () => {
  let app: Hono;
  let sessionStore: SessionStore;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    sessionStore = new SessionStore();
    app = new Hono();
    app.use('*', createTenantAuthMiddleware(mockTenantManager, noopLogger, sessionStore));
    app.get('/test', (c) => {
      const tenant = c.get('tenant');
      return c.json({ tenant });
    });
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  test('admin key passes through with __admin__ tenantId', async () => {
    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant.tenantId).toBe('__admin__');
    expect(body.tenant.plan).toBe('enterprise');
  });

  test('regular tenant key still works', async () => {
    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${TENANT_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant.tenantId).toBe('tenant-1');
    expect(body.tenant.plan).toBe('pro');
  });

  test('unknown key returns 401 even with admin key set', async () => {
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer unknown-key' },
    });
    expect(res.status).toBe(401);
  });

  test('missing auth header returns 401', async () => {
    const res = await app.request('/test');
    expect(res.status).toBe(401);
  });

  test('admin session token passes through as __admin__', async () => {
    const session = sessionStore.createSession({ role: 'admin', name: 'Admin' });
    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant.tenantId).toBe('__admin__');
    expect(body.tenant.plan).toBe('enterprise');
  });

  test('tenant session token resolves to tenant context', async () => {
    const session = sessionStore.createSession({
      role: 'tenant',
      tenantId: 'tenant-1',
      name: 'Test',
    });
    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant.tenantId).toBe('tenant-1');
    expect(body.tenant.plan).toBe('pro');
  });

  test('expired session token returns 401', async () => {
    const store = new SessionStore(1); // 1ms TTL
    const expiredApp = new Hono();
    expiredApp.use('*', createTenantAuthMiddleware(mockTenantManager, noopLogger, store));
    expiredApp.get('/test', (c) => c.json({ ok: true }));

    const session = store.createSession({ role: 'admin', name: 'Admin' });
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }

    const res = await expiredApp.request('/test', {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(401);
  });
});
