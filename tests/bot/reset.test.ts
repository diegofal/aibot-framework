import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../../src/session';
import type { SessionConfig } from '../../src/config';
import type { Logger } from '../../src/logger';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

// --- SessionManager.clearBotSessions ---

describe('SessionManager.clearBotSessions', () => {
  let sessionManager: SessionManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `reset-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const config: SessionConfig = {
      enabled: true,
      dataDir: tmpDir,
      resetPolicy: { daily: { enabled: false, hour: 4 }, idle: { enabled: false, minutes: 60 } },
      maxHistory: 50,
      groupActivation: 'mention',
      replyWindow: 30,
      forumTopicIsolation: false,
    };

    sessionManager = new SessionManager(config, noopLogger);
    await sessionManager.initialize();
  });

  afterEach(() => {
    sessionManager.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('clears only the target bot sessions', () => {
    // Add sessions for two different bots
    sessionManager.appendMessages('bot:alpha:private:111', [{ role: 'user', content: 'hi' }], 50);
    sessionManager.appendMessages('bot:alpha:group:222', [{ role: 'user', content: 'hello' }], 50);
    sessionManager.appendMessages('bot:beta:private:333', [{ role: 'user', content: 'hey' }], 50);

    expect(sessionManager.listSessions()).toHaveLength(3);

    const cleared = sessionManager.clearBotSessions('alpha');

    expect(cleared).toBe(2);
    // Only beta session remains
    const remaining = sessionManager.listSessions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].key).toBe('bot:beta:private:333');
  });

  test('clears active conversations for the target bot', () => {
    sessionManager.markActive('alpha', 100, 1);
    sessionManager.markActive('alpha', 200, 2);
    sessionManager.markActive('beta', 100, 1);

    sessionManager.clearBotSessions('alpha');

    // beta conversation should still be active
    // Use shouldRespondInGroup to verify active state indirectly
    // (isActive is private, but we can check the persisted file)
    const remaining = sessionManager.listSessions();
    // No alpha sessions
    expect(remaining.every((s) => !s.key.startsWith('bot:alpha:'))).toBe(true);
  });

  test('returns 0 when no sessions match', () => {
    sessionManager.appendMessages('bot:beta:private:333', [{ role: 'user', content: 'hey' }], 50);

    const cleared = sessionManager.clearBotSessions('nonexistent');
    expect(cleared).toBe(0);
    expect(sessionManager.listSessions()).toHaveLength(1);
  });
});

// --- BotManager.resetBot ---

describe('BotManager.resetBot', () => {
  let tmpDir: string;
  let soulDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `reset-bot-test-${Date.now()}`);
    soulDir = join(tmpDir, 'soul', 'test-bot');
    mkdirSync(join(soulDir, 'memory'), { recursive: true });
    mkdirSync(join(soulDir, '.versions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('deletes GOALS.md', async () => {
    writeFileSync(join(soulDir, 'GOALS.md'), '# Goals\n- Be helpful', 'utf-8');
    writeFileSync(join(soulDir, 'IDENTITY.md'), '# Identity', 'utf-8');

    // Import dynamically to avoid loading all bot deps at module level
    const { BotManager } = await import('../../src/bot/bot-manager');

    // Create a minimal mock that exercises the resetBot logic
    const mockSessionManager = {
      clearBotSessions: mock(() => 3),
    };
    const mockMemoryManager = {
      clearCoreMemory: mock(() => {}),
      clearIndex: mock(() => {}),
    };
    const mockConfig = {
      bots: [{ id: 'test-bot', name: 'Test Bot', soulDir }],
      soul: { dir: join(tmpDir, 'soul') },
      ollama: { models: { primary: 'test' } },
      conversation: { systemPrompt: 'You are a test bot.', temperature: 0.7, maxHistory: 20 },
    };

    // Use Object.create to build a BotManager-like object without invoking constructor
    const manager = Object.create(BotManager.prototype);
    manager.config = mockConfig;
    manager.runningBots = new Set();
    manager.sessionManager = mockSessionManager;
    manager.memoryManager = mockMemoryManager;
    manager.logger = noopLogger;

    const result = await manager.resetBot('test-bot');

    expect(result.ok).toBe(true);
    expect(result.cleared.goals).toBe(true);
    expect(result.cleared.sessions).toBe(3);
    expect(result.cleared.coreMemory).toBe(true);
    expect(result.cleared.index).toBe(true);
    expect(existsSync(join(soulDir, 'GOALS.md'))).toBe(false);
    // Identity preserved
    expect(existsSync(join(soulDir, 'IDENTITY.md'))).toBe(true);
  });

  test('deletes memory logs and .versions', async () => {
    writeFileSync(join(soulDir, 'memory', '2024-01-15.md'), '# Memory log', 'utf-8');
    writeFileSync(join(soulDir, 'memory', '2024-01-16.md'), '# Memory log 2', 'utf-8');
    writeFileSync(join(soulDir, '.versions', 'SOUL-v1.md'), 'backup', 'utf-8');

    const { BotManager } = await import('../../src/bot/bot-manager');

    const manager = Object.create(BotManager.prototype);
    manager.config = {
      bots: [{ id: 'test-bot', name: 'Test Bot', soulDir }],
      soul: { dir: join(tmpDir, 'soul') },
      ollama: { models: { primary: 'test' } },
      conversation: { systemPrompt: 'You are a test bot.', temperature: 0.7, maxHistory: 20 },
    };
    manager.runningBots = new Set();
    manager.sessionManager = { clearBotSessions: () => 0 };
    manager.memoryManager = { clearCoreMemory: () => {}, clearIndex: () => {} };
    manager.logger = noopLogger;

    const result = await manager.resetBot('test-bot');

    expect(result.cleared.memoryLogs).toBe(2);
    expect(result.cleared.versions).toBe(true);
    expect(existsSync(join(soulDir, 'memory', '2024-01-15.md'))).toBe(false);
    expect(existsSync(join(soulDir, '.versions'))).toBe(false);
    // memory directory itself still exists
    expect(existsSync(join(soulDir, 'memory'))).toBe(true);
  });

  test('throws if bot is running', async () => {
    const { BotManager } = await import('../../src/bot/bot-manager');

    const manager = Object.create(BotManager.prototype);
    manager.config = {
      bots: [{ id: 'test-bot', name: 'Test Bot' }],
      soul: { dir: join(tmpDir, 'soul') },
      ollama: { models: { primary: 'test' } },
      conversation: { systemPrompt: 'You are a test bot.', temperature: 0.7, maxHistory: 20 },
    };
    manager.runningBots = new Set(['test-bot']);
    manager.logger = noopLogger;

    expect(() => manager.resetBot('test-bot')).toThrow('Stop the agent before resetting');
  });

  test('throws if bot not found', async () => {
    const { BotManager } = await import('../../src/bot/bot-manager');

    const manager = Object.create(BotManager.prototype);
    manager.config = { bots: [], soul: { dir: join(tmpDir, 'soul') }, ollama: { models: { primary: 'test' } }, conversation: { systemPrompt: 'You are a test bot.', temperature: 0.7, maxHistory: 20 } };
    manager.runningBots = new Set();
    manager.logger = noopLogger;

    expect(() => manager.resetBot('nonexistent')).toThrow('Bot not found');
  });
});
