import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../src/logger';
import { TenantManager } from '../src/tenant/manager';

const TEST_DIR = join('/tmp', `tenant-quota-test-${Date.now()}`);

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

describe('Tenant quota enforcement', () => {
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

  it('allows requests within quota', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com', 'free');
    expect(manager.checkQuota(tenant.id, 'messages', 1)).toBe(true);
  });

  it('blocks requests when quota exceeded', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com', 'free');
    // Free plan: 500 messages/month
    for (let i = 0; i < 500; i++) {
      manager.recordUsage({
        tenantId: tenant.id,
        botId: 'bot1',
        messageCount: 1,
        apiCallCount: 0,
        storageBytesUsed: 0,
      });
    }
    expect(manager.checkQuota(tenant.id, 'messages', 1)).toBe(false);
  });

  it('tracks API call quota separately from messages', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com', 'free');
    // Record messages but not API calls
    for (let i = 0; i < 100; i++) {
      manager.recordUsage({
        tenantId: tenant.id,
        botId: 'bot1',
        messageCount: 1,
        apiCallCount: 0,
        storageBytesUsed: 0,
      });
    }
    // API calls should still be allowed
    expect(manager.checkQuota(tenant.id, 'apiCalls', 1)).toBe(true);
  });

  it('returns false for unknown tenant', () => {
    expect(manager.checkQuota('nonexistent', 'messages', 1)).toBe(false);
  });

  it('usage accumulates across multiple bots', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com', 'free');
    for (let i = 0; i < 250; i++) {
      manager.recordUsage({
        tenantId: tenant.id,
        botId: 'bot1',
        messageCount: 1,
        apiCallCount: 0,
        storageBytesUsed: 0,
      });
    }
    for (let i = 0; i < 250; i++) {
      manager.recordUsage({
        tenantId: tenant.id,
        botId: 'bot2',
        messageCount: 1,
        apiCallCount: 0,
        storageBytesUsed: 0,
      });
    }
    // 500 total across both bots = at limit
    expect(manager.checkQuota(tenant.id, 'messages', 1)).toBe(false);
  });

  it('higher plans have higher limits', () => {
    const freeTenant = manager.createTenant('Free Co', 'free@example.com', 'free');
    const proTenant = manager.createTenant('Pro Co', 'pro@example.com', 'pro');

    // Record 501 messages for both
    for (let i = 0; i < 501; i++) {
      manager.recordUsage({
        tenantId: freeTenant.id,
        botId: 'bot1',
        messageCount: 1,
        apiCallCount: 0,
        storageBytesUsed: 0,
      });
      manager.recordUsage({
        tenantId: proTenant.id,
        botId: 'bot1',
        messageCount: 1,
        apiCallCount: 0,
        storageBytesUsed: 0,
      });
    }

    // Free (500 limit) should be over, pro (25000 limit) should be fine
    expect(manager.checkQuota(freeTenant.id, 'messages', 1)).toBe(false);
    expect(manager.checkQuota(proTenant.id, 'messages', 1)).toBe(true);
  });

  it('plan upgrade increases quota limits', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com', 'free');
    // Exhaust free quota
    for (let i = 0; i < 500; i++) {
      manager.recordUsage({
        tenantId: tenant.id,
        botId: 'bot1',
        messageCount: 1,
        apiCallCount: 0,
        storageBytesUsed: 0,
      });
    }
    expect(manager.checkQuota(tenant.id, 'messages', 1)).toBe(false);

    // Upgrade to starter (5000 messages/month)
    manager.updateTenant(tenant.id, { plan: 'starter' });
    expect(manager.checkQuota(tenant.id, 'messages', 1)).toBe(true);
  });

  it('getCurrentMonthUsage aggregates correctly', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com', 'free');
    manager.recordUsage({
      tenantId: tenant.id,
      botId: 'bot1',
      messageCount: 5,
      apiCallCount: 3,
      storageBytesUsed: 1024,
    });
    manager.recordUsage({
      tenantId: tenant.id,
      botId: 'bot1',
      messageCount: 2,
      apiCallCount: 1,
      storageBytesUsed: 512,
    });

    const usage = manager.getCurrentMonthUsage(tenant.id);
    expect(usage.messages).toBe(7);
    expect(usage.apiCalls).toBe(4);
    expect(usage.storage).toBe(1536);
  });
});
