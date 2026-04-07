import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Logger } from '../src/logger';
import { createAdminAuthMiddleware } from '../src/tenant/admin-middleware';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

describe('Admin Auth Middleware', () => {
  let app: Hono;
  const ADMIN_KEY = 'test-admin-key-12345';

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    app = new Hono();
    app.use('*', createAdminAuthMiddleware(noopLogger));
    app.get('/admin/test', (c) => c.json({ ok: true }));
  });

  afterEach(() => {
    process.env.ADMIN_API_KEY = undefined;
  });

  test('rejects request without Authorization header', async () => {
    const res = await app.request('/admin/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Missing Authorization');
  });

  test('rejects request with wrong scheme', async () => {
    const res = await app.request('/admin/test', {
      headers: { Authorization: `Basic ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(401);
  });

  test('rejects request with invalid admin key', async () => {
    const res = await app.request('/admin/test', {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Forbidden');
  });

  test('allows request with valid admin key', async () => {
    const res = await app.request('/admin/test', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('rejects all requests when ADMIN_API_KEY is not set (fail-closed)', async () => {
    process.env.ADMIN_API_KEY = undefined;
    // Recreate middleware to pick up the unset env var
    const closedApp = new Hono();
    closedApp.use('*', createAdminAuthMiddleware(noopLogger));
    closedApp.get('/admin/test', (c) => c.json({ ok: true }));

    // Without ADMIN_API_KEY, even unauthenticated requests must be rejected (503)
    const res = await closedApp.request('/admin/test');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('not configured');
  });

  test('rejects authenticated requests when ADMIN_API_KEY is not set (fail-closed)', async () => {
    process.env.ADMIN_API_KEY = undefined;
    const closedApp = new Hono();
    closedApp.use('*', createAdminAuthMiddleware(noopLogger));
    closedApp.get('/admin/test', (c) => c.json({ ok: true }));

    // Even with a Bearer token, if ADMIN_API_KEY isn't set, reject with 503
    const res = await closedApp.request('/admin/test', {
      headers: { Authorization: 'Bearer some-key' },
    });
    expect(res.status).toBe(503);
  });
});
