import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../../src/session';
import { BotResetService, type BotResetDeps } from '../../src/bot/bot-reset';
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

// --- BotResetService ---

describe('BotResetService', () => {
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

  function createResetService(overrides: Partial<BotResetDeps> = {}): BotResetService {
    const deps: BotResetDeps = {
      sessionManager: { clearBotSessions: mock(() => 0) } as any,
      memoryManager: { clearCoreMemory: mock(() => {}), clearIndex: mock(() => {}) } as any,
      agentFeedbackStore: { clearForBot: mock(() => {}) } as any,
      askHumanStore: { clearForBot: mock(() => {}) } as any,
      askPermissionStore: { clearForBot: mock(() => {}) } as any,
      logger: noopLogger,
      ...overrides,
    };
    return new BotResetService(deps);
  }

  test('restores soul files from .baseline/', async () => {
    // Write current (evolved) soul files
    writeFileSync(join(soulDir, 'IDENTITY.md'), '# Evolved Identity', 'utf-8');
    writeFileSync(join(soulDir, 'SOUL.md'), '# Evolved Soul', 'utf-8');
    writeFileSync(join(soulDir, 'MOTIVATIONS.md'), '# Evolved Motivations', 'utf-8');

    // Write baseline copies
    const baselineDir = join(soulDir, '.baseline');
    mkdirSync(baselineDir, { recursive: true });
    writeFileSync(join(baselineDir, 'IDENTITY.md'), '# Original Identity', 'utf-8');
    writeFileSync(join(baselineDir, 'SOUL.md'), '# Original Soul', 'utf-8');
    writeFileSync(join(baselineDir, 'MOTIVATIONS.md'), '# Original Motivations', 'utf-8');

    const service = createResetService();
    const result = await service.reset('test-bot', soulDir);

    expect(result.ok).toBe(true);
    expect(result.cleared.soulRestored).toBe(true);
    expect(readFileSync(join(soulDir, 'IDENTITY.md'), 'utf-8')).toBe('# Original Identity');
    expect(readFileSync(join(soulDir, 'SOUL.md'), 'utf-8')).toBe('# Original Soul');
    expect(readFileSync(join(soulDir, 'MOTIVATIONS.md'), 'utf-8')).toBe('# Original Motivations');
  });

  test('deletes soul files when no .baseline/ exists', async () => {
    writeFileSync(join(soulDir, 'IDENTITY.md'), '# Identity', 'utf-8');
    writeFileSync(join(soulDir, 'SOUL.md'), '# Soul', 'utf-8');
    writeFileSync(join(soulDir, 'MOTIVATIONS.md'), '# Motivations', 'utf-8');

    const service = createResetService();
    const result = await service.reset('test-bot', soulDir);

    expect(result.ok).toBe(true);
    expect(result.cleared.soulRestored).toBe(false);
    expect(existsSync(join(soulDir, 'IDENTITY.md'))).toBe(false);
    expect(existsSync(join(soulDir, 'SOUL.md'))).toBe(false);
    expect(existsSync(join(soulDir, 'MOTIVATIONS.md'))).toBe(false);
  });

  test('deletes GOALS.md', async () => {
    writeFileSync(join(soulDir, 'GOALS.md'), '# Goals\n- Be helpful', 'utf-8');

    const service = createResetService({
      sessionManager: { clearBotSessions: mock(() => 3) } as any,
    });
    const result = await service.reset('test-bot', soulDir);

    expect(result.ok).toBe(true);
    expect(result.cleared.goals).toBe(true);
    expect(result.cleared.sessions).toBe(3);
    expect(existsSync(join(soulDir, 'GOALS.md'))).toBe(false);
  });

  test('deletes MEMORY.md at soul root', async () => {
    writeFileSync(join(soulDir, 'MEMORY.md'), '# Memory root file', 'utf-8');

    const service = createResetService();
    const result = await service.reset('test-bot', soulDir);

    expect(result.ok).toBe(true);
    expect(existsSync(join(soulDir, 'MEMORY.md'))).toBe(false);
  });

  test('recursively clears memory/ directory including subdirs', async () => {
    mkdirSync(join(soulDir, 'memory', 'archive'), { recursive: true });
    writeFileSync(join(soulDir, 'memory', '2024-01-15.md'), '# Memory log', 'utf-8');
    writeFileSync(join(soulDir, 'memory', '2024-01-16.md'), '# Memory log 2', 'utf-8');
    writeFileSync(join(soulDir, 'memory', 'archive', 'old.md'), '# Archived', 'utf-8');
    writeFileSync(join(soulDir, 'memory', 'notes.txt'), 'non-md file', 'utf-8');

    const service = createResetService();
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.memoryDir).toBe(true);
    // memory/ directory recreated but empty
    expect(existsSync(join(soulDir, 'memory'))).toBe(true);
    expect(existsSync(join(soulDir, 'memory', '2024-01-15.md'))).toBe(false);
    expect(existsSync(join(soulDir, 'memory', 'archive'))).toBe(false);
    expect(existsSync(join(soulDir, 'memory', 'notes.txt'))).toBe(false);
  });

  test('deletes .versions/', async () => {
    writeFileSync(join(soulDir, '.versions', 'SOUL-v1.md'), 'backup', 'utf-8');

    const service = createResetService();
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.versions).toBe(true);
    expect(existsSync(join(soulDir, '.versions'))).toBe(false);
  });

  test('deletes feedback.jsonl', async () => {
    writeFileSync(join(soulDir, 'feedback.jsonl'), '{"id":"1","content":"test"}\n', 'utf-8');

    const service = createResetService();
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.feedback).toBe(true);
    expect(existsSync(join(soulDir, 'feedback.jsonl'))).toBe(false);
  });

  test('calls clearForBot on all stores', async () => {
    const feedbackClear = mock(() => {});
    const askHumanClear = mock(() => {});
    const askPermissionClear = mock(() => {});

    const service = createResetService({
      agentFeedbackStore: { clearForBot: feedbackClear } as any,
      askHumanStore: { clearForBot: askHumanClear } as any,
      askPermissionStore: { clearForBot: askPermissionClear } as any,
    });

    await service.reset('test-bot', soulDir);

    expect(feedbackClear).toHaveBeenCalledWith('test-bot');
    expect(askHumanClear).toHaveBeenCalledWith('test-bot');
    expect(askPermissionClear).toHaveBeenCalledWith('test-bot');
  });

  test('clears core memory and index', async () => {
    const clearCoreMemory = mock(() => {});
    const clearIndex = mock(() => {});

    const service = createResetService({
      memoryManager: { clearCoreMemory, clearIndex } as any,
    });
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.coreMemory).toBe(true);
    expect(result.cleared.index).toBe(true);
    expect(clearCoreMemory).toHaveBeenCalled();
    expect(clearIndex).toHaveBeenCalled();
  });

  test('handles missing memoryManager gracefully', async () => {
    const service = createResetService({ memoryManager: undefined });
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.coreMemory).toBe(false);
    expect(result.cleared.index).toBe(false);
  });
});

