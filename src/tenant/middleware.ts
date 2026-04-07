import type { Context, Next } from 'hono';
import { safeCompare } from '../crypto-utils';
import type { Logger } from '../logger';
import type { TenantManager } from '../tenant/manager';
import type { SessionStore } from '../tenant/session-store';

export interface TenantContext {
  tenantId: string;
  apiKey: string;
  plan: string;
}

export function createTenantAuthMiddleware(
  tenantManager: TenantManager,
  logger: Logger,
  sessionStore?: SessionStore
) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      return c.json({ error: 'Missing Authorization header' }, 401);
    }

    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return c.json({ error: 'Invalid Authorization format. Expected: Bearer <token>' }, 401);
    }

    // Session token auth (dashboard login)
    if (token.startsWith('sess_') && sessionStore) {
      const session = sessionStore.getSession(token);
      if (session) {
        if (session.role === 'admin') {
          c.set('tenant', { tenantId: '__admin__', apiKey: token, plan: 'enterprise' });
          return next();
        }
        if (session.tenantId) {
          const tenant = tenantManager.getTenant(session.tenantId);
          if (tenant) {
            c.set('tenant', { tenantId: tenant.id, apiKey: token, plan: tenant.plan });
            return next();
          }
        }
      }
      return c.json({ error: 'Invalid or expired session' }, 401);
    }

    // API key auth (programmatic access)
    const tenant = tenantManager.getTenantByApiKey(token);

    if (!tenant) {
      // Allow admin key to pass through as a super-tenant
      const adminKey = process.env.ADMIN_API_KEY;
      if (safeCompare(token, adminKey)) {
        c.set('tenant', { tenantId: '__admin__', apiKey: token, plan: 'enterprise' });
        return next();
      }
      logger.warn({ apiKey: `${token.slice(0, 8)}...` }, 'Invalid API key');
      return c.json({ error: 'Invalid API key' }, 401);
    }

    // Attach tenant context to request
    c.set('tenant', {
      tenantId: tenant.id,
      apiKey: token,
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

    // Graceful degradation: compute usage percentages
    const msgPct =
      tenantData.usageQuota.messagesPerMonth > 0
        ? currentUsage.messages / tenantData.usageQuota.messagesPerMonth
        : 0;
    const apiPct =
      tenantData.usageQuota.apiCallsPerMonth > 0
        ? currentUsage.apiCalls / tenantData.usageQuota.apiCallsPerMonth
        : 0;
    const maxPct = Math.max(msgPct, apiPct);

    // 80% warning: add headers so clients can show upgrade CTA
    if (maxPct >= 0.8) {
      c.header('X-Quota-Warning', maxPct >= 0.9 ? 'critical' : 'approaching');
      c.header('X-Quota-Usage-Pct', String(Math.round(maxPct * 100)));
    }

    // Check message quota for message endpoints
    if (path.includes('/messages')) {
      if (currentUsage.messages >= tenantData.usageQuota.messagesPerMonth) {
        return c.json(
          {
            error: 'Message quota exceeded',
            quota: tenantData.usageQuota.messagesPerMonth,
            used: currentUsage.messages,
            upgradeUrl: '/billing/upgrade',
          },
          429
        );
      }
    }

    // Check API call quota for resource-intensive endpoints
    if (path.includes('/agent-loop') || path.includes('/agents')) {
      if (currentUsage.apiCalls >= tenantData.usageQuota.apiCallsPerMonth) {
        return c.json(
          {
            error: 'API call quota exceeded',
            quota: tenantData.usageQuota.apiCallsPerMonth,
            used: currentUsage.apiCalls,
            upgradeUrl: '/billing/upgrade',
          },
          429
        );
      }
    }

    await next();
  };
}
