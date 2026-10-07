import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager, unflushedMessageCount } from '../src/session';

const TEST_DIR = join(import.meta.dir, '.tmp-session-flush-counter');

function makeLogger() {
  return {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    child: () => makeLogger(),
  } as any;
}

const msg = (content: string) => ({ role: 'user' as const, content });

describe('messages since the last memory flush', () => {
  let manager: SessionManager;
  const key = 'bot-finny:private:42';

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    manager = new SessionManager(
      {
        enabled: true,
        dataDir: TEST_DIR,
        maxHistoryLength: 100,
        compaction: { enabled: false, threshold: 50 },
        ttl: {},
        reset: {},
      } as any,
      makeLogger()
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('counts appended messages and restarts at zero after a flush', () => {
    manager.appendMessages(key, [msg('a'), msg('b')], 100);
    expect(unflushedMessageCount(manager.getSessionMeta(key))).toBe(2);

    manager.markMemoryFlushed(key);
    expect(unflushedMessageCount(manager.getSessionMeta(key))).toBe(0);

    manager.appendMessages(key, [msg('c'), msg('d'), msg('e')], 100);
    expect(unflushedMessageCount(manager.getSessionMeta(key))).toBe(3);
  });

  test('a second batch of messages is flushed again without waiting for a compaction', () => {
    manager.appendMessages(key, [msg('1'), msg('2'), msg('3'), msg('4'), msg('5')], 100);
    manager.markMemoryFlushed(key);
    manager.appendMessages(key, [msg('6'), msg('7'), msg('8'), msg('9'), msg('10')], 100);
    expect(unflushedMessageCount(manager.getSessionMeta(key))).toBeGreaterThanOrEqual(5);
  });

  test('legacy metadata without the counter falls back to the message count', () => {
    // Sessions saved before the counter existed, already flushed at their
    // compaction index: they used to never flush again.
    expect(
      unflushedMessageCount({
        messageCount: 20,
        compactionCount: 0,
        lastFlushCompactionIndex: 0,
      } as any)
    ).toBe(20);
    expect(unflushedMessageCount(undefined)).toBe(0);
  });
});
