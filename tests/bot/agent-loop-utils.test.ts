import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  type RecentAction,
  buildRecentActionsDigest,
  isRepetitiveAction,
  isSimilarSummary,
  logToMemory,
  scanFileTree,
} from '../../src/bot/agent-loop-utils';

describe('buildRecentActionsDigest', () => {
  it('returns null for empty actions', () => {
    expect(buildRecentActionsDigest([])).toBeNull();
  });

  it('builds a digest with recent actions', () => {
    const actions: RecentAction[] = [
      {
        cycle: 1,
        timestamp: Date.now() - 3_600_000,
        tools: ['save_memory'],
        planSummary: 'check messages',
      },
      {
        cycle: 2,
        timestamp: Date.now() - 1_800_000,
        tools: ['file_write'],
        planSummary: 'write poem',
      },
    ];
    const digest = buildRecentActionsDigest(actions)!;
    expect(digest).toContain('## Recent Actions');
    expect(digest).toContain('check messages');
    expect(digest).toContain('write poem');
    expect(digest).toContain('save_memory');
  });

  it('marks repeated actions', () => {
    const actions: RecentAction[] = [
      { cycle: 1, timestamp: Date.now(), tools: [], planSummary: 'same thing' },
      { cycle: 2, timestamp: Date.now(), tools: [], planSummary: 'same thing' },
      { cycle: 3, timestamp: Date.now(), tools: [], planSummary: 'same thing' },
    ];
    const digest = buildRecentActionsDigest(actions)!;
    expect(digest).toContain('REPEATED x3');
    expect(digest).toContain('EXHAUSTED PATTERNS');
  });
});

describe('isSimilarSummary', () => {
  it('returns false for empty strings', () => {
    expect(isSimilarSummary('', 'hello')).toBe(false);
    expect(isSimilarSummary('hello', '')).toBe(false);
  });

  it('returns true for identical summaries', () => {
    expect(isSimilarSummary('hello world', 'hello world')).toBe(true);
  });

  it('ignores timestamps', () => {
    expect(
      isSimilarSummary('action at 2026-02-22T10:00:00Z', 'action at 2026-02-22T11:00:00Z')
    ).toBe(true);
  });

  it('ignores case and whitespace', () => {
    expect(isSimilarSummary('Hello  World', 'hello world')).toBe(true);
  });

  it('returns false for different content', () => {
    expect(isSimilarSummary('hello', 'goodbye')).toBe(false);
  });
});

describe('isRepetitiveAction', () => {
  it('returns false when action appears less than 3 times', () => {
    const actions: RecentAction[] = [
      { cycle: 1, timestamp: Date.now(), tools: [], planSummary: 'check status' },
      { cycle: 2, timestamp: Date.now(), tools: [], planSummary: 'check status' },
    ];
    expect(isRepetitiveAction(actions, 'check status')).toBe(false);
  });

  it('returns true when action appears 3+ times', () => {
    const actions: RecentAction[] = [
      { cycle: 1, timestamp: Date.now(), tools: [], planSummary: 'check status' },
      { cycle: 2, timestamp: Date.now(), tools: [], planSummary: 'check status' },
      { cycle: 3, timestamp: Date.now(), tools: [], planSummary: 'check status' },
    ];
    expect(isRepetitiveAction(actions, 'check status')).toBe(true);
  });
});

describe('scanFileTree', () => {
  const testDir = join(tmpdir(), `agent-loop-utils-test-${Date.now()}`);

  afterAll(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it('returns null for non-existent directory', () => {
    expect(scanFileTree('/nonexistent/path/abc')).toBeNull();
  });

  it('returns null for empty directory', () => {
    mkdirSync(testDir, { recursive: true });
    const emptyDir = join(testDir, 'empty');
    mkdirSync(emptyDir);
    expect(scanFileTree(emptyDir)).toBeNull();
  });

  it('scans files and directories', () => {
    const dir = join(testDir, 'populated');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'file.txt'), 'hello');
    writeFileSync(join(dir, 'sub', 'nested.md'), 'world');

    const result = scanFileTree(dir)!;
    expect(result).toContain('file.txt');
    expect(result).toContain('sub/');
    expect(result).toContain('nested.md');
  });
});

describe('logToMemory', () => {
  it('truncates summaries over 500 chars', () => {
    const appendDailyMemory = vi.fn();
    const mockCtx = {
      soulLoaders: new Map([['bot1', { appendDailyMemory }]]),
      logger: { warn: vi.fn() },
    } as any;

    logToMemory(mockCtx, 'bot1', 'a'.repeat(600));
    expect(appendDailyMemory).toHaveBeenCalledTimes(1);
    const logged = appendDailyMemory.mock.calls[0][0] as string;
    expect(logged.length).toBeLessThan(520); // "[agent-loop] " + 500 + "..."
    expect(logged).toContain('...');
  });

  it('skips silently when soulLoader is missing (bot stopped mid-execution)', () => {
    const mockCtx = {
      soulLoaders: new Map(),
      logger: { warn: vi.fn() },
    } as any;

    logToMemory(mockCtx, 'bot1', 'test');
    expect(mockCtx.logger.warn).not.toHaveBeenCalled();
  });

  it('handles appendDailyMemory errors gracefully', () => {
    const mockCtx = {
      soulLoaders: new Map([
        [
          'bot1',
          {
            appendDailyMemory: () => {
              throw new Error('disk full');
            },
          },
        ],
      ]),
      logger: { warn: vi.fn() },
    } as any;

    logToMemory(mockCtx, 'bot1', 'test');
    expect(mockCtx.logger.warn).toHaveBeenCalled();
  });
});
