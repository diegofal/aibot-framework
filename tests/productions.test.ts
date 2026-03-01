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
});
