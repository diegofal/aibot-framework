import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotConfig, Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { agentsRoutes } from '../../../src/web/routes/agents';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const TEST_DIR = join(process.cwd(), '.test-agents-loop-routes');
const CONFIG_PATH = join(TEST_DIR, 'config.json');
const BOTS_PATH = join(TEST_DIR, 'bots.json');

function makeBots(): BotConfig[] {
  return [
    {
      id: 'bot1',
      name: 'TestBot1',
      token: 'tok123',
      enabled: true,
      skills: [],
      disabledSkills: [],
      plan: 'free',
    } as BotConfig,
  ];
}

function makeConfig(bots: BotConfig[]): Config {
  return {
    bots,
    ollama: {
      baseUrl: 'http://localhost:11434',
      timeout: 300_000,
      models: { primary: 'llama3' },
    },
    conversation: {
      enabled: true,
      systemPrompt: 'You are helpful.',
      temperature: 0.7,
      maxHistory: 20,
    },
    soul: { dir: './config/soul' },
    productions: { baseDir: './productions' },
    agentLoop: {
      enabled: false,
      every: '6h',
      maxToolRounds: 30,
      claudeTimeout: 300_000,
      maxDurationMs: 300_000,
      toolPreSelection: true,
      idleSuppression: true,
      phaseTimeouts: {
        feedbackMs: 30_000,
        strategistMs: 60_000,
        plannerMs: 60_000,
        executorMs: 90_000,
      },
      strategist: {
        enabled: true,
        everyCycles: 4,
        minInterval: '4h',
      },
      retry: {
        maxRetries: 2,
        initialDelayMs: 10_000,
        maxDelayMs: 60_000,
        backoffMultiplier: 2,
      },
      loopDetection: {
        enabled: true,
        historySize: 30,
        warningThreshold: 8,
        criticalThreshold: 16,
        globalCircuitBreakerThreshold: 25,
        detectors: {
          genericRepeat: true,
          knownPollNoProgress: true,
          pingPong: true,
        },
        knownPollTools: [{ toolName: 'process', actions: ['poll', 'log', 'list'] }],
      },
    },
  } as unknown as Config;
}

function makeApp(config: Config, configPath: string) {
  const app = new Hono();
  app.route(
    '/api/agents',
    agentsRoutes({
      config,
      botManager: {
        isRunning: () => false,
        getAvailableToolNames: () => ['file_read', 'file_write'],
        getExternalSkillNames: () => [],
      } as any,
      configPath,
      logger: noopLogger,
    })
  );
  return app;
}

describe('agents API — agent loop settings', () => {
  let config: Config;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, '{}');
    writeFileSync(BOTS_PATH, '[]');
    const bots = makeBots();
    config = makeConfig(bots);
    app = makeApp(config, BOTS_PATH);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('GET /defaults returns full agentLoop object', async () => {
    const res = await app.request('/api/agents/defaults');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agentLoop).toBeDefined();
    expect(data.agentLoop.enabled).toBe(false);
    expect(data.agentLoop.every).toBe('6h');
    expect(data.agentLoop.maxToolRounds).toBe(30);
    expect(data.agentLoop.claudeTimeout).toBe(300_000);
    expect(data.agentLoop.phaseTimeouts).toEqual({
      feedbackMs: 30_000,
      strategistMs: 60_000,
      plannerMs: 60_000,
      executorMs: 90_000,
    });
    expect(data.agentLoop.strategist).toEqual({
      enabled: true,
      everyCycles: 4,
      minInterval: '4h',
    });
    expect(data.agentLoop.retry).toEqual({
      maxRetries: 2,
      initialDelayMs: 10_000,
      maxDelayMs: 60_000,
      backoffMultiplier: 2,
    });
    expect(data.agentLoop.loopDetection.enabled).toBe(true);
    expect(data.agentLoop.loopDetection.warningThreshold).toBe(8);
    // Backward compat
    expect(data.agentLoopInterval).toBe('6h');
  });

  test('PATCH with nested strategist fields persists correctly', async () => {
    const res = await app.request('/api/agents/bot1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentLoop: {
          mode: 'continuous',
          maxToolRounds: 15,
          continuousPauseMs: 3000,
          strategist: { enabled: false, everyCycles: 2 },
        },
      }),
    });
    expect(res.status).toBe(200);
    const bot = config.bots.find((b) => b.id === 'bot1') as (typeof config.bots)[number];
    expect(bot.agentLoop?.mode).toBe('continuous');
    expect(bot.agentLoop?.maxToolRounds).toBe(15);
    expect(bot.agentLoop?.continuousPauseMs).toBe(3000);
    expect(bot.agentLoop?.strategist?.enabled).toBe(false);
    expect(bot.agentLoop?.strategist?.everyCycles).toBe(2);
  });

  test('PATCH with retry and phaseTimeouts sub-objects', async () => {
    const res = await app.request('/api/agents/bot1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentLoop: {
          retry: { maxRetries: 5, backoffMultiplier: 3 },
          phaseTimeouts: { executorMs: 120_000 },
        },
      }),
    });
    expect(res.status).toBe(200);
    const bot = config.bots.find((b) => b.id === 'bot1') as (typeof config.bots)[number];
    expect(bot.agentLoop?.retry?.maxRetries).toBe(5);
    expect(bot.agentLoop?.retry?.backoffMultiplier).toBe(3);
    expect(bot.agentLoop?.phaseTimeouts?.executorMs).toBe(120_000);
  });

  test('PATCH with loopDetection sub-object', async () => {
    const res = await app.request('/api/agents/bot1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentLoop: {
          loopDetection: { enabled: false, warningThreshold: 12, criticalThreshold: 20 },
        },
      }),
    });
    expect(res.status).toBe(200);
    const bot = config.bots.find((b) => b.id === 'bot1') as (typeof config.bots)[number];
    expect(bot.agentLoop?.loopDetection?.enabled).toBe(false);
    expect(bot.agentLoop?.loopDetection?.warningThreshold).toBe(12);
    expect(bot.agentLoop?.loopDetection?.criticalThreshold).toBe(20);
  });

  test('PATCH clearing all agentLoop fields sets it to undefined', async () => {
    // First set some values
    await app.request('/api/agents/bot1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentLoop: { maxToolRounds: 10 } }),
    });
    const bot = config.bots.find((b) => b.id === 'bot1') as (typeof config.bots)[number];
    expect(bot.agentLoop?.maxToolRounds).toBe(10);

    // Clear all
    const res = await app.request('/api/agents/bot1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentLoop: {} }),
    });
    expect(res.status).toBe(200);
    expect(bot.agentLoop).toBeUndefined();
  });

  test('PATCH with reportChatId and claudeTimeout', async () => {
    const res = await app.request('/api/agents/bot1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentLoop: {
          reportChatId: -1001234567890,
          claudeTimeout: 600_000,
        },
      }),
    });
    expect(res.status).toBe(200);
    const bot = config.bots.find((b) => b.id === 'bot1') as (typeof config.bots)[number];
    expect(bot.agentLoop?.reportChatId).toBe(-1001234567890);
    expect(bot.agentLoop?.claudeTimeout).toBe(600_000);
  });
});
