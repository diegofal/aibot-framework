import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '../src/session';

const TEST_DIR = join(import.meta.dir, '.tmp-session-isolation');

function makeLogger() {
  return {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    child: () => makeLogger(),
  } as any;
}

function makeSessionConfig(dataDir: string) {
  return {
    enabled: true,
    dataDir,
    maxHistoryLength: 100,
    compaction: { enabled: false, threshold: 50 },
    ttl: {},
    reset: {},
  } as any;
}

describe('Session transcript per-bot isolation', () => {
  let manager: SessionManager;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    manager = new SessionManager(makeSessionConfig(TEST_DIR), makeLogger());
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('new transcripts are written to per-bot subdirectory', () => {
    const key = manager.serializeKey({
      botId: 'bot-alpha',
      chatType: 'private',
      chatId: 123,
      userId: 456,
    });

    // Append a message to create the transcript file
    manager.appendMessages(key, [{ role: 'user', content: 'hello' }], 100);

    // Verify it went to the per-bot subdirectory
    const expectedDir = join(TEST_DIR, 'transcripts', 'bot-alpha');
    expect(existsSync(expectedDir)).toBe(true);
  });

  test('different bots write to different subdirectories', () => {
    const keyA = manager.serializeKey({
      botId: 'bot-a',
      chatType: 'private',
      chatId: 100,
      userId: 1,
    });
    const keyB = manager.serializeKey({
      botId: 'bot-b',
      chatType: 'private',
      chatId: 100,
      userId: 1,
    });

    manager.appendMessages(keyA, [{ role: 'user', content: 'from A' }], 100);
    manager.appendMessages(keyB, [{ role: 'user', content: 'from B' }], 100);

    expect(existsSync(join(TEST_DIR, 'transcripts', 'bot-a'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'transcripts', 'bot-b'))).toBe(true);

    // Read back and verify isolation
    const historyA = manager.getFullHistory(keyA);
    const historyB = manager.getFullHistory(keyB);
    expect(historyA).toHaveLength(1);
    expect(historyB).toHaveLength(1);
    expect(historyA[0].content).toBe('from A');
    expect(historyB[0].content).toBe('from B');
  });

  test('backward compat: reads old flat transcript if per-bot path does not exist', () => {
    // Create an old-style flat transcript
    const key = 'bot:legacy-bot:private:999';
    const flatDir = join(TEST_DIR, 'transcripts');
    mkdirSync(flatDir, { recursive: true });
    const flatFile = join(flatDir, 'bot-legacy-bot-private-999.jsonl');
    writeFileSync(flatFile, '{"role":"user","content":"old message"}\n');

    const history = manager.getFullHistory(key);
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('old message');
  });
});
