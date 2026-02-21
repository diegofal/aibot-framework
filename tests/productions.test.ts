import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProductionsService } from '../src/productions/service';
import type { Config } from '../src/config';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

const TEST_DIR = join(process.cwd(), '.test-productions');

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    bots: [
      {
        id: 'bot1',
        name: 'Bot One',
        token: '',
        enabled: true,
        skills: [],
        productions: { enabled: true, trackOnly: false },
      },
      {
        id: 'bot2',
        name: 'Bot Two',
        token: '',
        enabled: true,
        skills: [],
        productions: { enabled: true, trackOnly: true },
      },
      {
        id: 'bot3',
        name: 'Bot Three',
        token: '',
        enabled: true,
        skills: [],
        // No productions config = defaults
      },
    ],
    productions: {
      enabled: true,
      baseDir: TEST_DIR,
    },
    ...overrides,
  } as Config;
}

describe('ProductionsService', () => {
  let service: ProductionsService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    service = new ProductionsService(makeConfig(), noopLogger);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe('resolveDir', () => {
    test('creates directory for bot', () => {
      const dir = service.resolveDir('bot1');
      expect(dir).toContain('bot1');
      expect(existsSync(dir)).toBe(true);
    });

    test('uses custom dir from bot config', () => {
      const customDir = join(TEST_DIR, 'custom-dir');
      const config = makeConfig();
      (config.bots[0] as any).productions = { enabled: true, trackOnly: false, dir: customDir };
      const svc = new ProductionsService(config, noopLogger);
      const dir = svc.resolveDir('bot1');
      expect(dir).toBe(customDir);
    });
  });

  describe('isTrackOnly', () => {
    test('returns false for non-trackOnly bot', () => {
      expect(service.isTrackOnly('bot1')).toBe(false);
    });

    test('returns true for trackOnly bot', () => {
      expect(service.isTrackOnly('bot2')).toBe(true);
    });

    test('returns false for bot without productions config', () => {
      expect(service.isTrackOnly('bot3')).toBe(false);
    });
  });

  describe('isEnabled', () => {
    test('returns true for enabled bots', () => {
      expect(service.isEnabled('bot1')).toBe(true);
      expect(service.isEnabled('bot2')).toBe(true);
    });

    test('returns false when global productions disabled', () => {
      const config = makeConfig();
      config.productions.enabled = false;
      const svc = new ProductionsService(config, noopLogger);
      expect(svc.isEnabled('bot1')).toBe(false);
    });

    test('returns false when bot productions disabled', () => {
      const config = makeConfig();
      (config.bots[0] as any).productions = { enabled: false };
      const svc = new ProductionsService(config, noopLogger);
      expect(svc.isEnabled('bot1')).toBe(false);
    });
  });

  describe('rewritePath', () => {
    test('rewrites path to productions dir', () => {
      const result = service.rewritePath('bot1', 'src/tools/example.ts');
      expect(result).toContain('bot1');
      expect(result).toContain('src__tools__example.ts');
    });
  });

  describe('logProduction', () => {
    test('creates changelog entry with generated id', () => {
      const entry = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'test.ts',
        action: 'create',
        description: 'file_write: test.ts',
        size: 100,
        trackOnly: false,
      });

      expect(entry.id).toBeTruthy();
      expect(entry.botId).toBe('bot1');
      expect(entry.tool).toBe('file_write');

      // Verify JSONL file exists
      const changelogPath = join(service.resolveDir('bot1'), 'changelog.jsonl');
      expect(existsSync(changelogPath)).toBe(true);
    });

    test('appends multiple entries', () => {
      for (let i = 0; i < 3; i++) {
        service.logProduction({
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          botId: 'bot1',
          tool: 'file_write',
          path: `file${i}.ts`,
          action: 'create',
          description: `file_write: file${i}.ts`,
          size: 50,
          trackOnly: false,
        });
      }

      const entries = service.getChangelog('bot1');
      expect(entries.length).toBe(3);
    });
  });

  describe('getChangelog', () => {
    beforeEach(() => {
      for (let i = 0; i < 5; i++) {
        service.logProduction({
          timestamp: new Date(Date.now() - (4 - i) * 60000).toISOString(),
          botId: 'bot1',
          tool: 'file_write',
          path: `file${i}.ts`,
          action: 'create',
          description: `file_write: file${i}.ts`,
          size: 50,
          trackOnly: false,
        });
      }
    });

    test('returns entries sorted newest first', () => {
      const entries = service.getChangelog('bot1');
      expect(entries.length).toBe(5);
      expect(entries[0].path).toBe('file4.ts');
    });

    test('respects limit', () => {
      const entries = service.getChangelog('bot1', { limit: 2 });
      expect(entries.length).toBe(2);
    });

    test('respects offset', () => {
      const entries = service.getChangelog('bot1', { limit: 2, offset: 2 });
      expect(entries.length).toBe(2);
      expect(entries[0].path).toBe('file2.ts');
    });

    test('returns empty for non-existent bot', () => {
      const entries = service.getChangelog('nonexistent');
      expect(entries.length).toBe(0);
    });
  });

  describe('getEntry', () => {
    test('finds entry by id', () => {
      const created = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'test.ts',
        action: 'create',
        description: 'test',
        size: 10,
        trackOnly: false,
      });

      const found = service.getEntry('bot1', created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    test('returns null for non-existent entry', () => {
      expect(service.getEntry('bot1', 'nonexistent')).toBeNull();
    });
  });

  describe('evaluate', () => {
    test('adds evaluation to entry', () => {
      const created = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'test.ts',
        action: 'create',
        description: 'test',
        size: 10,
        trackOnly: false,
      });

      const updated = service.evaluate('bot1', created.id, {
        status: 'approved',
        rating: 4,
        feedback: 'Good work',
      });

      expect(updated).not.toBeNull();
      expect(updated!.evaluation!.status).toBe('approved');
      expect(updated!.evaluation!.rating).toBe(4);
      expect(updated!.evaluation!.feedback).toBe('Good work');
      expect(updated!.evaluation!.evaluatedAt).toBeTruthy();

      // Verify persisted
      const refetched = service.getEntry('bot1', created.id);
      expect(refetched!.evaluation!.status).toBe('approved');
    });

    test('returns null for non-existent entry', () => {
      expect(service.evaluate('bot1', 'nonexistent', { status: 'approved' })).toBeNull();
    });

    test('writes feedback to soul loader when provided', () => {
      const created = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'test.ts',
        action: 'create',
        description: 'test',
        size: 10,
        trackOnly: false,
      });

      const memoryFacts: string[] = [];
      const mockSoulLoader = {
        appendDailyMemory: (fact: string) => memoryFacts.push(fact),
      } as any;

      service.evaluate('bot1', created.id, {
        status: 'rejected',
        rating: 2,
        feedback: 'Needs improvement',
      }, mockSoulLoader);

      expect(memoryFacts.length).toBe(1);
      expect(memoryFacts[0]).toContain('rejected');
      expect(memoryFacts[0]).toContain('2/5');
      expect(memoryFacts[0]).toContain('Needs improvement');
    });
  });

  describe('deleteProduction', () => {
    test('removes entry from changelog', () => {
      const created = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'test.ts',
        action: 'create',
        description: 'test',
        size: 10,
        trackOnly: false,
      });

      const ok = service.deleteProduction('bot1', created.id);
      expect(ok).toBe(true);
      expect(service.getEntry('bot1', created.id)).toBeNull();
    });

    test('returns false for non-existent entry', () => {
      expect(service.deleteProduction('bot1', 'nonexistent')).toBe(false);
    });
  });

  describe('getStats', () => {
    test('calculates stats correctly', () => {
      // Create entries with different statuses
      const e1 = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1', tool: 'file_write', path: 'a.ts', action: 'create',
        description: 'a', size: 10, trackOnly: false,
      });
      const e2 = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1', tool: 'file_write', path: 'b.ts', action: 'create',
        description: 'b', size: 10, trackOnly: false,
      });
      service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1', tool: 'file_write', path: 'c.ts', action: 'create',
        description: 'c', size: 10, trackOnly: false,
      });

      service.evaluate('bot1', e1.id, { status: 'approved', rating: 5 });
      service.evaluate('bot1', e2.id, { status: 'rejected', rating: 2 });

      const stats = service.getStats('bot1');
      expect(stats.total).toBe(3);
      expect(stats.approved).toBe(1);
      expect(stats.rejected).toBe(1);
      expect(stats.unreviewed).toBe(1);
      expect(stats.avgRating).toBe(3.5);
    });

    test('returns empty stats for bot with no entries', () => {
      const stats = service.getStats('nonexistent');
      expect(stats.total).toBe(0);
      expect(stats.avgRating).toBeNull();
    });
  });

  describe('getChangelog with status filter', () => {
    test('filters by evaluation status', () => {
      const e1 = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1', tool: 'file_write', path: 'a.ts', action: 'create',
        description: 'a', size: 10, trackOnly: false,
      });
      service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1', tool: 'file_write', path: 'b.ts', action: 'create',
        description: 'b', size: 10, trackOnly: false,
      });

      service.evaluate('bot1', e1.id, { status: 'approved' });

      const approved = service.getChangelog('bot1', { status: 'approved' });
      expect(approved.length).toBe(1);
      expect(approved[0].path).toBe('a.ts');

      const unreviewed = service.getChangelog('bot1', { status: 'unreviewed' });
      expect(unreviewed.length).toBe(1);
      expect(unreviewed[0].path).toBe('b.ts');
    });
  });

  describe('updateContent', () => {
    test('writes content to file', () => {
      // Create a production entry with a resolvable path
      const dir = service.resolveDir('bot1');
      const filePath = join(dir, 'test-file.ts');
      writeFileSync(filePath, 'original content', 'utf-8');

      const created = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: filePath,
        action: 'create',
        description: 'test',
        size: 16,
        trackOnly: false,
      });

      const ok = service.updateContent('bot1', created.id, 'updated content');
      expect(ok).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toBe('updated content');
    });
  });

  describe('getFileContent', () => {
    test('reads file content for production entry', () => {
      const dir = service.resolveDir('bot1');
      const filePath = join(dir, 'readable.ts');
      writeFileSync(filePath, 'hello world', 'utf-8');

      const created = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: filePath,
        action: 'create',
        description: 'test',
        size: 11,
        trackOnly: false,
      });

      const content = service.getFileContent('bot1', created.id);
      expect(content).toBe('hello world');
    });

    test('returns null for missing file', () => {
      const created = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: '/nonexistent/path/file.ts',
        action: 'create',
        description: 'test',
        size: 10,
        trackOnly: false,
      });

      const content = service.getFileContent('bot1', created.id);
      expect(content).toBeNull();
    });
  });

  describe('getAllBotStats', () => {
    test('returns stats for all enabled bots', () => {
      service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1', tool: 'file_write', path: 'a.ts', action: 'create',
        description: 'a', size: 10, trackOnly: false,
      });

      const allStats = service.getAllBotStats();
      // bot1 has entries, bot2/bot3 are enabled (appear even without entries)
      expect(allStats.length).toBeGreaterThanOrEqual(1);
      const bot1 = allStats.find((s) => s.botId === 'bot1');
      expect(bot1).toBeTruthy();
      expect(bot1!.total).toBe(1);
    });
  });
});
