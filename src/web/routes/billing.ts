import { Hono } from 'hono';
import type { BotManager } from '../../bot';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import type { TenantManager } from '../../tenant/manager';
import type { TenantContext } from '../../tenant/middleware';

export interface BillingRoutesDeps {
  tenantManager: TenantManager;
  botManager: BotManager;
  config: Config;
  logger: Logger;
}

export function billingRoutes(deps: BillingRoutesDeps) {
  const { tenantManager, botManager, config, logger } = deps;
  const app = new Hono();

  // GET /billing/status — current plan, usage, and billing info
  app.get('/status', async (c) => {
    const tenant = c.get('tenant') as TenantContext | undefined;
    if (!tenant) return c.json({ error: 'Unauthorized' }, 401);

    const tenantData = tenantManager.getTenant(tenant.tenantId);
    if (!tenantData) return c.json({ error: 'Tenant not found' }, 404);

    const usage = tenantManager.getCurrentMonthUsage(tenant.tenantId);

    return c.json({
      plan: tenantData.plan,
      billing: tenantData.billing ?? null,
      usage: {
        messages: { used: usage.messages, limit: tenantData.usageQuota.messagesPerMonth },
        apiCalls: { used: usage.apiCalls, limit: tenantData.usageQuota.apiCallsPerMonth },
        storage: { used: usage.storage, limit: tenantData.usageQuota.storageBytes },
      },
      availablePlans: ['free', 'starter', 'pro', 'enterprise'],
    });
  });

  // POST /billing/upgrade — request plan upgrade
  app.post('/upgrade', async (c) => {
    const tenant = c.get('tenant') as TenantContext | undefined;
    if (!tenant) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json().catch(() => null);
    if (!body?.plan) return c.json({ error: 'Missing required field: plan' }, 400);

    const { plan } = body;
    const validPlans = ['starter', 'pro', 'enterprise'];
    if (!validPlans.includes(plan)) {
      return c.json({ error: `Invalid plan. Must be one of: ${validPlans.join(', ')}` }, 400);
    }

    const tenantData = tenantManager.getTenant(tenant.tenantId);
    if (!tenantData) return c.json({ error: 'Tenant not found' }, 404);

    if (tenantData.plan === plan) {
      return c.json({ error: 'Already on this plan' }, 400);
    }

    // If Stripe is configured and billing provider exists, create checkout session
    const billingProvider = botManager.getBillingProvider();
    if (billingProvider && config.multiTenant?.stripe) {
      try {
        // Ensure customer exists in Stripe
        let customerId = tenantData.billing?.stripeCustomerId;
        if (!customerId) {
          customerId = await botManager.createBillingCustomer(tenant.tenantId);
        }
        if (customerId) {
          const subscriptionId = await billingProvider.createSubscription(customerId, plan);
          tenantManager.updateTenant(tenant.tenantId, {
            billing: {
              ...tenantData.billing,
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscriptionId,
            },
          });
          logger.info({ tenantId: tenant.tenantId, plan, subscriptionId }, 'Subscription created');
          return c.json({ success: true, plan, subscriptionId });
        }
      } catch (err) {
        logger.error({ err, tenantId: tenant.tenantId }, 'Stripe upgrade failed');
        return c.json({ error: 'Billing provider error' }, 500);
      }
    }

    // Fallback: direct plan update (managed / no-Stripe mode)
    const updated = tenantManager.updateTenant(tenant.tenantId, { plan: plan as any });
    if (!updated) return c.json({ error: 'Update failed' }, 500);

    logger.info({ tenantId: tenant.tenantId, plan }, 'Plan upgraded (direct)');
    return c.json({
      success: true,
      plan: updated.plan,
      usageQuota: updated.usageQuota,
    });
  });

  // POST /billing/downgrade — downgrade to free
  app.post('/downgrade', async (c) => {
    const tenant = c.get('tenant') as TenantContext | undefined;
    if (!tenant) return c.json({ error: 'Unauthorized' }, 401);

    const tenantData = tenantManager.getTenant(tenant.tenantId);
    if (!tenantData) return c.json({ error: 'Tenant not found' }, 404);

    if (tenantData.plan === 'free') {
      return c.json({ error: 'Already on free plan' }, 400);
    }

    // Cancel Stripe subscription if exists
    const billingProvider = botManager.getBillingProvider();
    if (billingProvider && tenantData.billing?.stripeSubscriptionId) {
      try {
        await billingProvider.cancelSubscription(tenantData.billing.stripeSubscriptionId);
        logger.info({ tenantId: tenant.tenantId }, 'Stripe subscription canceled');
      } catch (err) {
        logger.error({ err, tenantId: tenant.tenantId }, 'Stripe cancellation failed');
      }
    }

    const updated = tenantManager.updateTenant(tenant.tenantId, { plan: 'free' as any });
    if (!updated) return c.json({ error: 'Update failed' }, 500);

    return c.json({
      success: true,
      plan: updated.plan,
      usageQuota: updated.usageQuota,
    });
  });

  return app;
}
