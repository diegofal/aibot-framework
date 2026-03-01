import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BotResetDeps, BotResetService } from '../../src/bot/bot-reset';
import type { SessionConfig } from '../../src/config';
import type { Logger } from '../../src/logger';
import { SessionManager } from '../../src/session';
import { DynamicToolStore } from '../../src/tools/dynamic-tool-store';

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
      memoryManager: {
        clearCoreMemory: mock(() => {}),
        clearIndex: mock(() => {}),
        clearCoreMemoryForBot: mock(() => 0),
        clearIndexForBot: mock(() => 0),
      } as any,
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

  test('clears core memory and index using per-bot methods', async () => {
    const clearCoreMemoryForBot = mock(() => 5);
    const clearIndexForBot = mock(() => 3);

    const service = createResetService({
      memoryManager: {
        clearCoreMemory: mock(() => {}),
        clearIndex: mock(() => {}),
        clearCoreMemoryForBot,
        clearIndexForBot,
      } as any,
    });
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.coreMemory).toBe(true);
    expect(result.cleared.index).toBe(true);
    expect(clearCoreMemoryForBot).toHaveBeenCalledWith('test-bot');
    expect(clearIndexForBot).toHaveBeenCalledWith('test-bot');
  });

  test('handles missing memoryManager gracefully', async () => {
    const service = createResetService({ memoryManager: undefined });
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.coreMemory).toBe(false);
    expect(result.cleared.index).toBe(false);
  });

  test('clears dynamic tools created by the bot', async () => {
    const clearForBot = mock(() => 3);
    const service = createResetService({
      dynamicToolRegistry: { clearForBot } as any,
    });
    const result = await service.reset('test-bot', soulDir);

    expect(clearForBot).toHaveBeenCalledWith('test-bot');
    expect(result.cleared.dynamicTools).toBe(3);
  });

  test('handles missing dynamicToolRegistry gracefully', async () => {
    const service = createResetService({ dynamicToolRegistry: undefined });
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.dynamicTools).toBe(0);
  });

  test('handles null dynamicToolRegistry gracefully', async () => {
    const service = createResetService({ dynamicToolRegistry: null });
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.dynamicTools).toBe(0);
  });

  test('clears karma events for the bot', async () => {
    const clearEvents = mock(() => {});
    const service = createResetService({
      karmaService: { clearEvents } as any,
    });
    const result = await service.reset('test-bot', soulDir);

    expect(clearEvents).toHaveBeenCalledWith('test-bot');
    expect(result.cleared.karma).toBe(true);
  });

  test('handles missing karmaService gracefully', async () => {
    const service = createResetService({ karmaService: undefined });
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.karma).toBe(false);
  });
});

// --- BotResetService extended steps (16-22) ---

