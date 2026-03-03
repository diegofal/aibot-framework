import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../src/config';
import type { Logger } from '../src/logger';
import { AdminCredentialStore } from '../src/tenant/admin-credentials';
import type { TenantManager } from '../src/tenant/manager';
import { SessionStore } from '../src/tenant/session-store';
import { authRoutes } from '../src/web/routes/auth';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const TEST_DIR = join(import.meta.dir, '.tmp-auth-login-test');

const TENANT_PASS_HASH = await Bun.password.hash('tenantpass1', { algorithm: 'argon2id' });

const mockTenant = {
  id: 'tenant-1',
  name: 'Test Tenant',
  email: 'tenant@example.com',
  plan: 'pro' as const,
  apiKey: 'aibot_testkey123',
  passwordHash: TENANT_PASS_HASH,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  usageQuota: { messagesPerMonth: 5000, apiCallsPerMonth: 10000, storageBytes: 1024 * 1024 },
};

const mockTenantManager = {
  getTenantByEmail: (email: string) => (email === 'tenant@example.com' ? mockTenant : undefined),
  getTenantByApiKey: (key: string) => (key === mockTenant.apiKey ? mockTenant : undefined),
} as unknown as TenantManager;

function makeConfig(multiTenantEnabled: boolean): Config {
  return { multiTenant: { enabled: multiTenantEnabled } } as unknown as Config;
}

describe('Auth Routes - Login/Logout', () => {
  let sessionStore: SessionStore;
  let adminStore: AdminCredentialStore;
  let app: Hono;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    sessionStore = new SessionStore();
    adminStore = new AdminCredentialStore(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function mountApp(multiTenant = true) {
    app = new Hono();
    app.route(
      '/api/auth',
      authRoutes({
        config: makeConfig(multiTenant),
        tenantManager: mockTenantManager,
        sessionStore,
        adminCredentialStore: adminStore,
        logger: noopLogger,
      })
    );
  }

  test('GET /api/auth/status returns auth state', async () => {
    mountApp(true);
    const res = await app.request('/api/auth/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.multiTenantEnabled).toBe(true);
    expect(body.adminSetupRequired).toBe(true); // no admin created yet
  });

  test('GET /api/auth/status shows adminSetupRequired=false after setup', async () => {
    await adminStore.create('admin@test.com', 'password123');
    mountApp(true);
    const res = await app.request('/api/auth/status');
    const body = await res.json();
    expect(body.adminSetupRequired).toBe(false);
  });

  test('POST /api/auth/admin-setup creates admin account', async () => {
    mountApp(true);
    const res = await app.request('/api/auth/admin-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.com', password: 'securepass1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(adminStore.exists()).toBe(true);
  });

  test('POST /api/auth/admin-setup returns 409 if already exists', async () => {
    await adminStore.create('admin@test.com', 'password123');
    mountApp(true);
    const res = await app.request('/api/auth/admin-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'other@test.com', password: 'securepass1' }),
    });
    expect(res.status).toBe(409);
  });

  test('POST /api/auth/admin-setup rejects short password', async () => {
    mountApp(true);
    const res = await app.request('/api/auth/admin-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.com', password: 'short' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('8 characters');
  });

  test('POST /api/auth/login with admin credentials returns session token', async () => {
    await adminStore.create('admin@test.com', 'password123');
    mountApp(true);
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.com', password: 'password123' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionToken).toStartWith('sess_');
    expect(body.role).toBe('admin');
    expect(body.name).toBe('Admin');
  });

  test('POST /api/auth/login with tenant credentials returns session token', async () => {
    mountApp(true);
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tenant@example.com', password: 'tenantpass1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionToken).toStartWith('sess_');
    expect(body.role).toBe('tenant');
    expect(body.name).toBe('Test Tenant');
    expect(body.tenantId).toBe('tenant-1');
  });

  test('POST /api/auth/login with wrong password returns 401', async () => {
    await adminStore.create('admin@test.com', 'password123');
    mountApp(true);
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.com', password: 'wrongpass' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid credentials');
  });

  test('POST /api/auth/login with unknown email returns 401', async () => {
    mountApp(true);
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'whatever' }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /api/auth/login returns 400 when multi-tenant disabled', async () => {
    mountApp(false);
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.com', password: 'password123' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/auth/logout invalidates session', async () => {
    await adminStore.create('admin@test.com', 'password123');
    mountApp(true);

    // Login first
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.com', password: 'password123' }),
    });
    const { sessionToken } = await loginRes.json();

    // Verify session exists
    expect(sessionStore.getSession(sessionToken)).toBeDefined();

    // Logout
    const logoutRes = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    expect(logoutRes.status).toBe(200);

    // Verify session is gone
    expect(sessionStore.getSession(sessionToken)).toBeUndefined();
  });
});
