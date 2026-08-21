import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotConfig, Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { agentsRoutes } from '../../../src/web/routes/agents';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

let TEST_DIR: string;
let CONFIG_PATH: string;
let BOTS_PATH: string;

function makeBots(): BotConfig[] {
  return [
    { id: 'alpha', name: 'Alpha', token: 't1', enabled: true, skills: [] } as BotConfig,
    {
      id: 'beta',
      name: 'Beta',
      token: 't2',
      enabled: true,
      skills: [],
      model: 'old-model',
      llmBackend: 'ollama',
    } as BotConfig,
    { id: 'gamma', name: 'Gamma', token: 't3', enabled: true, skills: [] } as BotConfig,
  ];
}

function makeConfig(bots: BotConfig[]): Config {
  return {
    bots,
    ollama: { baseUrl: 'http://localhost:11434', timeout: 300_000, models: { primary: 'llama3' } },
    conversation: { enabled: true, systemPrompt: 'x', temperature: 0.7, maxHistory: 20 },
    soul: { dir: './config/soul' },
    productions: { baseDir: './productions' },
    agentLoop: { enabled: false, every: '6h' },
  } as unknown as Config;
}

function setup() {
  const config = makeConfig(makeBots());
  writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2));
  writeFileSync(BOTS_PATH, JSON.stringify(config.bots, null, 2));
  const app = new Hono();
  app.route(
    '/api/agents',
    agentsRoutes({
      config,
      botManager: {
        isRunning: () => false,
        getAvailableToolNames: () => [],
        getExternalSkillNames: () => [],
      } as any,
      configPath: CONFIG_PATH,
      logger: noopLogger,
    })
  );
  return { config, app };
}

/** Read what was actually written to bots.json, keyed by id. */
function persisted(): Record<string, BotConfig> {
  const arr = JSON.parse(readFileSync(BOTS_PATH, 'utf-8')) as BotConfig[];
  return Object.fromEntries(arr.map((b) => [b.id, b]));
}

function bulk(app: Hono, body: unknown) {
  return app.request('http://localhost/api/agents/bulk', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/agents/bulk', () => {
  beforeEach(() => {
    TEST_DIR = createTempDir('aibot-agents-bulk');
    CONFIG_PATH = join(TEST_DIR, 'config.json');
    BOTS_PATH = join(TEST_DIR, 'bots.json');
  });

  afterEach(() => {
    removeTempDir(TEST_DIR);
  });

  test('sets the model on every listed agent and persists once', async () => {
    const { app } = setup();

    const res = await bulk(app, { ids: ['alpha', 'gamma'], patch: { model: 'claude-opus-5' } });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.updated).toEqual(['alpha', 'gamma']);

    const after = persisted();
    expect(after.alpha.model).toBe('claude-opus-5');
    expect(after.gamma.model).toBe('claude-opus-5');
  });

  test('leaves agents that were not listed untouched', async () => {
    const { app } = setup();

    await bulk(app, { ids: ['alpha'], patch: { model: 'claude-opus-5' } });

    const after = persisted();
    expect(after.beta.model).toBe('old-model');
    expect(after.beta.llmBackend).toBe('ollama');
    expect(after.gamma.model).toBeUndefined();
  });

  test('sets llmBackend across agents', async () => {
    const { app } = setup();

    const res = await bulk(app, {
      ids: ['alpha', 'beta'],
      patch: { llmBackend: 'claude-cli' },
    });

    expect(res.status).toBe(200);
    const after = persisted();
    expect(after.alpha.llmBackend).toBe('claude-cli');
    expect(after.beta.llmBackend).toBe('claude-cli');
    // A backend change must not silently rewrite an unrelated per-agent model.
    expect(after.beta.model).toBe('old-model');
  });

  test('applies model and llmBackend together', async () => {
    const { app } = setup();

    await bulk(app, {
      ids: ['beta'],
      patch: { model: 'sonnet', llmBackend: 'claude-cli' },
    });

    const after = persisted();
    expect(after.beta.model).toBe('sonnet');
    expect(after.beta.llmBackend).toBe('claude-cli');
  });

  test('an empty string clears the override rather than storing ""', async () => {
    const { app } = setup();

    await bulk(app, { ids: ['beta'], patch: { model: '' } });

    expect(persisted().beta.model).toBeUndefined();
  });

  test('reports unknown ids without failing the whole request', async () => {
    const { app } = setup();

    const res = await bulk(app, { ids: ['alpha', 'nope'], patch: { model: 'haiku' } });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.updated).toEqual(['alpha']);
    expect(data.notFound).toEqual(['nope']);
    // The valid half still landed.
    expect(persisted().alpha.model).toBe('haiku');
  });

  test('rejects a missing or empty ids list', async () => {
    const { app } = setup();

    expect((await bulk(app, { patch: { model: 'x' } })).status).toBe(400);
    expect((await bulk(app, { ids: [], patch: { model: 'x' } })).status).toBe(400);
    expect((await bulk(app, { ids: 'alpha', patch: { model: 'x' } })).status).toBe(400);
  });

  test('rejects an empty patch so a mis-shaped call cannot silently no-op', async () => {
    const { app } = setup();

    expect((await bulk(app, { ids: ['alpha'], patch: {} })).status).toBe(400);
    expect((await bulk(app, { ids: ['alpha'] })).status).toBe(400);
  });

  test('rejects an invalid llmBackend value', async () => {
    const { app } = setup();

    const res = await bulk(app, { ids: ['alpha'], patch: { llmBackend: 'gpt' } });
    expect(res.status).toBe(400);
    expect(persisted().alpha.llmBackend).toBeUndefined();
  });

  test('does not shadow a single-agent PATCH', async () => {
    const { app } = setup();

    const res = await app.request('http://localhost/api/agents/alpha', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'single' }),
    });

    expect(res.status).toBe(200);
    expect(persisted().alpha.model).toBe('single');
  });
});
