import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { tenantRoutes } from '../../../src/web/routes/tenants';

function makeLogger() {
  return {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    child: () => makeLogger(),
  } as any;
}

function makeTenantManager(opts: {
  tenant?: { id: string; identitySecret?: string };
  regenerateResult?: string;
}) {
  return {
    getTenant: (id: string) => (opts.tenant?.id === id ? opts.tenant : undefined),
    regenerateIdentitySecret: (id: string) =>
      opts.tenant?.id === id ? opts.regenerateResult : undefined,
    listTenants: () => (opts.tenant ? [opts.tenant] : []),
    createTenant: () => opts.tenant,
    updateTenant: () => opts.tenant,
    regenerateApiKey: () => undefined,
    getCurrentMonthUsage: () => ({ messages: 0, apiCalls: 0, storage: 0 }),
    deleteTenant: () => false,
  } as any;
}

describe('POST /me/identity-secret/regenerate', () => {
  test('returns 401 when not authenticated', async () => {
    const app = new Hono();
    const routes = tenantRoutes({
      tenantManager: makeTenantManager({}),
      botManager: {} as any,
      config: {} as any,
      logger: makeLogger(),
    });
    app.route('/tenants', routes);

    const res = await app.request('/tenants/me/identity-secret/regenerate', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  test('returns new secret when authenticated', async () => {
    const app = new Hono();
    const routes = tenantRoutes({
      tenantManager: makeTenantManager({
        tenant: { id: 'tenant-1', identitySecret: 'idsec_old' },
        regenerateResult: 'idsec_new_secret_12345',
      }),
      botManager: {} as any,
      config: {} as any,
      logger: makeLogger(),
    });

    // Simulate tenant auth middleware
    app.use('/tenants/*', async (c, next) => {
      c.set('tenant', { tenantId: 'tenant-1' });
      await next();
    });
    app.route('/tenants', routes);

    const res = await app.request('/tenants/me/identity-secret/regenerate', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.identitySecret).toBe('idsec_new_secret_12345');
    expect(body.message).toContain('invalid');
  });

  test('returns 404 when tenant not found', async () => {
    const app = new Hono();
    const routes = tenantRoutes({
      tenantManager: makeTenantManager({
        tenant: { id: 'other-tenant' },
      }),
      botManager: {} as any,
      config: {} as any,
      logger: makeLogger(),
    });

    app.use('/tenants/*', async (c, next) => {
      c.set('tenant', { tenantId: 'nonexistent' });
      await next();
    });
    app.route('/tenants', routes);

    const res = await app.request('/tenants/me/identity-secret/regenerate', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});
