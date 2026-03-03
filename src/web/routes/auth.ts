import { Hono } from 'hono';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import type { AdminCredentialStore } from '../../tenant/admin-credentials';
import type { TenantManager } from '../../tenant/manager';
import type { SessionStore } from '../../tenant/session-store';

export function authRoutes(deps: {
  config: Config;
  tenantManager: TenantManager | null;
  sessionStore: SessionStore;
  adminCredentialStore: AdminCredentialStore;
  logger: Logger;
}) {
  const app = new Hono();

  // GET /status — public, returns auth state for dashboard boot
  app.get('/status', (c) => {
    const multiTenantEnabled = deps.config.multiTenant?.enabled ?? false;
    const adminSetupRequired = multiTenantEnabled && !deps.adminCredentialStore.exists();
    return c.json({ multiTenantEnabled, adminSetupRequired });
  });

  // POST /admin-setup — first-run admin account creation (only works once)
  app.post('/admin-setup', async (c) => {
    if (!deps.config.multiTenant?.enabled) {
      return c.json({ error: 'Multi-tenant mode is not enabled' }, 400);
    }
    if (deps.adminCredentialStore.exists()) {
      return c.json({ error: 'Admin account already exists' }, 409);
    }

    const body = await c.req.json().catch(() => null);
    if (!body?.email || !body?.password) {
      return c.json({ error: 'Missing required fields: email, password' }, 400);
    }
    if (typeof body.password !== 'string' || body.password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters' }, 400);
    }

    await deps.adminCredentialStore.create(body.email, body.password);
    deps.logger.info({ email: body.email }, 'Admin account created via setup');
    return c.json({ success: true });
  });

  // POST /login — email + password login → session token
  app.post('/login', async (c) => {
    if (!deps.config.multiTenant?.enabled) {
      return c.json({ error: 'Multi-tenant mode is not enabled' }, 400);
    }

    const body = await c.req.json().catch(() => null);
    if (!body?.email || !body?.password) {
      return c.json({ error: 'Missing required fields: email, password' }, 400);
    }

    const email = String(body.email).toLowerCase();
    const password = String(body.password);

    // 1. Check admin credentials
    const isAdmin = await deps.adminCredentialStore.verify(email, password);
    if (isAdmin) {
      const session = deps.sessionStore.createSession({
        role: 'admin',
        name: 'Admin',
      });
      return c.json({
        sessionToken: session.id,
        role: 'admin',
        name: 'Admin',
      });
    }

    // 2. Check tenant by email
    if (deps.tenantManager) {
      const tenant = deps.tenantManager.getTenantByEmail(email);
      if (tenant?.passwordHash) {
        const valid = await Bun.password.verify(password, tenant.passwordHash);
        if (valid) {
          const session = deps.sessionStore.createSession({
            role: 'tenant',
            tenantId: tenant.id,
            name: tenant.name,
          });
          return c.json({
            sessionToken: session.id,
            role: 'tenant',
            name: tenant.name,
            tenantId: tenant.id,
          });
        }
      }
    }

    // 3. Neither matched — generic error (no enumeration)
    return c.json({ error: 'Invalid credentials' }, 401);
  });

  // POST /logout — invalidate session
  app.post('/logout', (c) => {
    const authHeader = c.req.header('Authorization');
    if (authHeader) {
      const [, token] = authHeader.split(' ');
      if (token?.startsWith('sess_')) {
        deps.sessionStore.deleteSession(token);
      }
    }
    return c.json({ success: true });
  });

  return app;
}
