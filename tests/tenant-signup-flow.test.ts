import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../src/logger';
import { TenantManager } from '../src/tenant/manager';

const TEST_DIR = join('/tmp', `tenant-signup-test-${Date.now()}`);

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

describe('Tenant signup flow', () => {
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

  it('creates a tenant with default free plan', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com');
    expect(tenant.id).toBeTruthy();
    expect(tenant.name).toBe('Test Co');
    expect(tenant.email).toBe('test@example.com');
    expect(tenant.plan).toBe('free');
    expect(tenant.apiKey).toBeTruthy();
    expect(tenant.apiKey).toMatch(/^aibot_/);
  });

  it('creates tenant with specified plan', () => {
    const tenant = manager.createTenant('Pro Co', 'pro@example.com', 'pro');
    expect(tenant.plan).toBe('pro');
    expect(tenant.usageQuota.messagesPerMonth).toBe(25000);
  });

  it('generates unique API key per tenant', () => {
    const t1 = manager.createTenant('Co 1', 'a@example.com');
    const t2 = manager.createTenant('Co 2', 'b@example.com');
    expect(t1.apiKey).not.toBe(t2.apiKey);
  });

  it('can look up tenant by API key', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com');
    const found = manager.getTenantByApiKey(tenant.apiKey);
    expect(found?.id).toBe(tenant.id);
  });

  it('regenerates API key and invalidates old one', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com');
    const oldKey = tenant.apiKey;
    const newKey = manager.regenerateApiKey(tenant.id);
    expect(newKey).not.toBe(oldKey);
    expect(manager.getTenantByApiKey(oldKey)).toBeUndefined();
    expect(manager.getTenantByApiKey(newKey!)).toBeTruthy();
  });

  it('email dedup: listTenants finds duplicates', () => {
    manager.createTenant('Co 1', 'test@example.com');
    const existing = manager
      .listTenants()
      .find((t) => t.email.toLowerCase() === 'test@example.com');
    expect(existing).toBeTruthy();
  });

  it('persists tenants across instances', () => {
    manager.createTenant('Persisted Co', 'persist@example.com');
    // Create new instance pointing to same dir
    const manager2 = new TenantManager({ dataDir: TEST_DIR }, createLogger());
    const found = manager2.listTenants();
    expect(found.length).toBe(1);
    expect(found[0].email).toBe('persist@example.com');
  });

  it('plan upgrade updates quotas', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com', 'free');
    expect(tenant.usageQuota.messagesPerMonth).toBe(500);
    const updated = manager.updateTenant(tenant.id, { plan: 'starter' });
    expect(updated?.usageQuota.messagesPerMonth).toBe(5000);
  });

  it('plan downgrade updates quotas', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com', 'pro');
    const updated = manager.updateTenant(tenant.id, { plan: 'free' });
    expect(updated?.usageQuota.messagesPerMonth).toBe(500);
    expect(updated?.usageQuota.maxBots).toBe(1);
  });

  it('delete tenant removes from all lookups', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com');
    const deleted = manager.deleteTenant(tenant.id);
    expect(deleted).toBe(true);
    expect(manager.getTenant(tenant.id)).toBeUndefined();
    expect(manager.getTenantByApiKey(tenant.apiKey)).toBeUndefined();
    expect(manager.listTenants().length).toBe(0);
  });

  it('bot limit check works per plan', () => {
    const tenant = manager.createTenant('Test Co', 'test@example.com', 'free');
    const limits = manager.getPlanLimits('free');
    expect(limits.maxBots).toBe(1);

    const proTenant = manager.createTenant('Pro Co', 'pro@example.com', 'pro');
    const proLimits = manager.getPlanLimits('pro');
    expect(proLimits.maxBots).toBe(10);
  });
});
