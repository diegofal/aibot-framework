import { Hono } from 'hono';
import type { Logger } from '../../logger';
import type { TenantConfigStore } from '../../tenant/tenant-config-store';
import { getTenantId } from '../../tenant/tenant-scoping';

/**
 * Tenant config API routes.
 * All routes require tenant auth (tenantId is extracted from context).
 */
export function tenantConfigRoutes(deps: {
  configStore: TenantConfigStore;
  logger: Logger;
}) {
  const app = new Hono();
  const { configStore, logger } = deps;

  // GET /api/tenant-config — get current tenant config
  app.get('/', (c) => {
    const tenantId = getTenantId(c);
    if (!tenantId) return c.json({ error: 'Tenant context required' }, 401);

    const config = configStore.get(tenantId);
    // Mask API keys in response
    return c.json({
      ...config,
      apiKeys: maskApiKeys(config.apiKeys),
    });
  });

  // PUT /api/tenant-config — update tenant config (partial merge)
  app.put('/', async (c) => {
    const tenantId = getTenantId(c);
    if (!tenantId) return c.json({ error: 'Tenant context required' }, 401);

    const body = await c.req.json();
    // Prevent apiKeys from being set via general config update
    body.apiKeys = undefined;

    try {
      const updated = configStore.update(tenantId, body);
      logger.info({ tenantId }, 'Tenant config updated');
      return c.json({
        ...updated,
        apiKeys: maskApiKeys(updated.apiKeys),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid config';
      return c.json({ error: message }, 400);
    }
  });

  // GET /api/tenant-config/api-keys — get API key status (masked)
  app.get('/api-keys', (c) => {
    const tenantId = getTenantId(c);
    if (!tenantId) return c.json({ error: 'Tenant context required' }, 401);

    const keys = configStore.getApiKeys(tenantId);
    return c.json(maskApiKeys(keys));
  });

  // POST /api/tenant-config/api-keys — set API keys
  app.post('/api-keys', async (c) => {
    const tenantId = getTenantId(c);
    if (!tenantId) return c.json({ error: 'Tenant context required' }, 401);

    const body = await c.req.json<Record<string, string | null>>();

    // Build key updates: null values clear the key
    const updates: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(body)) {
      if (['claudeApiKey', 'elevenLabsApiKey', 'braveSearchApiKey'].includes(key)) {
        updates[key] = value === null ? undefined : String(value);
      }
    }

    configStore.setApiKeys(tenantId, updates);
    logger.info({ tenantId, keysUpdated: Object.keys(updates) }, 'Tenant API keys updated');
    return c.json({ ok: true, keys: maskApiKeys(configStore.getApiKeys(tenantId)) });
  });

  return app;
}

/** Mask API keys for safe display: show first 4 + last 4 chars */
function maskApiKeys(keys: Record<string, string | undefined>): Record<string, string | null> {
  const masked: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(keys)) {
    if (!value) {
      masked[key] = null;
    } else if (value.length <= 8) {
      masked[key] = '****';
    } else {
      masked[key] = `${value.slice(0, 4)}****${value.slice(-4)}`;
    }
  }
  return masked;
}
