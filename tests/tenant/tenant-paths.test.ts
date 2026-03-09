import { describe, expect, test } from 'bun:test';
import { isPathWithinTenant, resolveTenantPaths } from '../../src/tenant/tenant-paths';

describe('resolveTenantPaths', () => {
  test('single-tenant mode returns standard paths', () => {
    const paths = resolveTenantPaths({
      tenantId: undefined,
      botId: 'my-bot',
      dataDir: './data/tenants',
      defaultSoulDir: './config/soul',
      defaultProductionsDir: './productions',
      defaultSessionsDir: './data/sessions',
      defaultMemoryDbPath: './data/memory.db',
    });

    expect(paths.tenantRoot).toBe('');
    expect(paths.soulDir).toBe('config/soul/my-bot');
    expect(paths.workDir).toBe('productions/my-bot');
    expect(paths.sessionsDir).toBe('./data/sessions');
    expect(paths.memoryDbPath).toBe('./data/memory.db');
  });

  test('multi-tenant mode returns tenant-scoped paths', () => {
    const paths = resolveTenantPaths({
      tenantId: 'tenant-abc',
      botId: 'sales-bot',
      dataDir: './data/tenants',
      defaultSoulDir: './config/soul',
      defaultProductionsDir: './productions',
    });

    expect(paths.tenantRoot).toBe('data/tenants/tenant-abc');
    expect(paths.soulDir).toBe('data/tenants/tenant-abc/bots/sales-bot/soul');
    expect(paths.workDir).toBe('data/tenants/tenant-abc/bots/sales-bot/productions');
    expect(paths.sessionsDir).toBe('data/tenants/tenant-abc/bots/sales-bot/sessions');
    expect(paths.memoryDbPath).toBe('data/tenants/tenant-abc/memory.db');
  });

  test('different tenants get different paths', () => {
    const opts = {
      botId: 'bot-1',
      dataDir: './data/tenants',
      defaultSoulDir: './config/soul',
      defaultProductionsDir: './productions',
    };

    const pathsA = resolveTenantPaths({ ...opts, tenantId: 'tenant-a' });
    const pathsB = resolveTenantPaths({ ...opts, tenantId: 'tenant-b' });

    expect(pathsA.soulDir).not.toBe(pathsB.soulDir);
    expect(pathsA.workDir).not.toBe(pathsB.workDir);
    expect(pathsA.sessionsDir).not.toBe(pathsB.sessionsDir);
    expect(pathsA.memoryDbPath).not.toBe(pathsB.memoryDbPath);
    expect(pathsA.tenantRoot).not.toBe(pathsB.tenantRoot);
  });

  test('same tenant different bots get different bot paths but same DB', () => {
    const opts = {
      tenantId: 'tenant-x',
      dataDir: './data/tenants',
      defaultSoulDir: './config/soul',
      defaultProductionsDir: './productions',
    };

    const pathsA = resolveTenantPaths({ ...opts, botId: 'bot-a' });
    const pathsB = resolveTenantPaths({ ...opts, botId: 'bot-b' });

    expect(pathsA.soulDir).not.toBe(pathsB.soulDir);
    expect(pathsA.sessionsDir).not.toBe(pathsB.sessionsDir);
    // Same tenant shares memory DB (query-isolated by botId)
    expect(pathsA.memoryDbPath).toBe(pathsB.memoryDbPath);
  });
});

describe('isPathWithinTenant', () => {
  test('single-tenant mode always returns true', () => {
    expect(isPathWithinTenant('/any/path', '')).toBe(true);
  });

  test('path within tenant root returns true', () => {
    expect(isPathWithinTenant('/data/tenants/t1/bots/b1/soul', '/data/tenants/t1')).toBe(true);
  });

  test('path outside tenant root returns false', () => {
    expect(isPathWithinTenant('/data/tenants/t2/bots/b1/soul', '/data/tenants/t1')).toBe(false);
  });

  test('path traversal blocked', () => {
    expect(isPathWithinTenant('/data/tenants/t1/../t2/bots', '/data/tenants/t1')).toBe(false);
  });
});