describe('BotResetService extended reset steps', () => {
  let tmpDir: string;
  let soulDir: string;
  let productionsBaseDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `reset-extended-${Date.now()}`);
    soulDir = join(tmpDir, 'soul', 'test-bot');
    productionsBaseDir = join(tmpDir, 'productions');
    mkdirSync(join(soulDir, 'memory'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createExtendedResetService(
    overrides: Partial<import('../../src/bot/bot-reset').BotResetDeps> = {}
  ): BotResetService {
    return new BotResetService({
      sessionManager: { clearBotSessions: mock(() => 0) } as any,
      agentFeedbackStore: { clearForBot: mock(() => {}) } as any,
      askHumanStore: { clearForBot: mock(() => {}) } as any,
      askPermissionStore: { clearForBot: mock(() => {}) } as any,
      logger: noopLogger,
      productionsBaseDir,
      ...overrides,
    });
  }

  test('clears conversations via deleteAllForBot', async () => {
    const deleteAllForBot = mock(() => 5);
    const service = createExtendedResetService({
      conversationsService: { deleteAllForBot } as any,
    });
    const result = await service.reset('test-bot', soulDir);

    expect(deleteAllForBot).toHaveBeenCalledWith('test-bot');
    expect(result.cleared.conversations).toBe(5);
  });

  test('clears tool audit log directory', async () => {
    // Create tool audit log dir with some files
    const auditDir = join(tmpDir, 'tool-audit', 'test-bot');
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, '2026-02-28.jsonl'), '{"entry": true}\n', 'utf-8');

    const clearForBot = mock(() => true);
    const service = createExtendedResetService({
      toolAuditLog: { clearForBot } as any,
    });
    const result = await service.reset('test-bot', soulDir);

    expect(clearForBot).toHaveBeenCalledWith('test-bot');
    expect(result.cleared.toolAuditLog).toBe(true);
  });

  test('deletes entire productions directory for bot', async () => {
    // Create productions dir with various files
    const botProdDir = join(productionsBaseDir, 'test-bot');
    mkdirSync(join(botProdDir, 'src', 'skills', 'my-skill'), { recursive: true });
    writeFileSync(join(botProdDir, 'changelog.json'), '[]', 'utf-8');
    writeFileSync(join(botProdDir, 'summary.json'), '{}', 'utf-8');

    const service = createExtendedResetService();
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.productions).toBe(true);
    expect(existsSync(botProdDir)).toBe(false);
  });

  test('productions cleared = false when dir does not exist', async () => {
    const service = createExtendedResetService();
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.productions).toBe(false);
  });

  test('clears agent scheduler state for bot', async () => {
    const clearScheduleForBot = mock(() => true);
    const service = createExtendedResetService();
    service.setAgentLoop({ clearScheduleForBot });
    const result = await service.reset('test-bot', soulDir);

    expect(clearScheduleForBot).toHaveBeenCalledWith('test-bot');
    expect(result.cleared.agentSchedule).toBe(true);
  });

  test('clears collaboration tracker entries involving bot', async () => {
    const clearForBot = mock(() => 3);
    const service = createExtendedResetService({
      collaborationTracker: { clearForBot } as any,
    });
    const result = await service.reset('test-bot', soulDir);

    expect(clearForBot).toHaveBeenCalledWith('test-bot');
    expect(result.cleared.collaborationRecords).toBe(3);
  });

  test('clears collaboration sessions involving bot', async () => {
    const clearForBot = mock(() => 2);
    const service = createExtendedResetService({
      collaborationSessions: { clearForBot } as any,
    });
    const result = await service.reset('test-bot', soulDir);

    expect(clearForBot).toHaveBeenCalledWith('test-bot');
    expect(result.cleared.collaborationSessions).toBe(2);
  });

  test('clears activity stream events for bot', async () => {
    const clearForBot = mock(() => 10);
    const service = createExtendedResetService({
      activityStream: { clearForBot } as any,
    });
    const result = await service.reset('test-bot', soulDir);

    expect(clearForBot).toHaveBeenCalledWith('test-bot');
    expect(result.cleared.activityEvents).toBe(10);
  });

  test('all new steps skip gracefully when deps not provided', async () => {
    const service = new BotResetService({
      sessionManager: { clearBotSessions: mock(() => 0) } as any,
      agentFeedbackStore: { clearForBot: mock(() => {}) } as any,
      askHumanStore: { clearForBot: mock(() => {}) } as any,
      askPermissionStore: { clearForBot: mock(() => {}) } as any,
      logger: noopLogger,
    });
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.conversations).toBe(0);
    expect(result.cleared.toolAuditLog).toBe(false);
    expect(result.cleared.productions).toBe(false);
    expect(result.cleared.agentSchedule).toBe(false);
    expect(result.cleared.collaborationRecords).toBe(0);
    expect(result.cleared.collaborationSessions).toBe(0);
    expect(result.cleared.activityEvents).toBe(0);
  });
});

// --- DynamicToolStore.deleteByCreator ---

describe('DynamicToolStore.deleteByCreator', () => {
  let tmpDir: string;
  let store: DynamicToolStore;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `dyn-tool-store-${Date.now()}`);
    store = new DynamicToolStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('deletes only tools created by the specified bot', () => {
    store.create(
      {
        name: 'tool_alpha',
        description: 'Tool by alpha',
        type: 'typescript',
        createdBy: 'alpha',
        scope: 'all',
        parameters: {},
      },
      'export default () => {}'
    );

    store.create(
      {
        name: 'tool_beta',
        description: 'Tool by beta',
        type: 'typescript',
        createdBy: 'beta',
        scope: 'all',
        parameters: {},
      },
      'export default () => {}'
    );

    store.create(
      {
        name: 'tool_alpha2',
        description: 'Another tool by alpha',
        type: 'typescript',
        createdBy: 'alpha',
        scope: 'all',
        parameters: {},
      },
      'export default () => {}'
    );

    const deleted = store.deleteByCreator('alpha');

    expect(deleted).toBe(2);
    // Only beta's tool remains
    const remaining = store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('tool_beta');
  });

  test('returns 0 when no tools match', () => {
    store.create(
      {
        name: 'tool_beta',
        description: 'Tool by beta',
        type: 'typescript',
        createdBy: 'beta',
        scope: 'all',
        parameters: {},
      },
      'export default () => {}'
    );

    const deleted = store.deleteByCreator('nonexistent');
    expect(deleted).toBe(0);
    expect(store.list()).toHaveLength(1);
  });

  test('returns 0 when store is empty', () => {
    const deleted = store.deleteByCreator('alpha');
    expect(deleted).toBe(0);
  });
});

