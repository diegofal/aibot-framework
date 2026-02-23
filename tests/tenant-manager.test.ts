import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TenantManager, type Tenant, type TenantManagerConfig } from '../src/tenant/manager';
import { NoOpBillingProvider } from '../src/tenant/billing';
import { createMockLogger } from './test-helpers';

describe('TenantManager', () => {
  let dataDir: string;
  let tenantManager: TenantManager;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    dataDir = join(tmpdir(), `tenant-test-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
    mockLogger = createMockLogger();
    
    const config: TenantManagerConfig = {
      dataDir,
      apiKeyPrefix: 'test_',
    };
    
    tenantManager = new TenantManager(config, mockLogger);
  });

  afterEach(() => {
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true });
    }
  });

  describe('createTenant', () => {
    it('should create a tenant with default free plan', () => {
      const tenant = tenantManager.createTenant('Test User', 'test@example.com');
      
      expect(tenant).toBeDefined();
      expect(tenant.name).toBe('Test User');
      expect(tenant.email).toBe('test@example.com');
      expect(tenant.plan).toBe('free');
      expect(tenant.apiKey).toStartWith('test_');
      expect(tenant.usageQuota.messagesPerMonth).toBe(500);
      expect(tenant.usageQuota.maxBots).toBe(1);
    });

    it('should create tenant with starter plan', () => {
      const tenant = tenantManager.createTenant('Pro User', 'pro@example.com', 'starter');
      
      expect(tenant.plan).toBe('starter');
      expect(tenant.usageQuota.messagesPerMonth).toBe(5000);
      expect(tenant.usageQuota.maxBots).toBe(3);
    });

    it('should create tenant with pro plan', () => {
      const tenant = tenantManager.createTenant('Enterprise User', 'enterprise@example.com', 'pro');
      
      expect(tenant.plan).toBe('pro');
      expect(tenant.usageQuota.messagesPerMonth).toBe(25000);
      expect(tenant.usageQuota.maxBots).toBe(10);
    });

    it('should create tenant with enterprise plan', () => {
      const tenant = tenantManager.createTenant('Corp User', 'corp@example.com', 'enterprise');
      
      expect(tenant.plan).toBe('enterprise');
      expect(tenant.usageQuota.messagesPerMonth).toBe(100000);
      expect(tenant.usageQuota.maxBots).toBe(50);
    });

    it('should persist tenant to disk', () => {
      const tenant = tenantManager.createTenant('Persisted User', 'persist@example.com');
      
      // Create new instance to verify persistence
      const newManager = new TenantManager({ dataDir, apiKeyPrefix: 'test_' }, mockLogger);
      const loaded = newManager.getTenant(tenant.id);
      
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe('Persisted User');
      expect(loaded?.apiKey).toBe(tenant.apiKey);
    });
  });

  describe('getTenant', () => {
    it('should return undefined for non-existent tenant', () => {
      const tenant = tenantManager.getTenant('non-existent-id');
      expect(tenant).toBeUndefined();
    });

    it('should return tenant by id', () => {
      const created = tenantManager.createTenant('Findable User', 'find@example.com');
      const found = tenantManager.getTenant(created.id);
      
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });
  });

  describe('getTenantByApiKey', () => {
    it('should find tenant by API key', () => {
      const created = tenantManager.createTenant('API User', 'api@example.com');
      const found = tenantManager.getTenantByApiKey(created.apiKey);
      
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    it('should return undefined for invalid API key', () => {
      const found = tenantManager.getTenantByApiKey('invalid_key');
      expect(found).toBeUndefined();
    });
  });

  describe('updateTenant', () => {
    it('should update tenant name and email', () => {
      const created = tenantManager.createTenant('Original Name', 'original@example.com');
      const updated = tenantManager.updateTenant(created.id, {
        name: 'Updated Name',
        email: 'updated@example.com',
      });
      
      expect(updated).toBeDefined();
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.email).toBe('updated@example.com');
    });

    it('should update plan and adjust quotas', () => {
      const created = tenantManager.createTenant('Plan Upgrader', 'upgrade@example.com', 'free');
      const updated = tenantManager.updateTenant(created.id, { plan: 'pro' });
      
      expect(updated?.plan).toBe('pro');
      expect(updated?.usageQuota.messagesPerMonth).toBe(25000);
      expect(updated?.usageQuota.maxBots).toBe(10);
    });

    it('should regenerate API key', () => {
      const created = tenantManager.createTenant('Key Rotator', 'keys@example.com');
      const oldKey = created.apiKey;
      
      const updated = tenantManager.updateTenant(created.id, {
        apiKey: 'test_newkey123456789',
      });
      
      expect(updated?.apiKey).toBe('test_newkey123456789');
      
      // Old key should not work
      expect(tenantManager.getTenantByApiKey(oldKey)).toBeUndefined();
      // New key should work
      expect(tenantManager.getTenantByApiKey('test_newkey123456789')).toBeDefined();
    });

    it('should return undefined for non-existent tenant', () => {
      const updated = tenantManager.updateTenant('non-existent', { name: 'New Name' });
      expect(updated).toBeUndefined();
    });
  });

  describe('regenerateApiKey', () => {
    it('should generate new API key', () => {
      const created = tenantManager.createTenant('Key User', 'key@example.com');
      const oldKey = created.apiKey;
      
      const newKey = tenantManager.regenerateApiKey(created.id);
      
      expect(newKey).toBeDefined();
      expect(newKey).not.toBe(oldKey);
      expect(newKey).toStartWith('test_');
      
      // Old key should not work
      expect(tenantManager.getTenantByApiKey(oldKey)).toBeUndefined();
      // New key should work
      expect(tenantManager.getTenantByApiKey(newKey!)).toBeDefined();
    });

    it('should return undefined for non-existent tenant', () => {
      const key = tenantManager.regenerateApiKey('non-existent');
      expect(key).toBeUndefined();
    });
  });

  describe('deleteTenant', () => {
    it('should delete tenant and remove from index', () => {
      const created = tenantManager.createTenant('To Delete', 'delete@example.com');
      const apiKey = created.apiKey;
      
      const deleted = tenantManager.deleteTenant(created.id);
      
      expect(deleted).toBe(true);
      expect(tenantManager.getTenant(created.id)).toBeUndefined();
      expect(tenantManager.getTenantByApiKey(apiKey)).toBeUndefined();
    });

    it('should return false for non-existent tenant', () => {
      const deleted = tenantManager.deleteTenant('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('listTenants', () => {
    it('should return empty array when no tenants', () => {
      const tenants = tenantManager.listTenants();
      expect(tenants).toEqual([]);
    });

    it('should return all tenants', () => {
      tenantManager.createTenant('User 1', 'user1@example.com');
      tenantManager.createTenant('User 2', 'user2@example.com');
      tenantManager.createTenant('User 3', 'user3@example.com');
      
      const tenants = tenantManager.listTenants();
      expect(tenants).toHaveLength(3);
    });
  });

  describe('usage tracking', () => {
    it('should record usage events', () => {
      const tenant = tenantManager.createTenant('Usage User', 'usage@example.com');
      
      tenantManager.recordUsage({
        tenantId: tenant.id,
        botId: 'bot-1',
        messageCount: 10,
        apiCallCount: 5,
        storageBytesUsed: 1024,
      });
      
      const usage = tenantManager.getCurrentMonthUsage(tenant.id);
      expect(usage.messages).toBe(10);
      expect(usage.apiCalls).toBe(5);
      expect(usage.storage).toBe(1024);
    });

    it('should aggregate multiple usage records', () => {
      const tenant = tenantManager.createTenant('Heavy User', 'heavy@example.com');
      
      tenantManager.recordUsage({
        tenantId: tenant.id,
        botId: 'bot-1',
        messageCount: 100,
        apiCallCount: 50,
        storageBytesUsed: 10240,
      });
      
      tenantManager.recordUsage({
        tenantId: tenant.id,
        botId: 'bot-2',
        messageCount: 50,
        apiCallCount: 25,
        storageBytesUsed: 5120,
      });
      
      const usage = tenantManager.getCurrentMonthUsage(tenant.id);
      expect(usage.messages).toBe(150);
      expect(usage.apiCalls).toBe(75);
      expect(usage.storage).toBe(15360);
    });

    it('should get usage for specific period', () => {
      const tenant = tenantManager.createTenant('Period User', 'period@example.com');
      
      tenantManager.recordUsage({
        tenantId: tenant.id,
        botId: 'bot-1',
        messageCount: 10,
        apiCallCount: 5,
        storageBytesUsed: 1024,
      });
      
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();
      
      const records = tenantManager.getUsageForPeriod(tenant.id, startOfMonth, endOfMonth);
      expect(records).toHaveLength(1);
      expect(records[0].messageCount).toBe(10);
    });
  });

  describe('quota checking', () => {
    it('should allow usage within quota', () => {
      const tenant = tenantManager.createTenant('Within Quota', 'within@example.com', 'free');
      
      // Free plan: 500 messages
      expect(tenantManager.checkQuota(tenant.id, 'messages', 100)).toBe(true);
      expect(tenantManager.checkQuota(tenant.id, 'messages', 500)).toBe(true);
    });

    it('should deny usage exceeding quota', () => {
      const tenant = tenantManager.createTenant('Over Quota', 'over@example.com', 'free');
      
      // Use up some quota
      tenantManager.recordUsage({
        tenantId: tenant.id,
        botId: 'bot-1',
        messageCount: 400,
        apiCallCount: 0,
        storageBytesUsed: 0,
      });
      
      // Free plan: 500 messages, 400 used, 101 more would exceed
      expect(tenantManager.checkQuota(tenant.id, 'messages', 101)).toBe(false);
    });

    it('should return false for non-existent tenant', () => {
      expect(tenantManager.checkQuota('non-existent', 'messages', 1)).toBe(false);
    });
  });

  describe('bot limits', () => {
    it('should check if tenant can create bot', () => {
      const tenant = tenantManager.createTenant('Bot Creator', 'bots@example.com', 'free');
      
      // Mock bot manager
      const mockBotManager = {
        getBotIds: () => [],
        config: { bots: [] as Array<{ tenantId?: string }> },
      };
      
      expect(tenantManager.canCreateBot(tenant.id, mockBotManager)).toBe(true);
    });

    it('should deny bot creation at limit', () => {
      const tenant = tenantManager.createTenant('Max Bots', 'max@example.com', 'free');
      
      // Free plan: 1 bot max
      const mockBotManager = {
        getBotIds: () => ['bot-1'],
        config: { bots: [{ tenantId: tenant.id }] as Array<{ tenantId?: string }> },
      };
      
      expect(tenantManager.canCreateBot(tenant.id, mockBotManager)).toBe(false);
    });

    it('should count bots per tenant', () => {
      const tenant1 = tenantManager.createTenant('Tenant 1', 't1@example.com');
      const tenant2 = tenantManager.createTenant('Tenant 2', 't2@example.com');
      
      const mockBotManager = {
        getBotIds: () => ['bot-1', 'bot-2', 'bot-3'],
        config: { 
          bots: [
            { tenantId: tenant1.id },
            { tenantId: tenant1.id },
            { tenantId: tenant2.id },
          ] as Array<{ tenantId?: string }>,
        },
      };
      
      expect(tenantManager.getBotCount(tenant1.id, mockBotManager)).toBe(2);
      expect(tenantManager.getBotCount(tenant2.id, mockBotManager)).toBe(1);
    });
  });

  describe('persistence', () => {
    it('should load tenants from disk on init', () => {
      // Create tenant with first manager
      const tenant = tenantManager.createTenant('Persisted', 'persist@example.com');
      
      // Create new manager instance
      const newManager = new TenantManager({ dataDir, apiKeyPrefix: 'test_' }, mockLogger);
      
      const loaded = newManager.getTenant(tenant.id);
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe('Persisted');
      expect(loaded?.apiKey).toBe(tenant.apiKey);
    });

    it('should handle corrupted tenant file gracefully', () => {
      // Write invalid JSON
      const fs = require('node:fs');
      fs.writeFileSync(join(dataDir, 'tenants.json'), 'not valid json');
      
      // Should not throw
      const newManager = new TenantManager({ dataDir, apiKeyPrefix: 'test_' }, mockLogger);
      expect(newManager.listTenants()).toEqual([]);
    });
  });
});

describe('NoOpBillingProvider', () => {
  let provider: NoOpBillingProvider;

  beforeEach(() => {
    provider = new NoOpBillingProvider();
  });

  it('should return mock customer ID', async () => {
    const mockTenant = {
      id: 'test',
      name: 'Test',
      email: 'test@example.com',
      plan: 'free' as const,
      apiKey: 'key',
      createdAt: new Date(),
      updatedAt: new Date(),
      quota: {} as any,
      usage: {} as any,
      features: {} as any,
    };
    
    const customerId = await provider.createCustomer(mockTenant);
    expect(customerId).toStartWith('noop_customer_');
  });

  it('should return mock subscription ID', async () => {
    const subId = await provider.createSubscription('tenant-1', 'pro');
    expect(subId).toStartWith('noop_subscription_');
  });

  it('should no-op for cancellation', async () => {
    await expect(provider.cancelSubscription('tenant-1')).resolves.toBeUndefined();
  });

  it('should no-op for subscription update', async () => {
    await expect(provider.updateSubscription('tenant-1', 'enterprise')).resolves.toBeUndefined();
  });

  it('should return undefined for invoice URL', async () => {
    const url = await provider.getInvoiceUrl('tenant-1');
    expect(url).toBeUndefined();
  });

  it('should no-op for webhook handling', async () => {
    await expect(provider.handleWebhook({}, 'signature')).resolves.toBeUndefined();
  });
});

// Test helper
function createMockLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => createMockLogger(),
  };
}
