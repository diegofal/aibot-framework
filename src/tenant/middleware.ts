import type { Context, Next } from 'hono';
import type { TenantManager } from '../tenant/manager';
import type { Logger } from '../logger';

export interface TenantContext {
  tenantId: string;
  apiKey: string;
  plan: string;
}

export function createTenantAuthMiddleware(tenantManager: TenantManager, logger: Logger) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization');
    
    if (!authHeader) {
      return c.json({ error: 'Missing Authorization header' }, 401);
    }

    const [scheme, apiKey] = authHeader.split(' ');
    
    if (scheme !== 'Bearer' || !apiKey) {
      return c.json({ error: 'Invalid Authorization format. Expected: Bearer <api_key>' }, 401);
    }

    const tenant = tenantManager.getTenantByApiKey(apiKey);
    
    if (!tenant) {
      logger.warn({ apiKey: apiKey.slice(0, 8) + '...' }, 'Invalid API key');
      return c.json({ error: 'Invalid API key' }, 401);
    }

    // Attach tenant context to request
    c.set('tenant', {
      tenantId: tenant.id,
      apiKey: apiKey,
      plan: tenant.plan,
    });

    await next();
  };
}

export function createUsageMiddleware(tenantManager: TenantManager, logger: Logger) {
  return async (c: Context, next: Next) => {
    const tenant = c.get('tenant') as TenantContext | undefined;
    
    if (!tenant) {
      return c.json({ error: 'Tenant not authenticated' }, 401);
    }

    const startTime = Date.now();
    
    await next();
    
    // Record usage after request completes
    const duration = Date.now() - startTime;
    
    // Estimate API calls based on endpoint
    const path = c.req.path;
    let apiCallCount = 1;
    
    // Heavy operations count as more API calls
    if (path.includes('/agents') && c.req.method === 'POST') {
      apiCallCount = 2; // Creating a bot
    } else if (path.includes('/agent-loop')) {
      apiCallCount = 3; // Agent loop is resource intensive
    }
    
    // Extract botId from URL if present
    const botIdMatch = path.match(/\/agents\/([^\/]+)/);
    const botId = botIdMatch ? botIdMatch[1] : 'system';

    tenantManager.recordUsage({
      tenantId: tenant.tenantId,
      botId,
      messageCount: path.includes('/messages') ? 1 : 0,
      apiCallCount,
      storageBytesUsed: 0, // Would need actual storage tracking
    });

    // Add usage headers to response
    const currentUsage = tenantManager.getCurrentMonthUsage(tenant.tenantId);
    const tenantData = tenantManager.getTenant(tenant.tenantId);
    
    if (tenantData) {
      c.header('X-Quota-Messages-Used', String(currentUsage.messages));
      c.header('X-Quota-Messages-Limit', String(tenantData.usageQuota.messagesPerMonth));
      c.header('X-Quota-ApiCalls-Used', String(currentUsage.apiCalls));
      c.header('X-Quota-ApiCalls-Limit', String(tenantData.usageQuota.apiCallsPerMonth));
    }
  };
}

export function createQuotaCheckMiddleware(tenantManager: TenantManager, logger: Logger) {
  return async (c: Context, next: Next) => {
    const tenant = c.get('tenant') as TenantContext | undefined;
    
    if (!tenant) {
      return c.json({ error: 'Tenant not authenticated' }, 401);
    }

    const tenantData = tenantManager.getTenant(tenant.tenantId);
    if (!tenantData) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    // Check if request would exceed quota
    const currentUsage = tenantManager.getCurrentMonthUsage(tenant.tenantId);
    const path = c.req.path;
    
    // Check message quota for message endpoints
    if (path.includes('/messages')) {
      if (currentUsage.messages >= tenantData.usageQuota.messagesPerMonth) {
        return c.json({
          error: 'Message quota exceeded',
          quota: tenantData.usageQuota.messagesPerMonth,
          used: currentUsage.messages,
          upgradeUrl: '/billing/upgrade',
        }, 429);
      }
    }

    // Check API call quota for resource-intensive endpoints
    if (path.includes('/agent-loop') || path.includes('/agents')) {
      if (currentUsage.apiCalls >= tenantData.usageQuota.apiCallsPerMonth) {
        return c.json({
          error: 'API call quota exceeded',
          quota: tenantData.usageQuota.apiCallsPerMonth,
          used: currentUsage.apiCalls,
          upgradeUrl: '/billing/upgrade',
        }, 429);
      }
    }

    await next();
  };
}