// --- BotManager.resetBot preconditions ---

describe('BotManager.resetBot preconditions', () => {
  let tmpDir: string;
  let soulDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `reset-precond-${Date.now()}`);
    soulDir = join(tmpDir, 'soul', 'test-bot');
    mkdirSync(join(soulDir, 'memory'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createMockManager(overrides: Record<string, any> = {}) {
    const { BotManager } = await import('../../src/bot/bot-manager');
    const manager = Object.create(BotManager.prototype);
    manager.config = {
      bots: [{ id: 'test-bot', name: 'Test Bot', soulDir }],
      soul: { dir: join(tmpDir, 'soul') },
      ollama: { models: { primary: 'test' } },
      conversation: { systemPrompt: 'You are a test bot.', temperature: 0.7, maxHistory: 20 },
    };
    manager.runningBots = new Set();
    manager.botResetService = new BotResetService({
      sessionManager: { clearBotSessions: mock(() => 0) } as any,
      memoryManager: { clearCoreMemory: mock(() => {}), clearIndex: mock(() => {}) } as any,
      agentFeedbackStore: { clearForBot: mock(() => {}) } as any,
      askHumanStore: { clearForBot: mock(() => {}) } as any,
      askPermissionStore: { clearForBot: mock(() => {}) } as any,
      logger: noopLogger,
    });
    manager.logger = noopLogger;
    Object.assign(manager, overrides);
    return manager;
  }

  test('throws if bot is running', async () => {
    const manager = await createMockManager({
      runningBots: new Set(['test-bot']),
    });

    expect(() => manager.resetBot('test-bot')).toThrow('Stop the agent before resetting');
  });

  test('throws if bot not found', async () => {
    const manager = await createMockManager();
    manager.config = {
      bots: [],
      soul: { dir: join(tmpDir, 'soul') },
      ollama: { models: { primary: 'test' } },
      conversation: { systemPrompt: 'You are a test bot.', temperature: 0.7, maxHistory: 20 },
    };

    expect(() => manager.resetBot('nonexistent')).toThrow('Bot not found');
  });
});
