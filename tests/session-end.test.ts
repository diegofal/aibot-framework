import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '../src/session';

const TEST_DIR = join(import.meta.dir, '.tmp-session-end');

function makeLogger() {
  return {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    child: () => makeLogger(),
  } as any;
}

function makeManager() {
  return new SessionManager(
    {
      enabled: true,
      dataDir: TEST_DIR,
      resetPolicy: { daily: { enabled: false, hour: 4 }, idle: { enabled: false, minutes: 60 } },
      replyWindow: 0,
    } as any,
    makeLogger()
  );
}

const user = (content: string) => ({ role: 'user' as const, content });
const bot = (content: string) => ({ role: 'assistant' as const, content });

describe('SessionManager.endSession', () => {
  const key = 'bot:finny:private:42';
  let manager: SessionManager;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    manager = makeManager();
    await manager.initialize();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('returns nothing and records nothing for an empty session', () => {
    expect(manager.endSession(key, 'command')).toBeNull();
    expect(manager.getEndedSession(key)).toBeUndefined();
  });

  test('hands back the full history and clears the transcript', () => {
    manager.appendMessages(key, [user('hola'), bot('¡hola!')], 100);

    const result = manager.endSession(key, 'idle');

    expect(result?.history.map((m) => m.content)).toEqual(['hola', '¡hola!']);
    expect(manager.getFullHistory(key)).toEqual([]);
    expect(manager.getSessionMeta(key)).toBeUndefined();
  });

  test('records when it ended, why, and the last exchanges', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => (i % 2 ? bot(`b${i}`) : user(`u${i}`)));
    manager.appendMessages(key, msgs, 100);
    const lastActivityAt = manager.getSessionMeta(key)?.lastActivityAt;

    const ended = manager.endSession(key, 'daily', new Date('2026-10-11T15:00:00Z'))?.ended;

    expect(ended?.reason).toBe('daily');
    expect(ended?.endedAt).toBe('2026-10-11T15:00:00.000Z');
    expect(ended?.lastActivityAt).toBe(lastActivityAt);
    expect(ended?.messageCount).toBe(10);
    expect(ended?.tail.map((m) => m.content)).toEqual(['u4', 'b5', 'u6', 'b7', 'u8', 'b9']);
    expect(manager.getEndedSession(key)).toEqual(ended);
  });

  test('keeps the compaction summary and truncates long messages in the record', () => {
    manager.rewriteWithSummary(key, { role: 'system', content: '[CONTEXT_SUMMARY] notas de Die' }, [
      user('x'.repeat(1000)),
    ]);

    const ended = manager.endSession(key, 'command')?.ended;

    expect(ended?.summary).toBe('notas de Die');
    expect(ended?.tail[0].content.length).toBeLessThanOrEqual(401);
    expect(ended?.tail[0].content.endsWith('…')).toBe(true);
  });

  test('persists the record across restarts', async () => {
    manager.appendMessages(key, [user('hola')], 100);
    manager.endSession(key, 'command');

    const reloaded = makeManager();
    await reloaded.initialize();

    expect(reloaded.getEndedSession(key)?.tail[0].content).toBe('hola');
  });

  test('a bot reset drops its ended-session records, not other bots', () => {
    manager.appendMessages(key, [user('hola')], 100);
    manager.endSession(key, 'command');
    manager.appendMessages('bot:other:private:42', [user('hey')], 100);
    manager.endSession('bot:other:private:42', 'command');

    manager.clearBotSessions('finny');

    expect(manager.getEndedSession(key)).toBeUndefined();
    expect(manager.getEndedSession('bot:other:private:42')).toBeDefined();
  });
});

describe('SessionManager.expiryReason', () => {
  const key = 'bot:finny:private:42';

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  function managerWith(resetPolicy: unknown) {
    return new SessionManager(
      { enabled: true, dataDir: TEST_DIR, resetPolicy, replyWindow: 0 } as any,
      makeLogger()
    );
  }

  function ageSession(m: SessionManager, ms: number) {
    m.appendMessages(key, [user('hola')], 100);
    const meta = m.getSessionMeta(key)!;
    meta.lastActivityAt = new Date(Date.now() - ms).toISOString();
  }

  test('is null for an unknown session', () => {
    const m = managerWith({
      daily: { enabled: true, hour: 4 },
      idle: { enabled: true, minutes: 1 },
    });
    expect(m.expiryReason(key)).toBeNull();
  });

  test('reports idle once the idle window passed', () => {
    const m = managerWith({
      daily: { enabled: false, hour: 4 },
      idle: { enabled: true, minutes: 60 },
    });
    ageSession(m, 61 * 60_000);
    expect(m.expiryReason(key)).toBe('idle');
    expect(m.isExpired(key)).toBe(true);
  });

  test('reports daily for a session last active days ago', () => {
    const m = managerWith({
      daily: { enabled: true, hour: 4 },
      idle: { enabled: false, minutes: 60 },
    });
    ageSession(m, 3 * 86_400_000);
    expect(m.expiryReason(key)).toBe('daily');
  });

  test('is null while no policy fires', () => {
    const m = managerWith({
      daily: { enabled: false, hour: 4 },
      idle: { enabled: false, minutes: 60 },
    });
    ageSession(m, 30 * 86_400_000);
    expect(m.expiryReason(key)).toBeNull();
  });
});
