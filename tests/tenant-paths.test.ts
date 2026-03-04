import { describe, expect, it } from 'bun:test';
import { isPathWithinTenant, resolveTenantPaths } from '../src/tenant/tenant-paths';

describe('resolveTenantPaths', () => {
  it('returns standard paths when tenantId is undefined', () => {
    const result = resolveTenantPaths({
      tenantId: undefined,
      botId: 'bot1',
      dataDir: './data/tenants',
      defaultSoulDir: './config/soul',
      defaultProductionsDir: './productions',
    });
    expect(result.tenantRoot).toBe('');
    expect(result.soulDir).toBe('config/soul/bot1');
    expect(result.workDir).toBe('productions/bot1');
  });

  it('returns tenant-scoped paths when tenantId is provided', () => {
    const result = resolveTenantPaths({
      tenantId: 'tenant-abc',
      botId: 'bot1',
      dataDir: './data/tenants',
      defaultSoulDir: './config/soul',
      defaultProductionsDir: './productions',
    });
    expect(result.tenantRoot).toBe('data/tenants/tenant-abc');
    expect(result.soulDir).toBe('data/tenants/tenant-abc/bots/bot1/soul');
    expect(result.workDir).toBe('data/tenants/tenant-abc/bots/bot1/productions');
  });

  it('handles absolute dataDir', () => {
    const result = resolveTenantPaths({
      tenantId: 'tenant-xyz',
      botId: 'mybot',
      dataDir: '/var/data/tenants',
      defaultSoulDir: './config/soul',
      defaultProductionsDir: './productions',
    });
    expect(result.tenantRoot).toBe('/var/data/tenants/tenant-xyz');
    expect(result.soulDir).toBe('/var/data/tenants/tenant-xyz/bots/mybot/soul');
    expect(result.workDir).toBe('/var/data/tenants/tenant-xyz/bots/mybot/productions');
  });

  it('handles different bot IDs', () => {
    const result1 = resolveTenantPaths({
      tenantId: 't1',
      botId: 'alpha',
      dataDir: './data/tenants',
      defaultSoulDir: './config/soul',
      defaultProductionsDir: './productions',
    });
    const result2 = resolveTenantPaths({
      tenantId: 't1',
      botId: 'beta',
      dataDir: './data/tenants',
      defaultSoulDir: './config/soul',
      defaultProductionsDir: './productions',
    });
    expect(result1.soulDir).not.toBe(result2.soulDir);
    expect(result1.workDir).not.toBe(result2.workDir);
    expect(result1.tenantRoot).toBe(result2.tenantRoot);
  });
});

describe('isPathWithinTenant', () => {
  it('returns true when tenantRoot is empty (single-tenant mode)', () => {
    expect(isPathWithinTenant('/any/path/here', '')).toBe(true);
    expect(isPathWithinTenant('../../escape', '')).toBe(true);
  });

  it('returns true for paths inside tenant root', () => {
    expect(isPathWithinTenant('/data/tenants/t1/bots/bot1/file.txt', '/data/tenants/t1')).toBe(
      true
    );
    expect(isPathWithinTenant('/data/tenants/t1/config.json', '/data/tenants/t1')).toBe(true);
  });

  it('returns true for the tenant root itself', () => {
    expect(isPathWithinTenant('/data/tenants/t1', '/data/tenants/t1')).toBe(true);
  });

  it('returns false for paths outside tenant root', () => {
    expect(isPathWithinTenant('/data/tenants/t2/bots/bot1/file.txt', '/data/tenants/t1')).toBe(
      false
    );
    expect(isPathWithinTenant('/etc/passwd', '/data/tenants/t1')).toBe(false);
  });

  it('returns false for path traversal attempts', () => {
    expect(isPathWithinTenant('/data/tenants/t1/../t2/secret', '/data/tenants/t1')).toBe(false);
    expect(isPathWithinTenant('/data/tenants/t1/../../etc/passwd', '/data/tenants/t1')).toBe(false);
  });

  it('returns false for prefix attacks (t1 vs t10)', () => {
    expect(isPathWithinTenant('/data/tenants/t10/file.txt', '/data/tenants/t1')).toBe(false);
  });
});
