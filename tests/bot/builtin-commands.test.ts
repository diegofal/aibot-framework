import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { registerBuiltinCommands } from '../../src/bot/builtin-commands';
import { SessionManager } from '../../src/session';

const TEST_DIR = join(import.meta.dir, '.tmp-builtin-commands');
const KEY = 'bot:finny:private:42';

const logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
} as any;

type Handler = (ctx: any) => Promise<void>;

describe('session commands', () => {
  let handlers: Map<string, Handler>;
  let sessionManager: SessionManager;
  let flush: ReturnType<typeof jest.fn>;
  let startConversation: ReturnType<typeof jest.fn>;

  function register(opts: { allowedUsers?: number[]; withStarter?: boolean } = {}) {
    handlers = new Map();
    const bot = { command: (name: string, fn: Handler) => handlers.set(name, fn) };
    registerBuiltinCommands(
      bot as any,
      { id: 'finny', name: 'Finny', allowedUsers: opts.allowedUsers } as any,
      {
        ctx: {
          sessionManager,
          config: { soul: { enabled: true } },
          logger,
        } as any,
        memoryFlusher: { flushSessionToMemory: flush } as any,
        startConversation: opts.withStarter === false ? undefined : startConversation,
      }
    );
  }

  function telegramCtx(userId = 42, match = '') {
    return {
      from: { id: userId },
      chat: { id: userId, type: 'private' },
      message: { text: '' },
      match,
      reply: jest.fn().mockResolvedValue(undefined),
    };
  }

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
    sessionManager.appendMessages(
      KEY,
      [
        { role: 'user', content: 'tengo que ordenar las notas' },
        { role: 'assistant', content: 'lo de las notas puede esperar' },
      ],
      100
    );
    flush = jest.fn().mockResolvedValue(undefined);
    startConversation = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  for (const command of ['new', 'reset', 'start']) {
    test(`/${command} ends the conversation, saves it, and opens a fresh one`, async () => {
      register();
      const ctx = telegramCtx();

      await handlers.get(command)?.(ctx);

      expect(sessionManager.getFullHistory(KEY)).toEqual([]);
      expect(sessionManager.getEndedSession(KEY)?.reason).toBe('command');
      expect(flush).toHaveBeenCalledTimes(1);
      expect(flush.mock.calls[0][2]).toBe('42');
      expect(startConversation).toHaveBeenCalledWith(ctx, `/${command}`);
    });
  }

  test('/start with nothing to end still opens a fresh conversation', async () => {
    sessionManager.clearSession(KEY);
    register();
    const ctx = telegramCtx();

    await handlers.get('start')?.(ctx);

    expect(flush).not.toHaveBeenCalled();
    expect(startConversation).toHaveBeenCalledWith(ctx, '/start');
  });

  test('/start falls back to the static welcome if the greeting fails', async () => {
    startConversation.mockRejectedValue(new Error('llm down'));
    register();
    const ctx = telegramCtx();

    await handlers.get('start')?.(ctx);

    expect(ctx.reply.mock.calls[0][0]).toContain('Welcome to Finny');
  });

  test('/new without a greeter confirms in plain text', async () => {
    register({ withStarter: false });
    const ctx = telegramCtx();

    await handlers.get('new')?.(ctx);

    expect(ctx.reply.mock.calls[0][0]).toContain('New conversation');
  });

  test('an unauthorized /start gets the static welcome and touches nothing', async () => {
    register({ allowedUsers: [7] });
    const ctx = telegramCtx(42);

    await handlers.get('start')?.(ctx);

    expect(sessionManager.getFullHistory(KEY)).toHaveLength(2);
    expect(startConversation).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0][0]).toContain('Welcome to Finny');
  });

  test('an unauthorized /new is refused', async () => {
    register({ allowedUsers: [7] });
    const ctx = telegramCtx(42);

    await handlers.get('new')?.(ctx);

    expect(sessionManager.getFullHistory(KEY)).toHaveLength(2);
    expect(ctx.reply).toHaveBeenCalledWith('⛔ Unauthorized');
  });

  test('/clear ends the conversation and remembers how it left off', async () => {
    register();
    const ctx = telegramCtx();

    await handlers.get('clear')?.(ctx);

    expect(sessionManager.getFullHistory(KEY)).toEqual([]);
    expect(sessionManager.getEndedSession(KEY)).toBeDefined();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(startConversation).not.toHaveBeenCalled();
  });

  test('/clear --no-flush skips the memory flush', async () => {
    register();

    await handlers.get('clear')?.(telegramCtx(42, '--no-flush'));

    expect(flush).not.toHaveBeenCalled();
    expect(sessionManager.getFullHistory(KEY)).toEqual([]);
  });
});
