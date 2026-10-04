import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotConfig, Config } from '../../src/config';
import type { Logger } from '../../src/logger';
import { agentsRoutes } from '../../src/web/routes/agents';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as never;

const TEST_DIR = join(process.cwd(), '.test-agents-curiosity-patch');
const BOTS_PATH = join(TEST_DIR, 'bots.json');

function makeConfig(): Config {
  return {
    bots: [
      {
        id: 'bot1',
        name: 'Bot',
        token: '',
        enabled: true,
        skills: [],
        agentLoop: { every: '2h', curiosity: { preset: 'wild', navigatorEvery: '2d' } },
      } as unknown as BotConfig,
    ],
    agentLoop: {},
  } as unknown as Config;
}

function makeApp(config: Config) {
  const app = new Hono();
  app.route(
    '/api/agents',
    agentsRoutes({
      config,
      botManager: { isRunning: () => false } as never,
      configPath: BOTS_PATH,
      logger: noopLogger,
    } as never)
  );
  return app;
}

const patch = (app: Hono, body: unknown) =>
  app.request('/api/agents/bot1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('PATCH /api/agents/:id — agentLoop.curiosity', () => {
  let config: Config;
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(BOTS_PATH, '[]');
    config = makeConfig();
  });
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  test('persists the curiosity object and keeps sibling agentLoop keys', async () => {
    const curiosity = {
      preset: 'focused',
      limits: { topic: 'ask', identity: 'open' },
      exploreRatio: 0.4,
      dispatch: { enabled: false, maxChars: 800 },
    };
    const res = await patch(makeApp(config), {
      agentLoop: { ...config.bots[0].agentLoop, curiosity },
    });
    expect(res.status).toBe(200);
    expect(config.bots[0].agentLoop?.curiosity).toEqual(curiosity as never);
    expect(config.bots[0].agentLoop?.every).toBe('2h');
    const saved = JSON.parse(readFileSync(BOTS_PATH, 'utf-8'));
    expect(saved[0].agentLoop.curiosity.exploreRatio).toBe(0.4);
  });

  test('curiosity: null clears the override', async () => {
    const res = await patch(makeApp(config), { agentLoop: { every: '2h', curiosity: null } });
    expect(res.status).toBe(200);
    expect(config.bots[0].agentLoop?.curiosity).toBeUndefined();
  });

  test('rejects an invalid curiosity block with 400 and leaves the bot untouched', async () => {
    for (const curiosity of [
      { exploreRatio: 0.9 },
      { preset: 'reckless' },
      { limits: { topic: 'maybe' } },
      { dispatch: { maxChars: 'many' } },
    ]) {
      const res = await patch(makeApp(config), { agentLoop: { curiosity } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('curiosity');
    }
    expect(config.bots[0].agentLoop?.curiosity).toEqual({
      preset: 'wild',
      navigatorEvery: '2d',
    } as never);
  });
});

describe('PATCH /api/agents/bulk — agentLoop.curiosity', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(BOTS_PATH, '[]');
  });
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  test('rejects an invalid curiosity block before touching any bot', async () => {
    const config = makeConfig();
    const res = await makeApp(config).request('/api/agents/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['bot1'],
        patch: { agentLoop: { curiosity: { exploreRatio: 2 } } },
      }),
    });
    expect(res.status).toBe(400);
    expect(config.bots[0].agentLoop?.every).toBe('2h');
  });
});
