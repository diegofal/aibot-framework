import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSessionStartPrompt,
  endConversation,
  humanizeAgo,
  renderPreviousSession,
  shouldShowPreviousSession,
} from '../src/bot/session-continuity';
import type { ChatMessage } from '../src/ollama';
import { type EndedSession, SessionManager } from '../src/session';

const TEST_DIR = join(import.meta.dir, '.tmp-session-continuity');

const logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
} as any;

const ended: EndedSession = {
  startedAt: '2026-10-03T20:00:00.000Z',
  lastActivityAt: '2026-10-03T21:10:00.000Z',
  endedAt: '2026-10-11T15:50:00.000Z',
  reason: 'daily',
  messageCount: 12,
  summary: 'Die estaba ordenando sus notas.',
  tail: [
    { role: 'user', content: '[Fri 2026-10-03 18:10 · +2m] Sigo con las notas mañana' },
    { role: 'assistant', content: 'Dale, lo de las notas puede esperar.' },
  ],
};

describe('humanizeAgo', () => {
  test('minutes, hours, days', () => {
    expect(humanizeAgo(40 * 60_000)).toBe('40 minutes ago');
    expect(humanizeAgo(5 * 3_600_000)).toBe('5 hours ago');
    expect(humanizeAgo(8 * 86_400_000)).toBe('8 days ago');
  });
  test('singular and just-now', () => {
    expect(humanizeAgo(30_000)).toBe('just now');
    expect(humanizeAgo(3_600_000)).toBe('1 hour ago');
    expect(humanizeAgo(86_400_000 + 1)).toBe('1 day ago');
  });
});

describe('renderPreviousSession', () => {
  const now = new Date('2026-10-11T15:50:00.000Z');
  const block = renderPreviousSession(ended, now);

  test('says this is a new conversation and how long ago the last one was', () => {
    expect(block).toContain('## Previous conversation');
    expect(block).toContain('This is a new conversation');
    expect(block).toContain('7 days ago');
  });

  test('includes the summary and the tail without stored envelopes', () => {
    expect(block).toContain('Die estaba ordenando sus notas.');
    expect(block).toContain('- them: Sigo con las notas mañana');
    expect(block).toContain('- you: Dale, lo de las notas puede esperar.');
    expect(block).not.toContain('+2m]');
  });

  test('tells the model not to resume old topics by itself', () => {
    expect(block).toMatch(/do not pick up/i);
  });
});

describe('shouldShowPreviousSession', () => {
  test('only early in the new conversation', () => {
    expect(shouldShowPreviousSession(0)).toBe(true);
    expect(shouldShowPreviousSession(9)).toBe(true);
    expect(shouldShowPreviousSession(10)).toBe(false);
  });
});

describe('buildSessionStartPrompt', () => {
  test('asks for a short in-persona greeting without resuming old topics', () => {
    const prompt = buildSessionStartPrompt('/new');
    expect(prompt).toContain('/new');
    expect(prompt).toMatch(/greet/i);
    expect(prompt).toMatch(/do not pick up/i);
  });
});

describe('endConversation', () => {
  const key = 'bot:finny:private:42';
  let sessionManager: SessionManager;
  let flushed: Array<{ history: ChatMessage[]; userId?: string; observedAt?: string }>;
  const memoryFlusher = {
    flushSessionToMemory: async (
      history: ChatMessage[],
      _botId: string,
      userId?: string,
      options?: { observedAt?: string }
    ) => {
      flushed.push({ history, userId, observedAt: options?.observedAt });
    },
  };

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    sessionManager = new SessionManager(
      {
        enabled: true,
        dataDir: TEST_DIR,
        resetPolicy: { daily: { enabled: false, hour: 4 }, idle: { enabled: false, minutes: 60 } },
        replyWindow: 0,
      } as any,
      logger
    );
    await sessionManager.initialize();
    flushed = [];
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  const deps = (soulEnabled = true) => ({
    sessionManager,
    memoryFlusher: memoryFlusher as any,
    soulEnabled,
    logger,
  });

  test('flushes only what the proactive flush has not seen, dated by the last message', async () => {
    sessionManager.appendMessages(key, [{ role: 'user', content: 'old' }], 100);
    sessionManager.markMemoryFlushed(key);
    sessionManager.appendMessages(key, [{ role: 'user', content: 'new' }], 100);
    const lastActivityAt = sessionManager.getSessionMeta(key)?.lastActivityAt;

    const result = await endConversation(deps(), {
      botId: 'finny',
      serializedKey: key,
      reason: 'idle',
      memoryUserId: '42',
    });

    expect(result?.reason).toBe('idle');
    expect(flushed).toHaveLength(1);
    expect(flushed[0].history.map((m) => m.content)).toEqual(['new']);
    expect(flushed[0].userId).toBe('42');
    expect(flushed[0].observedAt).toBe(lastActivityAt);
    expect(sessionManager.getFullHistory(key)).toEqual([]);
  });

  test('skips the flush when everything was already flushed', async () => {
    sessionManager.appendMessages(key, [{ role: 'user', content: 'old' }], 100);
    sessionManager.markMemoryFlushed(key);

    await endConversation(deps(), { botId: 'finny', serializedKey: key, reason: 'command' });

    expect(flushed).toHaveLength(0);
    expect(sessionManager.getEndedSession(key)).toBeDefined();
  });

  test('skips the flush when asked, or when soul is off', async () => {
    sessionManager.appendMessages(key, [{ role: 'user', content: 'a' }], 100);
    await endConversation(deps(), {
      botId: 'finny',
      serializedKey: key,
      reason: 'command',
      flush: false,
    });
    sessionManager.appendMessages(key, [{ role: 'user', content: 'b' }], 100);
    await endConversation(deps(false), { botId: 'finny', serializedKey: key, reason: 'command' });

    expect(flushed).toHaveLength(0);
  });

  test('a failing flush does not stop the conversation from ending', async () => {
    sessionManager.appendMessages(key, [{ role: 'user', content: 'a' }], 100);
    const failing = {
      ...deps(),
      memoryFlusher: {
        flushSessionToMemory: async () => {
          throw new Error('llm down');
        },
      } as any,
    };

    const result = await endConversation(failing, {
      botId: 'finny',
      serializedKey: key,
      reason: 'command',
    });

    expect(result).not.toBeNull();
    expect(sessionManager.getFullHistory(key)).toEqual([]);
  });

  test('returns null for a chat with no conversation', async () => {
    expect(
      await endConversation(deps(), { botId: 'finny', serializedKey: key, reason: 'command' })
    ).toBeNull();
  });
});
