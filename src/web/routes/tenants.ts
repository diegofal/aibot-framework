import { Hono } from 'hono';
import type { BotManager } from '../bot';
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { Tenant, TenantManager } from '../tenant/manager';

export interface TenantRoutesDeps {
  tenantManager: TenantManager;
  botManager: BotManager;
  config: Config;
  logger: Logger;
}

export function tenantRoutes(deps: TenantRoutesDeps) {
  const { tenantManager, logger } = deps;
  const app = new Hono();

  // Create a new tenant
  app.post('/', async (c) => {
    try {
      const body = await c.req.json();
      const { name, email, plan = 'free' } = body;

      if (!name || !email) {
        return c.json({ error: 'Missing required fields: name, email' }, 400);
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return c.json({ error: 'Invalid email format' }, 400);
      }

      // Validate plan
      const validPlans = ['free', 'starter', 'pro', 'enterprise'];
      if (!validPlans.includes(plan)) {
        return c.json({ error: `Invalid plan. Must be one of: ${validPlans.join(', ')}` }, 400);
      }

      // Email dedup
      const existing = tenantManager
        .listTenants()
        .find((t) => t.email.toLowerCase() === email.toLowerCase());
      if (existing) {
        return c.json({ error: 'An account with this email already exists' }, 409);
      }

      const tenant = tenantManager.createTenant(name, email, plan as Tenant['plan']);

      logger.info({ tenantId: tenant.id, email }, 'Tenant created via API');

      return c.json(
        {
          success: true,
          tenant: {
            id: tenant.id,
            name: tenant.name,
            email: tenant.email,
            plan: tenant.plan,
            apiKey: tenant.apiKey,
            createdAt: tenant.createdAt,
            usageQuota: tenant.usageQuota,
          },
        },
        201
      );
    } catch (error) {
      logger.error({ error }, 'Failed to create tenant');
      return c.json({ error: 'Failed to create tenant' }, 500);
    }
  });

  // Get tenant by ID (requires API key)
  app.get('/me', async (c) => {
    const tenant = c.get('tenant') as { tenantId: string } | undefined;

    if (!tenant) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const tenantData = tenantManager.getTenant(tenant.tenantId);
    if (!tenantData) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    const currentUsage = tenantManager.getCurrentMonthUsage(tenant.tenantId);

    return c.json({
      tenant: {
        id: tenantData.id,
        name: tenantData.name,
        email: tenantData.email,
        plan: tenantData.plan,
        createdAt: tenantData.createdAt,
        usageQuota: tenantData.usageQuota,
        currentUsage,
      },
    });
  });

  // Update tenant
  app.patch('/me', async (c) => {
    const tenant = c.get('tenant') as { tenantId: string } | undefined;

    if (!tenant) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    try {
      const body = await c.req.json();
      const { name, email } = body;

      const updates: Partial<Pick<Tenant, 'name' | 'email'>> = {};
      if (name) updates.name = name;
      if (email) updates.email = email;

      const updated = tenantManager.updateTenant(tenant.tenantId, updates);

      if (!updated) {
        return c.json({ error: 'Tenant not found' }, 404);
      }

      return c.json({
        success: true,
        tenant: {
          id: updated.id,
          name: updated.name,
          email: updated.email,
          plan: updated.plan,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to update tenant');
      return c.json({ error: 'Failed to update tenant' }, 500);
    }
  });

  // Regenerate API key
  app.post('/me/api-key/regenerate', async (c) => {
    const tenant = c.get('tenant') as { tenantId: string } | undefined;

    if (!tenant) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const newApiKey = tenantManager.regenerateApiKey(tenant.tenantId);

    if (!newApiKey) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    logger.info({ tenantId: tenant.tenantId }, 'API key regenerated');

    return c.json({
      success: true,
      apiKey: newApiKey,
      message: 'Your old API key is now invalid. Update your integrations immediately.',
    });
  });

  // Get usage stats
  app.get('/me/usage', async (c) => {
    const tenant = c.get('tenant') as { tenantId: string } | undefined;

    if (!tenant) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const tenantData = tenantManager.getTenant(tenant.tenantId);
    if (!tenantData) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    const currentUsage = tenantManager.getCurrentMonthUsage(tenant.tenantId);

    // Calculate percentages
    const messagePercent = Math.round(
      (currentUsage.messages / tenantData.usageQuota.messagesPerMonth) * 100
    );
    const apiCallPercent = Math.round(
      (currentUsage.apiCalls / tenantData.usageQuota.apiCallsPerMonth) * 100
    );
    const storagePercent = Math.round(
      (currentUsage.storage / tenantData.usageQuota.storageBytes) * 100
    );

    return c.json({
      currentPeriod: {
        start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
        end: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString(),
      },
      usage: {
        messages: {
          used: currentUsage.messages,
          limit: tenantData.usageQuota.messagesPerMonth,
          percent: messagePercent,
        },
        apiCalls: {
          used: currentUsage.apiCalls,
          limit: tenantData.usageQuota.apiCallsPerMonth,
          percent: apiCallPercent,
        },
        storage: {
          usedBytes: currentUsage.storage,
          limitBytes: tenantData.usageQuota.storageBytes,
          percent: storagePercent,
          usedHuman: formatBytes(currentUsage.storage),
          limitHuman: formatBytes(tenantData.usageQuota.storageBytes),
        },
      },
    });
  });

  // Admin: List all tenants (should be protected by admin auth in production)
  app.get('/', async (c) => {
    const tenants = tenantManager.listTenants().map((t) => ({
      id: t.id,
      name: t.name,
      email: t.email,
      plan: t.plan,
      createdAt: t.createdAt,
    }));

    return c.json({ tenants });
  });

  // Admin: Get specific tenant
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const tenant = tenantManager.getTenant(id);

    if (!tenant) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    const currentUsage = tenantManager.getCurrentMonthUsage(id);

    return c.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        email: tenant.email,
        plan: tenant.plan,
        createdAt: tenant.createdAt,
        usageQuota: tenant.usageQuota,
        currentUsage,
      },
    });
  });

  // Admin: Update tenant plan
  app.patch('/:id/plan', async (c) => {
    const id = c.req.param('id');

    try {
      const body = await c.req.json();
      const { plan } = body;

      const validPlans = ['free', 'starter', 'pro', 'enterprise'];
      if (!validPlans.includes(plan)) {
        return c.json({ error: `Invalid plan. Must be one of: ${validPlans.join(', ')}` }, 400);
      }

      const updated = tenantManager.updateTenant(id, { plan: plan as Tenant['plan'] });

      if (!updated) {
        return c.json({ error: 'Tenant not found' }, 404);
      }

      logger.info({ tenantId: id, newPlan: plan }, 'Tenant plan updated');

      return c.json({
        success: true,
        tenant: {
          id: updated.id,
          name: updated.name,
          plan: updated.plan,
          usageQuota: updated.usageQuota,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to update tenant plan');
      return c.json({ error: 'Failed to update tenant plan' }, 500);
    }
  });

  // Admin: Delete tenant
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');

    const deleted = tenantManager.deleteTenant(id);

    if (!deleted) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    logger.info({ tenantId: id }, 'Tenant deleted');

    return c.json({ success: true, message: 'Tenant deleted' });
  });

  return app;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}
