import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type LlmQueryEntry, LlmQueryLog } from '../src/bot/llm-query-log';

const TEST_DIR = join(import.meta.dir, '.tmp-llm-query-log');

function makeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => makeLogger(),
  } as unknown as import('../src/logger').Logger;
}

function makeEntry(overrides: Partial<LlmQueryEntry> = {}): LlmQueryEntry {
  return {
    timestamp: '2026-03-14T10:00:00.000Z',
    botId: 'test-bot',
    caller: 'conversation',
    model: 'claude-sonnet-4-6',
    backend: 'claude-cli',
    durationMs: 1500,
    success: true,
    ...overrides,
  };
}

describe('LlmQueryLog', () => {
  let log: LlmQueryLog;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    log = new LlmQueryLog(TEST_DIR, makeLogger());
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('append creates JSONL file and getEntries reads it back', () => {
    const entry = makeEntry({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    log.append(entry);

    const entries = log.getEntries('test-bot', '2026-03-14');
    expect(entries).toHaveLength(1);
    expect(entries[0].caller).toBe('conversation');
    expect(entries[0].model).toBe('claude-sonnet-4-6');
    expect(entries[0].promptTokens).toBe(100);
    expect(entries[0].success).toBe(true);
  });

  test('append multiple entries to same day', () => {
    log.append(makeEntry({ caller: 'planner' }));
    log.append(makeEntry({ caller: 'executor' }));
    log.append(makeEntry({ caller: 'strategist' }));

    const entries = log.getEntries('test-bot', '2026-03-14');
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.caller)).toEqual(['planner', 'executor', 'strategist']);
  });

  test('getEntries returns empty array for missing date', () => {
    const entries = log.getEntries('test-bot', '2020-01-01');
    expect(entries).toEqual([]);
  });

  test('getEntries returns empty array for missing bot', () => {
    const entries = log.getEntries('nonexistent', '2026-03-14');
    expect(entries).toEqual([]);
  });

  test('getAvailableDates returns dates sorted newest first', () => {
    log.append(makeEntry({ timestamp: '2026-03-12T10:00:00Z' }));
    log.append(makeEntry({ timestamp: '2026-03-14T10:00:00Z' }));
    log.append(makeEntry({ timestamp: '2026-03-13T10:00:00Z' }));

    const dates = log.getAvailableDates('test-bot');
    expect(dates).toEqual(['2026-03-14', '2026-03-13', '2026-03-12']);
  });

  test('getAvailableDates returns empty for unknown bot', () => {
    expect(log.getAvailableDates('unknown')).toEqual([]);
  });

  test('clearForBot removes all files', () => {
    log.append(makeEntry());
    expect(log.getEntries('test-bot', '2026-03-14')).toHaveLength(1);

    const cleared = log.clearForBot('test-bot');
    expect(cleared).toBe(true);
    expect(log.getEntries('test-bot', '2026-03-14')).toEqual([]);
    expect(log.getAvailableDates('test-bot')).toEqual([]);
  });

  test('clearForBot returns false for non-existent bot', () => {
    expect(log.clearForBot('nonexistent')).toBe(false);
  });

  test('malformed lines are skipped', () => {
    const botDir = join(TEST_DIR, 'test-bot');
    mkdirSync(botDir, { recursive: true });
    const filePath = join(botDir, '2026-03-14.jsonl');

    const validEntry = JSON.stringify(makeEntry());
    writeFileSync(filePath, `${validEntry}\nNOT_VALID_JSON\n${validEntry}\n`, 'utf-8');

    const entries = log.getEntries('test-bot', '2026-03-14');
    expect(entries).toHaveLength(2);
  });

  test('entries with error field are preserved', () => {
    log.append(makeEntry({ success: false, error: 'Rate limit exceeded' }));

    const entries = log.getEntries('test-bot', '2026-03-14');
    expect(entries[0].success).toBe(false);
    expect(entries[0].error).toBe('Rate limit exceeded');
  });

  test('different bots have separate log files', () => {
    log.append(makeEntry({ botId: 'bot-a' }));
    log.append(makeEntry({ botId: 'bot-b' }));

    expect(log.getEntries('bot-a', '2026-03-14')).toHaveLength(1);
    expect(log.getEntries('bot-b', '2026-03-14')).toHaveLength(1);
  });

  test('all caller types are accepted', () => {
    const callers: LlmQueryEntry['caller'][] = [
      'conversation',
      'planner',
      'strategist',
      'executor',
      'memory_flush',
      'compaction',
      'overflow_retry',
      'topic_guard',
    ];
    for (const caller of callers) {
      log.append(makeEntry({ caller }));
    }
    const entries = log.getEntries('test-bot', '2026-03-14');
    expect(entries).toHaveLength(callers.length);
  });
});
