/**
 * `POST /api/agents/:id/start` and the `enabled` guard.
 *
 * `enabled` is now the runtime authority: a disabled agent is never started at
 * boot, and must not be startable by a direct API call either. The route has to
 * say that in a way an operator (and the dashboard) can act on, and must offer a
 * single-step way to go live — otherwise the dashboard's Start button becomes a
 * dead control for exactly the agents someone is trying to bring up.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { BotDisabledError } from '../../../src/bot/auto-start';
import type { BotConfig, Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { agentsRoutes } from '../../../src/web/routes/agents';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as unknown as Logger;

const TEST_DIR = join(process.cwd(), '.test-agents-start-guard');
const CONFIG_PATH = join(TEST_DIR, 'config.json');
const BOTS_PATH = join(TEST_DIR, 'bots.json');

function makeBot(id: string, enabled: boolean): BotConfig {
  return {
    id,
    name: id,
    token: 'tok',
    enabled,
    skills: [],
    disabledSkills: [],
    plan: 'free',
  } as BotConfig;
}

function makeConfig(bots: BotConfig[]): Config {
  return {
    bots,
    ollama: { baseUrl: 'http://localhost:11434', timeout: 1000, models: { primary: 'llama3' } },
    conversation: { enabled: true, systemPrompt: '', temperature: 0.7, maxHistory: 20 },
    soul: { dir: './config/soul' },
    productions: { baseDir: './productions' },
    agentLoop: { enabled: false, every: '6h' },
  } as unknown as Config;
}

interface Harness {
  config: Config;
  app: Hono;
  startCalls: string[];
}

function setup(
  bots: BotConfig[],
  opts: { running?: Set<string>; startBot?: (bot: BotConfig) => Promise<void> } = {}
): Harness {
  const config = makeConfig(bots);
  writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2));
  writeFileSync(BOTS_PATH, JSON.stringify(config.bots, null, 2));

  const startCalls: string[] = [];
  const running = opts.running ?? new Set<string>();

  const app = new Hono();
  app.route(
    '/api/agents',
    agentsRoutes({
      config,
      configPath: CONFIG_PATH,
      logger: noopLogger,
      botManager: {
        isRunning: (id: string) => running.has(id),
        startBot: async (bot: BotConfig) => {
          startCalls.push(bot.id);
          if (opts.startBot) await opts.startBot(bot);
        },
        getAvailableToolNames: () => [],
        getExternalSkillNames: () => [],
      } as never,
      skillRegistry: { listAvailable: async () => [] } as never,
    })
  );

  return { config, app, startCalls };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe('POST /api/agents/:id/start', () => {
  test('starts an enabled agent', async () => {
    const { app, startCalls } = setup([makeBot('a', true)]);

    const res = await app.request('http://localhost/api/agents/a/start', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, running: true, enabled: true });
    expect(startCalls).toEqual(['a']);
  });

  test('refuses a disabled agent with an actionable 409 and never calls startBot', async () => {
    const { app, startCalls } = setup([makeBot('a', false)]);

    const res = await app.request('http://localhost/api/agents/a/start', { method: 'POST' });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('agent_disabled');
    expect(body.error).toContain('disabled');
    expect(body.error).toContain('enable=true');
    expect(startCalls).toEqual([]);
  });

  test('?enable=true enables, persists, and starts — the dashboard "Enable & Start" path', async () => {
    const { app, config, startCalls } = setup([makeBot('a', false)]);

    const res = await app.request('http://localhost/api/agents/a/start?enable=true', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, running: true, enabled: true });
    expect(startCalls).toEqual(['a']);
    expect(config.bots[0].enabled).toBe(true);
    // Persisted, so the agent also comes back after a restart — that is what
    // "go live" has to mean now that boot reads `enabled`.
    expect(JSON.parse(readFileSync(BOTS_PATH, 'utf-8'))[0].enabled).toBe(true);
  });

  test('?enable=true on an already-enabled agent changes nothing else', async () => {
    const { app, config, startCalls } = setup([makeBot('a', true)]);

    const res = await app.request('http://localhost/api/agents/a/start?enable=true', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(startCalls).toEqual(['a']);
    expect(config.bots[0].enabled).toBe(true);
  });

  test('a BotDisabledError from startBot is reported as 409, not 500', async () => {
    const { app } = setup([makeBot('a', true)], {
      startBot: async () => {
        throw new BotDisabledError('a');
      },
    });

    const res = await app.request('http://localhost/api/agents/a/start', { method: 'POST' });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('agent_disabled');
  });

  test('an ordinary start failure is still a 500', async () => {
    const { app } = setup([makeBot('a', true)], {
      startBot: async () => {
        throw new Error('soul directory is unreadable');
      },
    });

    const res = await app.request('http://localhost/api/agents/a/start', { method: 'POST' });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('soul directory');
  });

  test('a running agent is rejected before the enabled check', async () => {
    const { app, startCalls } = setup([makeBot('a', false)], { running: new Set(['a']) });

    const res = await app.request('http://localhost/api/agents/a/start', { method: 'POST' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Agent already running');
    expect(startCalls).toEqual([]);
  });

  test('an unknown agent is a 404', async () => {
    const { app } = setup([makeBot('a', true)]);

    const res = await app.request('http://localhost/api/agents/ghost/start', { method: 'POST' });

    expect(res.status).toBe(404);
  });
});
