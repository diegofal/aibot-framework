import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotConfig, Config } from '../../../src/config';
import { agentExportRoutes } from '../../../src/web/routes/agent-export';

const TEST_DIR = join(import.meta.dir, '..', '..', '..', '.test-export-tenant');
const SOUL_DIR = join(TEST_DIR, 'soul');
const CONFIG_PATH = join(TEST_DIR, 'config.json');

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as any;

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return { id: 'bot-a', name: 'Bot A', token: 'tok', enabled: true, skills: [], ...overrides };
}

function makeConfig(bots: BotConfig[]): Config {
  return {
    bots,
    soul: { dir: SOUL_DIR } as any,
    productions: { baseDir: join(TEST_DIR, 'prod'), enabled: true } as any,
    conversations: { baseDir: join(TEST_DIR, 'conv') } as any,
    karma: { baseDir: join(TEST_DIR, 'karma'), enabled: true } as any,
    ollama: { models: { primary: 'test' } } as any,
    conversation: {} as any,
    agentLoop: {} as any,
    paths: { data: join(TEST_DIR, 'data') } as any,
  } as Config;
}

describe('Export route tenant scoping', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, '{}', 'utf-8');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('blocks export of bot from different tenant', async () => {
    const bot = makeBot({ id: 'bot-a', tenantId: 'tenant-A' });
    const config = makeConfig([bot]);

    const app = new Hono();
    // Simulate tenant-B auth
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: 'tenant-B', apiKey: 'key', plan: 'pro' });
      return next();
    });
    app.route(
      '/api/agents',
      agentExportRoutes({
        config,
        configPath: CONFIG_PATH,
        botManager: { isRunning: () => false } as any,
        logger: noopLogger,
      })
    );

    const res = await app.request('/api/agents/bot-a/export');
    expect(res.status).toBe(404);
  });

  it('allows export of own tenant bot', async () => {
    const bot = makeBot({ id: 'bot-a', tenantId: 'tenant-A' });
    const config = makeConfig([bot]);
    const soulDir = join(SOUL_DIR, 'bot-a');
    mkdirSync(join(soulDir, 'memory'), { recursive: true });
    writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Bot A\n');

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: 'tenant-A', apiKey: 'key', plan: 'pro' });
      return next();
    });
    app.route(
      '/api/agents',
      agentExportRoutes({
        config,
        configPath: CONFIG_PATH,
        botManager: { isRunning: () => false } as any,
        logger: noopLogger,
      })
    );

    const res = await app.request('/api/agents/bot-a/export');
    expect(res.status).toBe(200);
  });

  it('allows admin to export any tenant bot', async () => {
    const bot = makeBot({ id: 'bot-a', tenantId: 'tenant-A' });
    const config = makeConfig([bot]);
    const soulDir = join(SOUL_DIR, 'bot-a');
    mkdirSync(join(soulDir, 'memory'), { recursive: true });
    writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Bot A\n');

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenant', { tenantId: '__admin__', apiKey: 'admin-key', plan: 'enterprise' });
      return next();
    });
    app.route(
      '/api/agents',
      agentExportRoutes({
        config,
        configPath: CONFIG_PATH,
        botManager: { isRunning: () => false } as any,
        logger: noopLogger,
      })
    );

    const res = await app.request('/api/agents/bot-a/export');
    expect(res.status).toBe(200);
  });
});
