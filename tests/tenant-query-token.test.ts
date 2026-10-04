/**
 * `<img src>` cannot send an Authorization header, so the avatar GET may carry
 * the dashboard session token as `?token=` — the same allowance `/ws/activity`
 * already has. Nothing else accepts a query token.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Logger } from '../src/logger';
import type { TenantManager } from '../src/tenant/manager';
import { allowsQueryToken, createTenantAuthMiddleware } from '../src/tenant/middleware';
import { SessionStore } from '../src/tenant/session-store';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const mockTenantManager = {
  getTenantByApiKey: () => undefined,
  getTenant: () => undefined,
} as unknown as TenantManager;

describe('allowsQueryToken', () => {
  test('only GET on /api/agents/:id/avatar', () => {
    expect(allowsQueryToken('GET', '/api/agents/b1/avatar')).toBe(true);
    expect(allowsQueryToken('get', '/api/agents/a%20b/avatar')).toBe(true);
    expect(allowsQueryToken('POST', '/api/agents/b1/avatar')).toBe(false);
    expect(allowsQueryToken('DELETE', '/api/agents/b1/avatar')).toBe(false);
    expect(allowsQueryToken('GET', '/api/agents/b1/home')).toBe(false);
    expect(allowsQueryToken('GET', '/api/agents/b1/avatar/x')).toBe(false);
    expect(allowsQueryToken('GET', '/api/agents')).toBe(false);
  });
});

describe('Tenant Auth Middleware - query token for the avatar image', () => {
  let app: Hono;
  let sessionStore: SessionStore;
  let sessionId: string;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = undefined;
    sessionStore = new SessionStore();
    sessionId = sessionStore.createSession({ role: 'admin', name: 'Admin' }).id;
    app = new Hono();
    app.use(
      '*',
      createTenantAuthMiddleware(mockTenantManager, noopLogger, sessionStore, {
        allowQueryToken: (c) => allowsQueryToken(c.req.method, c.req.path),
      })
    );
    app.get('/api/agents/:id/avatar', (c) => c.json({ tenant: c.get('tenant') }));
    app.post('/api/agents/:id/avatar', (c) => c.json({ ok: true }));
    app.get('/api/agents/:id/home', (c) => c.json({ ok: true }));
  });
  afterEach(() => {
    process.env.ADMIN_API_KEY = undefined;
  });

  test('GET avatar with a valid session token in the query passes', async () => {
    const res = await app.request(`/api/agents/b1/avatar?token=${sessionId}`);
    expect(res.status).toBe(200);
    expect((await res.json()).tenant.tenantId).toBe('__admin__');
  });
  test('a bogus query token is still 401', async () => {
    expect((await app.request('/api/agents/b1/avatar?token=sess_nope')).status).toBe(401);
    expect((await app.request('/api/agents/b1/avatar')).status).toBe(401);
  });
  test('the header still wins when both are present', async () => {
    const res = await app.request('/api/agents/b1/avatar?token=sess_nope', {
      headers: { Authorization: `Bearer ${sessionId}` },
    });
    expect(res.status).toBe(200);
  });
  test('other routes and methods ignore the query token', async () => {
    expect((await app.request(`/api/agents/b1/home?token=${sessionId}`)).status).toBe(401);
    expect(
      (await app.request(`/api/agents/b1/avatar?token=${sessionId}`, { method: 'POST' })).status
    ).toBe(401);
  });
  test('without the option nothing changes', async () => {
    const plain = new Hono();
    plain.use('*', createTenantAuthMiddleware(mockTenantManager, noopLogger, sessionStore));
    plain.get('/api/agents/:id/avatar', (c) => c.json({ ok: true }));
    expect((await plain.request(`/api/agents/b1/avatar?token=${sessionId}`)).status).toBe(401);
  });
});
