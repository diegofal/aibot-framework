import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../src/logger';
import { NoOpBillingProvider } from '../src/tenant/billing';
import { TenantManager } from '../src/tenant/manager';

const TEST_DIR = join('/tmp', `tenant-billing-test-${Date.now()}`);

function createLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => createLogger(),
  } as any;
}

describe('Tenant billing integration', () => {
  let manager: TenantManager;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    manager = new TenantManager({ dataDir: TEST_DIR }, createLogger());
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('NoOpBillingProvider', () => {
    it('createCustomer returns a noop ID', async () => {
      const provider = new NoOpBillingProvider();
      const tenant = manager.createTenant('Test', 'test@example.com');
      const customerId = await provider.createCustomer(tenant);
      expect(customerId).toMatch(/^noop_customer_/);
    });

    it('createSubscription returns a noop ID', async () => {
      const provider = new NoOpBillingProvider();
      const subId = await provider.createSubscription('cust_123', 'pro');
      expect(subId).toMatch(/^noop_subscription_/);
    });

    it('cancelSubscription does not throw', async () => {
      const provider = new NoOpBillingProvider();
      await expect(provider.cancelSubscription('sub_123')).resolves.toBeUndefined();
    });

    it('updateSubscription does not throw', async () => {
      const provider = new NoOpBillingProvider();
      await expect(provider.updateSubscription('sub_123', 'enterprise')).resolves.toBeUndefined();
    });

    it('getInvoiceUrl returns undefined', async () => {
      const provider = new NoOpBillingProvider();
      const url = await provider.getInvoiceUrl('cust_123');
      expect(url).toBeUndefined();
    });

    it('handleWebhook returns unhandled', async () => {
      const provider = new NoOpBillingProvider();
      const result = await provider.handleWebhook({}, 'sig');
      expect(result.type).toBe('unhandled');
    });
  });

  describe('Billing state management', () => {
    it('can store billing info on tenant', () => {
      const tenant = manager.createTenant('Test', 'test@example.com', 'starter');
      const updated = manager.updateTenant(tenant.id, {
        billing: {
          stripeCustomerId: 'cus_test123',
          stripeSubscriptionId: 'sub_test456',
        },
      });
      expect(updated?.billing?.stripeCustomerId).toBe('cus_test123');
      expect(updated?.billing?.stripeSubscriptionId).toBe('sub_test456');
    });

    it('preserves billing info across plan updates', () => {
      const tenant = manager.createTenant('Test', 'test@example.com', 'starter');
      manager.updateTenant(tenant.id, {
        billing: {
          stripeCustomerId: 'cus_test123',
          stripeSubscriptionId: 'sub_test456',
        },
      });
      // Upgrade plan
      const upgraded = manager.updateTenant(tenant.id, { plan: 'pro' });
      // Billing info should still be there
      expect(upgraded?.billing?.stripeCustomerId).toBe('cus_test123');
      expect(upgraded?.plan).toBe('pro');
    });

    it('billing info persists across instances', () => {
      const tenant = manager.createTenant('Test', 'test@example.com');
      manager.updateTenant(tenant.id, {
        billing: {
          stripeCustomerId: 'cus_persist',
        },
      });

      const manager2 = new TenantManager({ dataDir: TEST_DIR }, createLogger());
      const loaded = manager2.getTenant(tenant.id);
      expect(loaded?.billing?.stripeCustomerId).toBe('cus_persist');
    });
  });

  describe('Plan-based quotas', () => {
    it('free plan has correct limits', () => {
      const limits = manager.getPlanLimits('free');
      expect(limits.messagesPerMonth).toBe(500);
      expect(limits.apiCallsPerMonth).toBe(1000);
      expect(limits.maxBots).toBe(1);
    });

    it('starter plan has correct limits', () => {
      const limits = manager.getPlanLimits('starter');
      expect(limits.messagesPerMonth).toBe(5000);
      expect(limits.apiCallsPerMonth).toBe(10000);
      expect(limits.maxBots).toBe(3);
    });

    it('pro plan has correct limits', () => {
      const limits = manager.getPlanLimits('pro');
      expect(limits.messagesPerMonth).toBe(25000);
      expect(limits.apiCallsPerMonth).toBe(50000);
      expect(limits.maxBots).toBe(10);
    });

    it('enterprise plan has correct limits', () => {
      const limits = manager.getPlanLimits('enterprise');
      expect(limits.messagesPerMonth).toBe(100000);
      expect(limits.apiCallsPerMonth).toBe(200000);
      expect(limits.maxBots).toBe(50);
    });
  });
});
