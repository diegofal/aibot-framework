import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolAuditLog, type ToolAuditEntry } from '../../src/bot/tool-audit-log';

function makeLogger() {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    child: () => makeLogger(),
  } as any;
}

function makeEntry(overrides?: Partial<ToolAuditEntry>): ToolAuditEntry {
  return {
    timestamp: '2026-02-25T12:00:00.000Z',
    botId: 'bot1',
    chatId: 123,
    toolName: 'file_write',
    args: { path: '/tmp/test.txt' },
    success: true,
    result: 'File written successfully',
    durationMs: 42,
    retryAttempts: 0,
    ...overrides,
  };
}

describe('ToolAuditLog', () => {
  let tmpDir: string;
  let log: ToolAuditLog;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-log-'));
    log = new ToolAuditLog(tmpDir, makeLogger());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('append creates bot directory and JSONL file', () => {
    const entry = makeEntry();
    log.append(entry);

    const filePath = join(tmpDir, 'bot1', '2026-02-25.jsonl');
    expect(existsSync(filePath)).toBe(true);
  });

  test('getEntries reads back appended entries', () => {
    log.append(makeEntry({ toolName: 'file_write' }));
    log.append(makeEntry({ toolName: 'exec', success: false, result: 'Command failed' }));

    const entries = log.getEntries('bot1', '2026-02-25');
    expect(entries).toHaveLength(2);
    expect(entries[0].toolName).toBe('file_write');
    expect(entries[1].toolName).toBe('exec');
    expect(entries[1].success).toBe(false);
  });

  test('getEntries returns empty for missing date', () => {
    expect(log.getEntries('bot1', '2026-01-01')).toEqual([]);
  });

  test('getEntries returns empty for missing bot', () => {
    expect(log.getEntries('nonexistent', '2026-02-25')).toEqual([]);
  });

  test('getAvailableDates returns sorted dates newest first', () => {
    log.append(makeEntry({ timestamp: '2026-02-23T10:00:00.000Z' }));
    log.append(makeEntry({ timestamp: '2026-02-25T10:00:00.000Z' }));
    log.append(makeEntry({ timestamp: '2026-02-24T10:00:00.000Z' }));

    const dates = log.getAvailableDates('bot1');
    expect(dates).toEqual(['2026-02-25', '2026-02-24', '2026-02-23']);
  });

  test('getAvailableDates returns empty for missing bot', () => {
    expect(log.getAvailableDates('nonexistent')).toEqual([]);
  });

  test('entries for different bots are isolated', () => {
    log.append(makeEntry({ botId: 'bot1', toolName: 'file_write' }));
    log.append(makeEntry({ botId: 'bot2', toolName: 'exec' }));

    expect(log.getEntries('bot1', '2026-02-25')).toHaveLength(1);
    expect(log.getEntries('bot2', '2026-02-25')).toHaveLength(1);
    expect(log.getEntries('bot1', '2026-02-25')[0].toolName).toBe('file_write');
    expect(log.getEntries('bot2', '2026-02-25')[0].toolName).toBe('exec');
  });

  test('entries for different dates are isolated', () => {
    log.append(makeEntry({ timestamp: '2026-02-24T10:00:00.000Z', toolName: 'file_read' }));
    log.append(makeEntry({ timestamp: '2026-02-25T10:00:00.000Z', toolName: 'file_write' }));

    expect(log.getEntries('bot1', '2026-02-24')).toHaveLength(1);
    expect(log.getEntries('bot1', '2026-02-25')).toHaveLength(1);
  });
});
