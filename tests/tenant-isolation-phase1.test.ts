import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SoulLoader } from '../src/soul';
import { isPathWithinTenant, resolveTenantPaths } from '../src/tenant/tenant-paths';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as any;

const TEST_DIR = join(import.meta.dir, '..', '.test-tenant-isolation-p1');

describe('Phase 1 Tenant Isolation', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('resolveTenantPaths', () => {
    it('returns standard paths in single-tenant mode', () => {
      const paths = resolveTenantPaths({
        tenantId: undefined,
        botId: 'mybot',
        dataDir: './data/tenants',
        defaultSoulDir: './config/soul',
        defaultProductionsDir: './productions',
      });
      expect(paths.tenantRoot).toBe('');
      expect(paths.soulDir).toBe(join('config', 'soul', 'mybot'));
      expect(paths.workDir).toBe(join('productions', 'mybot'));
    });

    it('returns tenant-scoped paths when tenantId provided', () => {
      const paths = resolveTenantPaths({
        tenantId: 'tenant-X',
        botId: 'mybot',
        dataDir: './data/tenants',
        defaultSoulDir: './config/soul',
        defaultProductionsDir: './productions',
      });
      expect(paths.tenantRoot).toBe(join('data', 'tenants', 'tenant-X'));
      expect(paths.soulDir).toBe(join('data', 'tenants', 'tenant-X', 'bots', 'mybot', 'soul'));
      expect(paths.workDir).toBe(
        join('data', 'tenants', 'tenant-X', 'bots', 'mybot', 'productions')
      );
    });

    it('two tenants have completely separate paths', () => {
      const pathsA = resolveTenantPaths({
        tenantId: 'A',
        botId: 'bot1',
        dataDir: './data/tenants',
        defaultSoulDir: './config/soul',
        defaultProductionsDir: './productions',
      });
      const pathsB = resolveTenantPaths({
        tenantId: 'B',
        botId: 'bot1',
        dataDir: './data/tenants',
        defaultSoulDir: './config/soul',
        defaultProductionsDir: './productions',
      });
      expect(pathsA.soulDir).not.toBe(pathsB.soulDir);
      expect(pathsA.workDir).not.toBe(pathsB.workDir);
      expect(pathsA.tenantRoot).not.toBe(pathsB.tenantRoot);
    });
  });

  describe('isPathWithinTenant', () => {
    it('returns true when path is within tenant root', () => {
      expect(isPathWithinTenant('/data/tenants/A/bots/x/file.txt', '/data/tenants/A')).toBe(true);
    });

    it('returns false when path escapes tenant root', () => {
      expect(isPathWithinTenant('/data/tenants/B/bots/x/file.txt', '/data/tenants/A')).toBe(false);
    });

    it('returns false for path traversal attempts', () => {
      expect(isPathWithinTenant('/data/tenants/A/../B/bots/x/file.txt', '/data/tenants/A')).toBe(
        false
      );
    });

    it('returns true when tenantRoot is empty (single-tenant)', () => {
      expect(isPathWithinTenant('/any/path/file.txt', '')).toBe(true);
    });

    it('returns true for exact tenant root path', () => {
      expect(isPathWithinTenant('/data/tenants/A', '/data/tenants/A')).toBe(true);
    });
  });

  describe('SoulLoader per-user memory isolation', () => {
    it('appendDailyMemory with userId writes to users/{userId}/ subdir', () => {
      const soulDir = join(TEST_DIR, 'soul-bot1');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'SOUL.md'), '# Soul\nFriendly bot');

      const loader = new SoulLoader({ enabled: true, dir: soulDir } as any, noopLogger);

      loader.appendDailyMemory('User A likes cats', 'user-111');
      loader.appendDailyMemory('User B likes dogs', 'user-222');
      loader.appendDailyMemory('Shared fact: bot is friendly');

      // Check user-111 dir
      const user111Dir = join(soulDir, 'memory', 'users', 'user-111');
      const files111 = require('node:fs').readdirSync(user111Dir);
      expect(files111.length).toBe(1);
      const content111 = readFileSync(join(user111Dir, files111[0]), 'utf-8');
      expect(content111).toContain('User A likes cats');
      expect(content111).not.toContain('User B likes dogs');

      // Check user-222 dir
      const user222Dir = join(soulDir, 'memory', 'users', 'user-222');
      const files222 = require('node:fs').readdirSync(user222Dir);
      expect(files222.length).toBe(1);
      const content222 = readFileSync(join(user222Dir, files222[0]), 'utf-8');
      expect(content222).toContain('User B likes dogs');

      // Check shared (no userId)
      const sharedDir = join(soulDir, 'memory');
      // The shared daily log should contain the shared fact
      const sharedFiles = require('node:fs')
        .readdirSync(sharedDir)
        .filter((f: string) => f.endsWith('.md'));
      expect(sharedFiles.length).toBeGreaterThanOrEqual(1);
      const sharedContent = readFileSync(join(sharedDir, sharedFiles[0]), 'utf-8');
      expect(sharedContent).toContain('bot is friendly');
    });

    it('readRecentDailyLogs with userId returns ONLY user logs (not shared)', () => {
      const soulDir = join(TEST_DIR, 'soul-bot2');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'SOUL.md'), '# Soul\nFriendly bot');

      const loader = new SoulLoader({ enabled: true, dir: soulDir } as any, noopLogger);

      // Write shared and per-user logs
      loader.appendDailyMemory('Shared daily fact');
      loader.appendDailyMemory('User-specific fact', 'user-111');

      // With userId: only user-specific log — shared log is agent loop activity
      // and must NOT leak into isolated user sessions
      const logsWithUser = loader.readRecentDailyLogs('user-111');
      expect(logsWithUser).not.toContain('Shared daily fact');
      expect(logsWithUser).toContain('User-specific fact');

      // Without userId: only shared log
      const logsWithoutUser = loader.readRecentDailyLogs();
      expect(logsWithoutUser).toContain('Shared daily fact');
      expect(logsWithoutUser).not.toContain('User-specific fact');
    });

    it('readRecentDailyLogs for different userId does not see other user logs', () => {
      const soulDir = join(TEST_DIR, 'soul-bot3');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'SOUL.md'), '# Soul');

      const loader = new SoulLoader({ enabled: true, dir: soulDir } as any, noopLogger);

      loader.appendDailyMemory('Secret for user A', 'user-A');
      loader.appendDailyMemory('Secret for user B', 'user-B');

      const logsA = loader.readRecentDailyLogs('user-A');
      expect(logsA).toContain('Secret for user A');
      expect(logsA).not.toContain('Secret for user B');

      const logsB = loader.readRecentDailyLogs('user-B');
      expect(logsB).toContain('Secret for user B');
      expect(logsB).not.toContain('Secret for user A');
    });
  });

  describe('Single-tenant backward compatibility', () => {
    it('appendDailyMemory without userId writes to standard memory dir', () => {
      const soulDir = join(TEST_DIR, 'soul-compat');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });

      const loader = new SoulLoader({ enabled: true, dir: soulDir } as any, noopLogger);
      loader.appendDailyMemory('Normal fact');

      const files = require('node:fs')
        .readdirSync(join(soulDir, 'memory'))
        .filter((f: string) => f.endsWith('.md'));
      expect(files.length).toBe(1);
      const content = readFileSync(join(soulDir, 'memory', files[0]), 'utf-8');
      expect(content).toContain('Normal fact');
    });

    it('readRecentDailyLogs without userId works as before', () => {
      const soulDir = join(TEST_DIR, 'soul-compat2');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'SOUL.md'), '# Soul');

      const loader = new SoulLoader({ enabled: true, dir: soulDir } as any, noopLogger);
      loader.appendDailyMemory('Legacy fact');

      const logs = loader.readRecentDailyLogs();
      expect(logs).toContain('Legacy fact');
      expect(logs).toContain('## Recent Memory');
    });
  });
});
