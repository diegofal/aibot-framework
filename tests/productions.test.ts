import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../src/config';
import { ProductionsService } from '../src/productions/service';

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
      expect(found?.id).toBe(created.id);
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
      expect(updated?.evaluation?.status).toBe('approved');
      expect(updated?.evaluation?.rating).toBe(4);
      expect(updated?.evaluation?.feedback).toBe('Good work');
      expect(updated?.evaluation?.evaluatedAt).toBeTruthy();

      // Verify persisted
      const refetched = service.getEntry('bot1', created.id);
      expect(refetched?.evaluation?.status).toBe('approved');
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

      service.evaluate(
        'bot1',
        created.id,
        {
          status: 'rejected',
          rating: 2,
          feedback: 'Needs improvement',
        },
        mockSoulLoader
      );

      expect(memoryFacts.length).toBe(1);
      expect(memoryFacts[0]).toContain('rejected');
      expect(memoryFacts[0]).toContain('2/5');
      expect(memoryFacts[0]).toContain('Needs improvement');
    });
  });

  describe('setAiResponse', () => {
    test('saves AI response to evaluated entry', () => {
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

      service.evaluate('bot1', created.id, {
        status: 'approved',
        rating: 4,
        feedback: 'Good work',
      });

      const updated = service.setAiResponse(
        'bot1',
        created.id,
        'Thank you for the positive feedback!'
      );
      expect(updated).not.toBeNull();
      expect(updated?.evaluation?.aiResponse).toBe('Thank you for the positive feedback!');
      expect(updated?.evaluation?.aiResponseAt).toBeTruthy();

      // Verify persisted to JSONL
      const refetched = service.getEntry('bot1', created.id);
      expect(refetched?.evaluation?.aiResponse).toBe('Thank you for the positive feedback!');
    });

    test('returns null for unevaluated entry', () => {
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

      const result = service.setAiResponse('bot1', created.id, 'response');
      expect(result).toBeNull();
    });

    test('returns null for non-existent entry', () => {
      const result = service.setAiResponse('bot1', 'nonexistent', 'response');
      expect(result).toBeNull();
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
        botId: 'bot1',
        tool: 'file_write',
        path: 'a.ts',
        action: 'create',
        description: 'a',
        size: 10,
        trackOnly: false,
      });
      const e2 = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'b.ts',
        action: 'create',
        description: 'b',
        size: 10,
        trackOnly: false,
      });
      service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'c.ts',
        action: 'create',
        description: 'c',
        size: 10,
        trackOnly: false,
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

    test('skips corrupt non-JSON lines in changelog', () => {
      // Create a valid entry first
      service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'valid.ts',
        action: 'create',
        description: 'valid',
        size: 10,
        trackOnly: false,
      });

      // Inject corrupt lines into changelog (simulates bot writing markdown to JSONL)
      const { appendFileSync } = require('node:fs');
      const { join } = require('node:path');
      const dir = service.resolveDir('bot1');
      const changelogPath = join(dir, 'changelog.jsonl');
      appendFileSync(changelogPath, '# This is markdown, not JSON\n## Corrupt line\n');

      // Should still return stats for the valid entry, not crash
      const stats = service.getStats('bot1');
      expect(stats.total).toBe(1);
      expect(stats.unreviewed).toBe(1);
    });
  });

  describe('getChangelog with status filter', () => {
    test('filters by evaluation status', () => {
      const e1 = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'a.ts',
        action: 'create',
        description: 'a',
        size: 10,
        trackOnly: false,
      });
      service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'b.ts',
        action: 'create',
        description: 'b',
        size: 10,
        trackOnly: false,
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
    test('writes content to file with absolute path', () => {
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

    test('writes content to file with relative path', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'draft.txt'), 'old text', 'utf-8');

      const created = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'draft.txt',
        action: 'create',
        description: 'test',
        size: 8,
        trackOnly: false,
      });

      const ok = service.updateContent('bot1', created.id, 'new text');
      expect(ok).toBe(true);

      const content = readFileSync(join(dir, 'draft.txt'), 'utf-8');
      expect(content).toBe('new text');
    });

    test('returns false for non-existent entry', () => {
      const ok = service.updateContent('bot1', 'nonexistent', 'content');
      expect(ok).toBe(false);
    });
  });

  describe('getFileContent', () => {
    test('reads file content for production entry with absolute path', () => {
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

    test('reads file content for production entry with relative path', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'story.txt'), 'once upon a time', 'utf-8');

      const created = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'story.txt',
        action: 'create',
        description: 'test',
        size: 17,
        trackOnly: false,
      });

      const content = service.getFileContent('bot1', created.id);
      expect(content).toBe('once upon a time');
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
        botId: 'bot1',
        tool: 'file_write',
        path: 'a.ts',
        action: 'create',
        description: 'a',
        size: 10,
        trackOnly: false,
      });

      const allStats = service.getAllBotStats();
      // bot1 has entries, bot2/bot3 are enabled (appear even without entries)
      expect(allStats.length).toBeGreaterThanOrEqual(1);
      const bot1 = allStats.find((s) => s.botId === 'bot1');
      expect(bot1).toBeTruthy();
      expect(bot1?.total).toBe(1);
    });
  });

  describe('summary persistence', () => {
    test('readSummary returns null when no summary exists', () => {
      expect(service.readSummary('bot1')).toBeNull();
    });

    test('writeSummary + readSummary round-trip', () => {
      service.writeSummary('bot1', {
        summary: 'The bot is focused on writing articles.',
        generatedAt: '2026-02-22T10:00:00Z',
      });

      const data = service.readSummary('bot1');
      expect(data).not.toBeNull();
      expect(data?.summary).toBe('The bot is focused on writing articles.');
      expect(data?.generatedAt).toBe('2026-02-22T10:00:00Z');
      expect(data?.error).toBeUndefined();
    });

    test('writeSummary persists error state', () => {
      service.writeSummary('bot1', {
        error: 'CLI timeout',
        generatedAt: '2026-02-22T10:00:00Z',
      });

      const data = service.readSummary('bot1');
      expect(data).not.toBeNull();
      expect(data?.error).toBe('CLI timeout');
      expect(data?.summary).toBeUndefined();
    });

    test('writeSummary overwrites previous summary', () => {
      service.writeSummary('bot1', {
        summary: 'Old summary',
        generatedAt: '2026-02-22T09:00:00Z',
      });

      service.writeSummary('bot1', {
        summary: 'New summary',
        generatedAt: '2026-02-22T10:00:00Z',
      });

      const data = service.readSummary('bot1');
      expect(data?.summary).toBe('New summary');
      expect(data?.generatedAt).toBe('2026-02-22T10:00:00Z');
    });

    test('readSummary returns null for corrupt file', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'summary.json'), 'not valid json{{{', 'utf-8');

      expect(service.readSummary('bot1')).toBeNull();
    });
  });

  describe('addThreadMessage', () => {
    test('adds a thread message to an existing entry', () => {
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

      const result = service.addThreadMessage(
        'bot1',
        created.id,
        'human',
        'What was your reasoning?'
      );
      expect(result).not.toBeNull();
      expect(result?.message.role).toBe('human');
      expect(result?.message.content).toBe('What was your reasoning?');
      expect(result?.message.id).toBeTruthy();

      // Verify persisted
      const refetched = service.getEntry('bot1', created.id);
      expect(refetched?.evaluation).toBeTruthy();
      expect(refetched?.evaluation?.thread).toHaveLength(1);
      expect(refetched?.evaluation?.thread?.[0].content).toBe('What was your reasoning?');
    });

    test('creates evaluation stub if none exists', () => {
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

      service.addThreadMessage('bot1', created.id, 'human', 'Hello');
      const refetched = service.getEntry('bot1', created.id);
      expect(refetched?.evaluation).toBeTruthy();
      expect(refetched?.evaluation?.evaluatedAt).toBeTruthy();
      expect(refetched?.evaluation?.status).toBeUndefined();
    });

    test('appends multiple messages to thread', () => {
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

      service.addThreadMessage('bot1', created.id, 'human', 'Question 1');
      service.addThreadMessage('bot1', created.id, 'bot', 'Answer 1');
      service.addThreadMessage('bot1', created.id, 'human', 'Question 2');

      const refetched = service.getEntry('bot1', created.id);
      expect(refetched?.evaluation?.thread).toHaveLength(3);
      expect(refetched?.evaluation?.thread?.[0].role).toBe('human');
      expect(refetched?.evaluation?.thread?.[1].role).toBe('bot');
      expect(refetched?.evaluation?.thread?.[2].role).toBe('human');
    });

    test('returns null for non-existent entry', () => {
      expect(service.addThreadMessage('bot1', 'nonexistent', 'human', 'Hello')).toBeNull();
    });

    test('preserves existing evaluation when adding thread messages', () => {
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

      service.evaluate('bot1', created.id, { status: 'approved', rating: 4, feedback: 'Good' });
      service.addThreadMessage('bot1', created.id, 'human', 'Follow-up question');

      const refetched = service.getEntry('bot1', created.id);
      expect(refetched?.evaluation?.status).toBe('approved');
      expect(refetched?.evaluation?.rating).toBe(4);
      expect(refetched?.evaluation?.thread).toHaveLength(1);
    });
  });

  describe('getStats with optional status', () => {
    test('counts entries with thread-only evaluation as unreviewed', () => {
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

      // Add thread message without approve/reject
      service.addThreadMessage('bot1', created.id, 'human', 'Just a comment');

      const stats = service.getStats('bot1');
      expect(stats.total).toBe(1);
      expect(stats.unreviewed).toBe(1);
      expect(stats.approved).toBe(0);
    });

    test('getChangelog unreviewed filter includes thread-only entries', () => {
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

      service.addThreadMessage('bot1', created.id, 'human', 'Comment without decision');

      const unreviewed = service.getChangelog('bot1', { status: 'unreviewed' });
      expect(unreviewed).toHaveLength(1);
    });
  });

  describe('getAllEntries', () => {
    beforeEach(() => {
      // bot1: 3 entries
      for (let i = 0; i < 3; i++) {
        const entry = service.logProduction({
          timestamp: new Date(Date.now() - (5 - i) * 60000).toISOString(),
          botId: 'bot1',
          tool: 'file_write',
          path: `bot1-file${i}.ts`,
          action: 'create',
          description: `bot1 file ${i}`,
          size: 50,
          trackOnly: false,
        });
        if (i === 0) {
          service.evaluate('bot1', entry.id, { status: 'approved', rating: 4 });
        }
      }
      // bot2: 2 entries
      for (let i = 0; i < 2; i++) {
        const entry = service.logProduction({
          timestamp: new Date(Date.now() - (3 - i) * 60000).toISOString(),
          botId: 'bot2',
          tool: 'file_edit',
          path: `bot2-file${i}.md`,
          action: 'edit',
          description: `bot2 file ${i}`,
          size: 30,
          trackOnly: true,
        });
        if (i === 1) {
          service.evaluate('bot2', entry.id, { status: 'rejected', rating: 2 });
        }
      }
    });

    test('merges entries from all enabled bots', () => {
      const result = service.getAllEntries();
      expect(result.entries.length).toBe(5);
      expect(result.total).toBe(5);
    });

    test('sorts entries by timestamp descending (newest first)', () => {
      const result = service.getAllEntries();
      for (let i = 1; i < result.entries.length; i++) {
        expect(new Date(result.entries[i - 1].timestamp).getTime()).toBeGreaterThanOrEqual(
          new Date(result.entries[i].timestamp).getTime()
        );
      }
    });

    test('filters by botId', () => {
      const result = service.getAllEntries({ botId: 'bot1' });
      expect(result.entries.length).toBe(3);
      expect(result.total).toBe(3);
      expect(result.entries.every((e) => e.botId === 'bot1')).toBe(true);
    });

    test('filters by status approved', () => {
      const result = service.getAllEntries({ status: 'approved' });
      expect(result.total).toBe(1);
      expect(result.entries[0].evaluation?.status).toBe('approved');
    });

    test('filters by status rejected', () => {
      const result = service.getAllEntries({ status: 'rejected' });
      expect(result.total).toBe(1);
      expect(result.entries[0].evaluation?.status).toBe('rejected');
    });

    test('filters by status unreviewed', () => {
      const result = service.getAllEntries({ status: 'unreviewed' });
      expect(result.total).toBe(3);
      expect(result.entries.every((e) => !e.evaluation?.status)).toBe(true);
    });

    test('combines botId and status filters', () => {
      const result = service.getAllEntries({ botId: 'bot1', status: 'unreviewed' });
      expect(result.total).toBe(2);
      expect(result.entries.every((e) => e.botId === 'bot1' && !e.evaluation?.status)).toBe(true);
    });

    test('respects limit', () => {
      const result = service.getAllEntries({ limit: 2 });
      expect(result.entries.length).toBe(2);
      expect(result.total).toBe(5);
    });

    test('respects offset', () => {
      const all = service.getAllEntries();
      const paged = service.getAllEntries({ limit: 2, offset: 2 });
      expect(paged.entries.length).toBe(2);
      expect(paged.entries[0].id).toBe(all.entries[2].id);
    });

    test('returns empty when no entries exist', () => {
      // Use bot3 which has no changelog
      const result = service.getAllEntries({ botId: 'bot3' });
      expect(result.entries.length).toBe(0);
      expect(result.total).toBe(0);
    });
  });

  describe('getDirectoryTree', () => {
    test('returns empty array for bot with no files', () => {
      const tree = service.getDirectoryTree('bot1');
      // resolveDir only creates the directory, no files inside
      expect(tree).toEqual([]);
    });

    test('returns file nodes for flat directory', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'article.md'), '# Article', 'utf-8');
      writeFileSync(join(dir, 'notes.txt'), 'Some notes', 'utf-8');

      const tree = service.getDirectoryTree('bot1');
      expect(tree.length).toBe(2);
      expect(tree[0].name).toBe('article.md');
      expect(tree[0].type).toBe('file');
      expect(tree[0].path).toBe('article.md');
      expect(tree[0].size).toBeGreaterThan(0);
      expect(tree[1].name).toBe('notes.txt');
    });

    test('returns nested directory structure', () => {
      const dir = service.resolveDir('bot1');
      mkdirSync(join(dir, 'cultural'), { recursive: true });
      mkdirSync(join(dir, 'parenting'), { recursive: true });
      writeFileSync(join(dir, 'cultural', 'review.md'), '# Review', 'utf-8');
      writeFileSync(join(dir, 'parenting', 'guide.md'), '# Guide', 'utf-8');
      writeFileSync(join(dir, 'readme.md'), '# Root file', 'utf-8');

      const tree = service.getDirectoryTree('bot1');
      const cultural = tree.find((n) => n.name === 'cultural');
      expect(cultural).toBeTruthy();
      expect(cultural?.type).toBe('dir');
      expect(cultural?.children?.length).toBe(1);
      expect(cultural?.children?.[0].name).toBe('review.md');

      const rootFile = tree.find((n) => n.name === 'readme.md');
      expect(rootFile).toBeTruthy();
      expect(rootFile?.type).toBe('file');
    });

    test('enriches nodes with changelog metadata', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'report.md'), '# Report', 'utf-8');

      const entry = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'report.md',
        action: 'create',
        description: 'Monthly report',
        size: 10,
        trackOnly: false,
      });
      service.evaluate('bot1', entry.id, { status: 'approved', rating: 4 });

      const tree = service.getDirectoryTree('bot1');
      const reportNode = tree.find((n) => n.name === 'report.md');
      expect(reportNode?.entryId).toBe(entry.id);
      expect(reportNode?.description).toBe('Monthly report');
      expect(reportNode?.evaluation?.status).toBe('approved');
      expect(reportNode?.evaluation?.rating).toBe(4);
    });

    test('includes empty directories in tree', () => {
      const dir = service.resolveDir('bot1');
      mkdirSync(join(dir, 'empty-folder'), { recursive: true });
      mkdirSync(join(dir, 'parent', 'nested-empty'), { recursive: true });

      const tree = service.getDirectoryTree('bot1');
      const emptyFolder = tree.find((n) => n.name === 'empty-folder');
      expect(emptyFolder).toBeTruthy();
      expect(emptyFolder?.type).toBe('dir');
      expect(emptyFolder?.children).toEqual([]);

      const parent = tree.find((n) => n.name === 'parent');
      expect(parent).toBeTruthy();
      expect(parent?.children?.length).toBe(1);
      expect(parent?.children?.[0].name).toBe('nested-empty');
      expect(parent?.children?.[0].children).toEqual([]);
    });

    test('excludes TREE_EXCLUDES files but shows INDEX.md', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'real-file.md'), 'content', 'utf-8');
      writeFileSync(join(dir, 'INDEX.md'), '# Index', 'utf-8');
      // changelog.jsonl and summary.json should be excluded
      writeFileSync(join(dir, 'summary.json'), '{}', 'utf-8');

      const tree = service.getDirectoryTree('bot1');
      const names = tree.map((n) => n.name);
      expect(names).toContain('real-file.md');
      expect(names).toContain('INDEX.md');
      expect(names).not.toContain('changelog.jsonl');
      expect(names).not.toContain('summary.json');
    });

    test('getDirectoryTree includes INDEX.md in tree', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'INDEX.md'), '# Production Index\n**Files:** 3', 'utf-8');
      writeFileSync(join(dir, 'article.md'), '# Article', 'utf-8');

      const tree = service.getDirectoryTree('bot1');
      const indexNode = tree.find((n) => n.name === 'INDEX.md');
      expect(indexNode).toBeTruthy();
      expect(indexNode?.type).toBe('file');
      expect(indexNode?.size).toBeGreaterThan(0);
    });
  });

  describe('getFileContentByPath', () => {
    test('reads file content by relative path', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'test.md'), 'Hello world', 'utf-8');

      const result = service.getFileContentByPath('bot1', 'test.md');
      expect(result).not.toBeNull();
      expect(result?.content).toBe('Hello world');
      expect(result?.size).toBe(11);
    });

    test('reads file in subdirectory', () => {
      const dir = service.resolveDir('bot1');
      mkdirSync(join(dir, 'sub'), { recursive: true });
      writeFileSync(join(dir, 'sub', 'nested.txt'), 'Nested content', 'utf-8');

      const result = service.getFileContentByPath('bot1', 'sub/nested.txt');
      expect(result).not.toBeNull();
      expect(result?.content).toBe('Nested content');
    });

    test('returns null for non-existent file', () => {
      expect(service.getFileContentByPath('bot1', 'nonexistent.md')).toBeNull();
    });

    test('blocks path traversal with ..', () => {
      expect(service.getFileContentByPath('bot1', '../../../etc/passwd')).toBeNull();
    });

    test('blocks absolute paths', () => {
      expect(service.getFileContentByPath('bot1', '/etc/passwd')).toBeNull();
    });

    test('returns null for directories', () => {
      const dir = service.resolveDir('bot1');
      mkdirSync(join(dir, 'somedir'), { recursive: true });

      expect(service.getFileContentByPath('bot1', 'somedir')).toBeNull();
    });
  });

  describe('getAllDirectoryTrees', () => {
    test('returns bot-level directory nodes for enabled bots', () => {
      const dir1 = service.resolveDir('bot1');
      writeFileSync(join(dir1, 'article.md'), '# Article', 'utf-8');

      const dir2 = service.resolveDir('bot2');
      writeFileSync(join(dir2, 'notes.md'), '# Notes', 'utf-8');

      const trees = service.getAllDirectoryTrees();
      expect(trees.length).toBeGreaterThanOrEqual(2);

      const bot1Node = trees.find((n) => n.path === 'bot1');
      expect(bot1Node).toBeTruthy();
      expect(bot1Node?.type).toBe('dir');
      expect(bot1Node?.name).toBe('Bot One');
      expect(bot1Node?.children?.some((c) => c.name === 'article.md')).toBe(true);

      const bot2Node = trees.find((n) => n.path === 'bot2');
      expect(bot2Node).toBeTruthy();
      expect(bot2Node?.name).toBe('Bot Two');
    });

    test('uses bot name from config as node name', () => {
      service.resolveDir('bot1');
      const trees = service.getAllDirectoryTrees();
      const bot1 = trees.find((n) => n.path === 'bot1');
      expect(bot1?.name).toBe('Bot One');
    });

    test('includes nested structure within each bot', () => {
      const dir = service.resolveDir('bot1');
      mkdirSync(join(dir, 'cultural'), { recursive: true });
      writeFileSync(join(dir, 'cultural', 'review.md'), 'content', 'utf-8');

      const trees = service.getAllDirectoryTrees();
      const bot1 = trees.find((n) => n.path === 'bot1');
      const cultural = bot1?.children?.find((c) => c.name === 'cultural');
      expect(cultural?.type).toBe('dir');
      expect(cultural?.children?.[0]?.name).toBe('review.md');
    });
  });

  describe('getNextNumber', () => {
    test('returns 01 for empty directory', () => {
      expect(service.getNextNumber('bot1', '')).toBe('01');
    });

    test('returns next number after existing numbered files', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, '01_article.md'), '# Article', 'utf-8');
      writeFileSync(join(dir, '02_notes.md'), '# Notes', 'utf-8');
      expect(service.getNextNumber('bot1', '')).toBe('03');
    });

    test('handles gaps in numbering', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, '01_first.md'), 'content', 'utf-8');
      writeFileSync(join(dir, '05_fifth.md'), 'content', 'utf-8');
      expect(service.getNextNumber('bot1', '')).toBe('06');
    });

    test('works with subdirectories', () => {
      const dir = service.resolveDir('bot1');
      mkdirSync(join(dir, 'cultural'), { recursive: true });
      writeFileSync(join(dir, 'cultural', '01_review.md'), 'content', 'utf-8');
      writeFileSync(join(dir, 'cultural', '02_analysis.md'), 'content', 'utf-8');
      expect(service.getNextNumber('bot1', 'cultural')).toBe('03');
    });

    test('ignores non-numbered files', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'readme.md'), 'content', 'utf-8');
      writeFileSync(join(dir, '01_article.md'), 'content', 'utf-8');
      expect(service.getNextNumber('bot1', '')).toBe('02');
    });
  });

  describe('renumberFile', () => {
    test('prepends number to unnumbered file', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'article.md'), '# Article', 'utf-8');

      const newPath = service.renumberFile('bot1', 'article.md');
      expect(newPath).toBe('01_article.md');
      expect(existsSync(join(dir, '01_article.md'))).toBe(true);
      expect(existsSync(join(dir, 'article.md'))).toBe(false);
    });

    test('skips already numbered files', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, '01_article.md'), 'content', 'utf-8');

      const newPath = service.renumberFile('bot1', '01_article.md');
      expect(newPath).toBe('01_article.md');
    });

    test('skips excluded files', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'INDEX.md'), '# Index', 'utf-8');

      const newPath = service.renumberFile('bot1', 'INDEX.md');
      expect(newPath).toBe('INDEX.md');
    });

    test('handles subdirectory files', () => {
      const dir = service.resolveDir('bot1');
      mkdirSync(join(dir, 'cultural'), { recursive: true });
      writeFileSync(join(dir, 'cultural', 'review.md'), 'content', 'utf-8');

      const newPath = service.renumberFile('bot1', 'cultural/review.md');
      expect(newPath).toBe('cultural/01_review.md');
      expect(existsSync(join(dir, 'cultural', '01_review.md'))).toBe(true);
    });

    test('increments after existing numbered files', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, '01_first.md'), 'content', 'utf-8');
      writeFileSync(join(dir, 'second.md'), 'content', 'utf-8');

      const newPath = service.renumberFile('bot1', 'second.md');
      expect(newPath).toBe('02_second.md');
    });

    test('returns original path for non-existent file', () => {
      const newPath = service.renumberFile('bot1', 'nonexistent.md');
      expect(newPath).toBe('nonexistent.md');
    });
  });

  describe('extractDescription', () => {
    test('extracts title and first sentence', () => {
      const content = `# My Article

This is a great article about TypeScript. It covers many topics.

## Section 1`;
      const desc = ProductionsService.extractDescription(content);
      expect(desc).toBe('My Article -- This is a great article about TypeScript.');
    });

    test('returns just title when no paragraph follows', () => {
      const content = `# Title Only

- bullet one
- bullet two
## Next Section`;
      const desc = ProductionsService.extractDescription(content);
      expect(desc).toBe('Title Only');
    });

    test('returns empty string for empty content', () => {
      expect(ProductionsService.extractDescription('')).toBe('');
      expect(ProductionsService.extractDescription('   \n  ')).toBe('');
    });

    test('caps at 120 characters', () => {
      const content = `# A Very Long Title That Goes On And On

This is a very long first sentence that keeps going and going until it reaches well past the one hundred and twenty character limit that we set.`;
      const desc = ProductionsService.extractDescription(content);
      expect(desc.length).toBeLessThanOrEqual(120);
    });

    test('skips metadata lines', () => {
      const content = `# Report

date: 2026-03-01
author: Bot
tags: analysis

The market showed strong signals today.`;
      const desc = ProductionsService.extractDescription(content);
      expect(desc).toContain('Report');
      expect(desc).toContain('The market showed strong signals today.');
    });

    test('handles content without heading', () => {
      const content = 'Just a plain paragraph of text without any heading.';
      const desc = ProductionsService.extractDescription(content);
      expect(desc).toBe('');
    });
  });

  describe('checkCoherence', () => {
    test('returns coherent for well-structured content', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(
        join(dir, 'good.md'),
        `# Good Article

This is a well-written article about an important topic. It has real content and provides value to the reader.

## Analysis

The data shows clear trends in the market. We can see several patterns emerging from the numbers.

## Conclusion

Based on the above, we recommend a conservative approach.`,
        'utf-8'
      );

      const result = service.checkCoherence('bot1', 'good.md');
      expect(result.coherent).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    test('detects too-small content', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'tiny.md'), '# Title\n\nHi', 'utf-8');

      const result = service.checkCoherence('bot1', 'tiny.md');
      expect(result.coherent).toBe(false);
      expect(result.issues.some((i) => i.includes('too small'))).toBe(true);
    });

    test('detects template/placeholder content', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(
        join(dir, 'template.md'),
        `# Section
## Title
## Overview
## Summary
- TBD
- TBD
- [ ]
- [ ]
TODO: fill in`,
        'utf-8'
      );

      const result = service.checkCoherence('bot1', 'template.md');
      expect(result.coherent).toBe(false);
      expect(result.issues.some((i) => i.includes('placeholder'))).toBe(true);
    });

    test('detects broken structure (many headings, few paragraphs)', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(
        join(dir, 'headings.md'),
        `# One
## Two
### Three
#### Four
##### Five
Just one line.`,
        'utf-8'
      );

      const result = service.checkCoherence('bot1', 'headings.md');
      expect(result.coherent).toBe(false);
      expect(result.issues.some((i) => i.includes('Broken structure'))).toBe(true);
    });

    test('returns not found for missing file', () => {
      const result = service.checkCoherence('bot1', 'missing.md');
      expect(result.coherent).toBe(false);
      expect(result.issues).toContain('File not found');
    });
  });

  describe('rebuildIndex with plan section', () => {
    test('includes plan section when summary.json has plan', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'article.md'), '# Test Article\n\nSome content here.', 'utf-8');
      service.writeSummary('bot1', {
        summary: 'Bot is writing articles.',
        plan: 'Focus on cultural content and parenting guides.',
        generatedAt: new Date().toISOString(),
      });

      service.rebuildIndex('bot1');
      // Now generates index.html instead of INDEX.md
      const index = readFileSync(join(dir, 'index.html'), 'utf-8');
      expect(index).toContain('article.md');
    });

    test('omits plan section when no plan exists', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'article.md'), '# Test Article\n\nContent.', 'utf-8');
      service.writeSummary('bot1', {
        summary: 'Bot is writing.',
        generatedAt: new Date().toISOString(),
      });

      service.rebuildIndex('bot1');
      const index = readFileSync(join(dir, 'index.html'), 'utf-8');
      expect(index).toContain('article.md');
    });
  });

  describe('getFileDescription improvements', () => {
    test('uses extractDescription for richer descriptions', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(
        join(dir, 'analysis.md'),
        `# Market Analysis Q1 2026

The market showed unprecedented growth in the first quarter.

## Key Findings`,
        'utf-8'
      );

      service.rebuildIndex('bot1');
      const index = readFileSync(join(dir, 'index.html'), 'utf-8');
      expect(index).toContain('Market Analysis Q1 2026');
      expect(index).toContain('unprecedented growth');
    });

    test('strips number prefix from humanized filenames', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, '03_my-report.json'), '{"data": true}', 'utf-8');

      service.rebuildIndex('bot1');
      const index = readFileSync(join(dir, 'index.html'), 'utf-8');
      expect(index).toContain('My Report');
    });
  });

  describe('assessContentQuality', () => {
    test('detects empty content as template', () => {
      const result = ProductionsService.assessContentQuality('');
      expect(result.isTemplate).toBe(true);
      expect(result.ratio).toBe(0);
    });

    test('detects whitespace-only content as template', () => {
      const result = ProductionsService.assessContentQuality('   \n\n   ');
      expect(result.isTemplate).toBe(true);
      expect(result.ratio).toBe(0);
    });

    test('detects mostly-placeholder content as template', () => {
      const content = `# Section
## Title
## Overview
## Summary
- [ ]
- [ ]
- TBD
- TBD
Real content here`;
      const result = ProductionsService.assessContentQuality(content);
      expect(result.isTemplate).toBe(true);
      expect(result.ratio).toBeLessThan(0.3);
    });

    test('accepts real content with data', () => {
      const content = `# Vol Analysis Feb 2026

SPY implied vol is at 18.5%, below the 30-day realized vol of 22.1%.
This suggests options are underpriced relative to recent movement.

## Key Observations:
- Put/call ratio at 0.85 indicates moderate bullishness
- VIX term structure in contango, short-term complacency
- NVDA earnings Feb 23 could be a vol catalyst

## Position Sizing:
Based on Kelly criterion with 55% win rate and 2:1 payoff:
Optimal size = 12.5% of portfolio = $15,000 notional`;
      const result = ProductionsService.assessContentQuality(content);
      expect(result.isTemplate).toBe(false);
      expect(result.ratio).toBeGreaterThan(0.5);
    });

    test('detects separator-only lines', () => {
      const content = '---\n===\n***';
      const result = ProductionsService.assessContentQuality(content);
      expect(result.isTemplate).toBe(true);
    });

    test('handles mixed content and placeholders', () => {
      const content = `# Report
This is a real finding about market conditions.
## TODO
TBD
## Conclusion
The analysis shows significant opportunity.`;
      const result = ProductionsService.assessContentQuality(content);
      // 4 real lines, 2 placeholders (TODO heading, TBD) out of 6 non-blank lines
      expect(result.ratio).toBeGreaterThan(0.3);
      expect(result.isTemplate).toBe(false);
    });
  });

  describe('runCleanup (via rebuildIndex)', () => {
    const { utimesSync } = require('node:fs');

    /** Helper: create file, log it as production, backdate mtime so grace period doesn't skip it */
    function createTrackedFile(
      svc: ProductionsService,
      botId: string,
      relPath: string,
      content: string
    ) {
      const dir = svc.resolveDir(botId);
      const fullPath = join(dir, relPath);
      const dirPath = join(fullPath, '..');
      if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
      svc.logProduction({
        timestamp: new Date().toISOString(),
        botId,
        tool: 'file_write',
        path: relPath,
        action: 'create',
        description: `test: ${relPath}`,
        size: content.length,
        trackOnly: false,
      });
      // Backdate mtime by 2 minutes so grace period (60s) doesn't skip it
      const past = new Date(Date.now() - 120_000);
      utimesSync(fullPath, past, past);
    }

    test('archives tiny files (<50 bytes)', () => {
      const dir = service.resolveDir('bot1');
      createTrackedFile(service, 'bot1', 'tiny.md', 'hi');

      // Create a new service to reset throttle (logProduction already triggered one cleanup)
      const svc2 = new ProductionsService(makeConfig(), noopLogger);
      svc2.rebuildIndex('bot1');

      expect(existsSync(join(dir, 'tiny.md'))).toBe(false);
      expect(existsSync(join(dir, 'archived', 'tiny.md'))).toBe(true);
    });

    test('archives incoherent .md files', () => {
      const dir = service.resolveDir('bot1');
      createTrackedFile(
        service,
        'bot1',
        'incoherent.md',
        '# One\n## Two\n### Three\n#### Four\n##### Five\nShort.'
      );

      const svc2 = new ProductionsService(makeConfig(), noopLogger);
      svc2.rebuildIndex('bot1');

      expect(existsSync(join(dir, 'incoherent.md'))).toBe(false);
      expect(existsSync(join(dir, 'archived', 'incoherent.md'))).toBe(true);
    });

    test('archives duplicate files (keeps first)', () => {
      const dir = service.resolveDir('bot1');
      const content =
        '# Duplicate Content\n\nThis is a substantial piece of content that is duplicated across two files and should be long enough to avoid the tiny check and coherence checks.';
      createTrackedFile(service, 'bot1', 'original.md', content);
      createTrackedFile(service, 'bot1', 'copy.md', content);

      const svc2 = new ProductionsService(makeConfig(), noopLogger);
      svc2.rebuildIndex('bot1');

      // First file should survive, second should be archived
      const originalExists = existsSync(join(dir, 'original.md'));
      const copyExists = existsSync(join(dir, 'copy.md'));
      expect(originalExists || copyExists).toBe(true);
      expect(
        existsSync(join(dir, 'archived', 'original.md')) ||
          existsSync(join(dir, 'archived', 'copy.md'))
      ).toBe(true);
    });

    test('skips approved files during cleanup', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'approved_tiny.md'), 'ok', 'utf-8');

      // Log and approve this production
      const entry = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'approved_tiny.md',
        action: 'create',
        description: 'Approved tiny file',
        size: 2,
        trackOnly: false,
      });
      service.evaluate('bot1', entry.id, { status: 'approved' });

      // Backdate mtime so grace period doesn't skip it
      const past = new Date(Date.now() - 120_000);
      utimesSync(join(dir, 'approved_tiny.md'), past, past);

      // Force a fresh cleanup by creating a new service (resets throttle)
      const service2 = new ProductionsService(makeConfig(), noopLogger);
      service2.rebuildIndex('bot1');

      // File should NOT be archived because it's approved
      expect(existsSync(join(dir, 'approved_tiny.md'))).toBe(true);
    });

    test('throttle prevents cleanup from running twice in 1 hour', () => {
      const dir = service.resolveDir('bot1');
      createTrackedFile(service, 'bot1', 'small.md', 'x');

      // First rebuild on a fresh service — cleanup runs
      const svc2 = new ProductionsService(makeConfig(), noopLogger);
      svc2.rebuildIndex('bot1');
      expect(existsSync(join(dir, 'archived', 'small.md'))).toBe(true);

      // Create another tiny tracked file
      writeFileSync(join(dir, 'small2.md'), 'y', 'utf-8');
      svc2.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'small2.md',
        action: 'create',
        description: 'test',
        size: 1,
        trackOnly: false,
      });
      const past = new Date(Date.now() - 120_000);
      utimesSync(join(dir, 'small2.md'), past, past);

      // Second rebuild on SAME service — cleanup should be throttled
      svc2.rebuildIndex('bot1');
      // small2.md should still exist (cleanup didn't run again)
      expect(existsSync(join(dir, 'small2.md'))).toBe(true);
    });
  });

  describe('setCoherenceCheck', () => {
    test('saves coherent result to entry', () => {
      const entry = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'coherent.md',
        action: 'create',
        description: 'Coherent file',
        size: 100,
        trackOnly: false,
      });

      const result = service.setCoherenceCheck('bot1', entry.id, {
        coherent: true,
        issues: [],
        explanation: 'Content is well-formed',
      });

      expect(result).not.toBeNull();
      expect(result?.coherenceCheck).toBeDefined();
      expect(result?.coherenceCheck?.coherent).toBe(true);
      expect(result?.coherenceCheck?.issues).toEqual([]);
      expect(result?.coherenceCheck?.explanation).toBe('Content is well-formed');
      expect(result?.coherenceCheck?.checkedAt).toBeTruthy();
    });

    test('saves incoherent result with issues', () => {
      const entry = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'incoherent.md',
        action: 'create',
        description: 'Incoherent file',
        size: 50,
        trackOnly: false,
      });

      const result = service.setCoherenceCheck('bot1', entry.id, {
        coherent: false,
        issues: ['Missing conclusion', 'Abrupt topic shift'],
        explanation: 'Content has structural problems',
      });

      expect(result).not.toBeNull();
      expect(result?.coherenceCheck?.coherent).toBe(false);
      expect(result?.coherenceCheck?.issues).toEqual(['Missing conclusion', 'Abrupt topic shift']);
    });

    test('returns null for non-existent entry', () => {
      const result = service.setCoherenceCheck('bot1', 'non-existent-id', {
        coherent: true,
        issues: [],
      });
      expect(result).toBeNull();
    });

    test('persists in JSONL (survives re-read)', () => {
      const entry = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'persist-check.md',
        action: 'create',
        description: 'Persistence test',
        size: 80,
        trackOnly: false,
      });

      service.setCoherenceCheck('bot1', entry.id, {
        coherent: true,
        issues: [],
        explanation: 'Good',
      });

      // Re-read from disk
      const reloaded = service.getEntry('bot1', entry.id);
      expect(reloaded).not.toBeNull();
      expect(reloaded?.coherenceCheck).toBeDefined();
      expect(reloaded?.coherenceCheck?.coherent).toBe(true);
    });

    test('getStats counts checked entries', () => {
      const e1 = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'file1.md',
        action: 'create',
        description: 'File 1',
        size: 100,
        trackOnly: false,
      });
      service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'file2.md',
        action: 'create',
        description: 'File 2',
        size: 100,
        trackOnly: false,
      });

      // Only check first entry
      service.setCoherenceCheck('bot1', e1.id, { coherent: true, issues: [] });

      const stats = service.getStats('bot1');
      expect(stats.checked).toBe(1);
      expect(stats.total).toBe(2);
    });

    test('getDirectoryTree includes coherenceCheck in nodes', () => {
      const dir = service.resolveDir('bot1');
      writeFileSync(join(dir, 'checked-file.md'), '# Checked', 'utf-8');

      const entry = service.logProduction({
        timestamp: new Date().toISOString(),
        botId: 'bot1',
        tool: 'file_write',
        path: 'checked-file.md',
        action: 'create',
        description: 'Checked file',
        size: 10,
        trackOnly: false,
      });

      service.setCoherenceCheck('bot1', entry.id, {
        coherent: false,
        issues: ['Bad structure'],
      });

      const tree = service.getDirectoryTree('bot1');
      const node = tree.find((n) => n.name === 'checked-file.md');
      expect(node).toBeTruthy();
      expect(node?.coherenceCheck).toEqual({ coherent: false });
    });
  });

  describe('path traversal protection', () => {
    test('updateContent blocks path traversal via ../', () => {
      const entry = service.logProduction({
        botId: 'bot1',
        path: '../../../etc/shadow',
        title: 'Traversal attempt',
        status: 'unreviewed',
        createdAt: new Date().toISOString(),
      });

      const result = service.updateContent('bot1', entry.id, 'malicious content');
      expect(result).toBe(false);
    });

    test('updateContent blocks absolute path outside production dir', () => {
      const entry = service.logProduction({
        botId: 'bot1',
        path: '/tmp/evil-file.txt',
        title: 'Absolute traversal',
        status: 'unreviewed',
        createdAt: new Date().toISOString(),
      });

      const result = service.updateContent('bot1', entry.id, 'malicious content');
      expect(result).toBe(false);
    });

    test('getFileContent returns null for path traversal', () => {
      const entry = service.logProduction({
        botId: 'bot1',
        path: '../../../etc/passwd',
        title: 'Read traversal',
        status: 'unreviewed',
        createdAt: new Date().toISOString(),
      });

      const content = service.getFileContent('bot1', entry.id);
      expect(content).toBeNull();
    });

    test('updateContent allows paths within production dir', () => {
      const entry = service.logProduction({
        botId: 'bot1',
        path: 'safe/nested/file.md',
        title: 'Safe path',
        status: 'unreviewed',
        createdAt: new Date().toISOString(),
      });

      const result = service.updateContent('bot1', entry.id, 'safe content');
      expect(result).toBe(true);

      const content = service.getFileContent('bot1', entry.id);
      expect(content).toBe('safe content');
    });
  });
});