// --- Production skills cleanup ---

describe('BotResetService production skills cleanup', () => {
  let tmpDir: string;
  let soulDir: string;
  let configPath: string;
  let builtinSkillsPath: string;
  let productionsBaseDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `reset-prod-skills-${Date.now()}`);
    soulDir = join(tmpDir, 'soul', 'test-bot');
    configPath = join(tmpDir, 'config.json');
    builtinSkillsPath = join(tmpDir, 'src', 'skills');
    productionsBaseDir = join(tmpDir, 'productions');
    mkdirSync(join(soulDir, 'memory'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupProductionSkills(skills: string[]): void {
    const prodSkillsDir = join(productionsBaseDir, 'test-bot', 'src', 'skills');
    for (const skill of skills) {
      const dir = join(prodSkillsDir, skill);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'skill.json'), JSON.stringify({ id: skill }), 'utf-8');
      writeFileSync(join(dir, 'index.ts'), 'export default {}', 'utf-8');
    }
  }

  function setupBuiltinSkills(skills: string[]): void {
    for (const skill of skills) {
      const dir = join(builtinSkillsPath, skill);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'skill.json'), JSON.stringify({ id: skill }), 'utf-8');
    }
  }

  function writeConfig(config: Record<string, unknown>): void {
    mkdirSync(join(tmpDir), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  function createResetServiceWithConfig(
    configOverrides: Record<string, unknown> = {}
  ): BotResetService {
    const config = {
      bots: [
        { id: 'test-bot', name: 'Test Bot', skills: ['reminders', 'streak-tracking', 'bookmarks'] },
      ],
      skills: {
        enabled: ['reminders', 'streak-tracking', 'bookmarks'],
        config: { 'streak-tracking': { interval: 7 }, bookmarks: { maxItems: 100 } },
      },
      ...configOverrides,
    };
    return new BotResetService({
      sessionManager: { clearBotSessions: mock(() => 0) } as any,
      agentFeedbackStore: { clearForBot: mock(() => {}) } as any,
      askHumanStore: { clearForBot: mock(() => {}) } as any,
      askPermissionStore: { clearForBot: mock(() => {}) } as any,
      logger: noopLogger,
      config: config as any,
      configPath,
      builtinSkillsPath,
      productionsBaseDir,
    });
  }

  test('deletes production skills directory', async () => {
    setupProductionSkills(['streak-tracking', 'bookmarks']);
    setupBuiltinSkills(['reminders']);
    writeConfig({
      bots: [
        { id: 'test-bot', name: 'Test Bot', skills: ['reminders', 'streak-tracking', 'bookmarks'] },
      ],
      skills: { enabled: ['reminders', 'streak-tracking', 'bookmarks'], config: {} },
    });

    const service = createResetServiceWithConfig();
    const result = await service.reset('test-bot', soulDir);

    expect(existsSync(join(productionsBaseDir, 'test-bot', 'src', 'skills'))).toBe(false);
    expect(result.cleared.productionSkills).toContain('streak-tracking');
    expect(result.cleared.productionSkills).toContain('bookmarks');
  });

  test('removes production-only skills from config.skills.enabled', async () => {
    setupProductionSkills(['streak-tracking', 'bookmarks']);
    setupBuiltinSkills(['reminders']);
    const rawConfig = {
      bots: [
        { id: 'test-bot', name: 'Test Bot', skills: ['reminders', 'streak-tracking', 'bookmarks'] },
      ],
      skills: {
        enabled: ['reminders', 'streak-tracking', 'bookmarks'],
        config: { 'streak-tracking': { interval: 7 } },
      },
    };
    writeConfig(rawConfig);

    const service = createResetServiceWithConfig();
    const result = await service.reset('test-bot', soulDir);

    // Check persisted config on disk
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.skills.enabled).toEqual(['reminders']);
    expect(persisted.skills.config['streak-tracking']).toBeUndefined();
    expect(result.cleared.productionSkills).toHaveLength(2);
  });

  test('preserves skills that exist in built-in path', async () => {
    setupProductionSkills(['reminders', 'streak-tracking']);
    setupBuiltinSkills(['reminders']);
    writeConfig({
      bots: [{ id: 'test-bot', name: 'Test Bot', skills: ['reminders', 'streak-tracking'] }],
      skills: { enabled: ['reminders', 'streak-tracking'], config: {} },
    });

    const service = createResetServiceWithConfig({
      bots: [{ id: 'test-bot', name: 'Test Bot', skills: ['reminders', 'streak-tracking'] }],
      skills: { enabled: ['reminders', 'streak-tracking'], config: {} },
    });
    const result = await service.reset('test-bot', soulDir);

    // reminders is built-in, so it should NOT be in productionOnlySkills
    expect(result.cleared.productionSkills).not.toContain('reminders');
    expect(result.cleared.productionSkills).toContain('streak-tracking');

    // Check persisted config still has reminders
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.skills.enabled).toContain('reminders');
  });

  test('removes from botConfig.skills array', async () => {
    setupProductionSkills(['bookmarks']);
    setupBuiltinSkills(['reminders']);
    writeConfig({
      bots: [{ id: 'test-bot', name: 'Test Bot', skills: ['reminders', 'bookmarks'] }],
      skills: { enabled: ['reminders', 'bookmarks'], config: {} },
    });

    const service = createResetServiceWithConfig({
      bots: [{ id: 'test-bot', name: 'Test Bot', skills: ['reminders', 'bookmarks'] }],
      skills: { enabled: ['reminders', 'bookmarks'], config: {} },
    });
    const result = await service.reset('test-bot', soulDir);

    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.bots[0].skills).toEqual(['reminders']);
    expect(result.cleared.productionSkills).toEqual(['bookmarks']);
  });

  test('skips gracefully when no production dir exists', async () => {
    // Don't create any production skills dir
    setupBuiltinSkills(['reminders']);
    writeConfig({
      bots: [{ id: 'test-bot', name: 'Test Bot', skills: ['reminders'] }],
      skills: { enabled: ['reminders'], config: {} },
    });

    const service = createResetServiceWithConfig({
      bots: [{ id: 'test-bot', name: 'Test Bot', skills: ['reminders'] }],
      skills: { enabled: ['reminders'], config: {} },
    });
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.productionSkills).toEqual([]);
  });

  test('skips gracefully when deps not provided (backward compat)', async () => {
    setupProductionSkills(['streak-tracking']);

    // Create service WITHOUT the new deps
    const service = new BotResetService({
      sessionManager: { clearBotSessions: mock(() => 0) } as any,
      agentFeedbackStore: { clearForBot: mock(() => {}) } as any,
      askHumanStore: { clearForBot: mock(() => {}) } as any,
      askPermissionStore: { clearForBot: mock(() => {}) } as any,
      logger: noopLogger,
    });
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.productionSkills).toEqual([]);
    // Production dir should still exist (not cleaned)
    expect(existsSync(join(productionsBaseDir, 'test-bot', 'src', 'skills'))).toBe(true);
  });

  test('handles empty production skills directory', async () => {
    // Create empty production skills dir
    mkdirSync(join(productionsBaseDir, 'test-bot', 'src', 'skills'), { recursive: true });
    setupBuiltinSkills(['reminders']);
    writeConfig({
      bots: [{ id: 'test-bot', name: 'Test Bot', skills: ['reminders'] }],
      skills: { enabled: ['reminders'], config: {} },
    });

    const service = createResetServiceWithConfig({
      bots: [{ id: 'test-bot', name: 'Test Bot', skills: ['reminders'] }],
      skills: { enabled: ['reminders'], config: {} },
    });
    const result = await service.reset('test-bot', soulDir);

    expect(result.cleared.productionSkills).toEqual([]);
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
      memoryManager: {
        clearCoreMemory: mock(() => {}),
        clearIndex: mock(() => {}),
        clearCoreMemoryForBot: mock(() => 0),
        clearIndexForBot: mock(() => 0),
      } as any,
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
