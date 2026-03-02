import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotConfig, Config } from '../../../src/config';
import { agentExportRoutes } from '../../../src/web/routes/agent-export';

const TEST_DIR = join(import.meta.dir, '..', '..', '..', '.test-export-routes');
const SOUL_DIR = join(TEST_DIR, 'soul');
const PROD_DIR = join(TEST_DIR, 'productions');
const CONV_DIR = join(TEST_DIR, 'conversations');
const KARMA_DIR = join(TEST_DIR, 'karma');
const CONFIG_PATH = join(TEST_DIR, 'config.json');
const BOTS_PATH = join(TEST_DIR, 'bots.json');

function createMockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: () => createMockLogger(),
  } as any;
}

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'test-bot',
    name: 'Test Bot',
    token: 'secret-token-12345678',
    enabled: true,
    skills: ['skill1'],
    ...overrides,
  };
}

function makeConfig(bots: BotConfig[] = [makeBot()]): Config {
  return {
    bots,
    soul: { dir: SOUL_DIR } as any,
    productions: { baseDir: PROD_DIR, enabled: true } as any,
    conversations: { baseDir: CONV_DIR } as any,
    karma: { baseDir: KARMA_DIR, enabled: true } as any,
    ollama: { models: { primary: 'test-model' } } as any,
    conversation: {} as any,
    agentLoop: {} as any,
    paths: { data: join(TEST_DIR, 'data') } as any,
  } as Config;
}

function makeBotManager(runningBots: Set<string> = new Set()) {
  return {
    isRunning: (id: string) => runningBots.has(id),
  } as any;
}

function makeDeps(config: Config, botManager = makeBotManager()) {
  return {
    config,
    configPath: CONFIG_PATH,
    botManager,
    logger: createMockLogger(),
  };
}

function createApp(deps: ReturnType<typeof makeDeps>) {
  const app = new Hono();
  app.route('/api/agents', agentExportRoutes(deps));
  return app;
}

describe('agentExportRoutes', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
    writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('GET /:id/export', () => {
    it('exports a bot as tar.gz download', async () => {
      const bot = makeBot();
      const config = makeConfig([bot]);
      const soulDir = join(SOUL_DIR, 'test-bot');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Test Bot\n');

      const deps = makeDeps(config);
      const app = createApp(deps);

      const res = await app.request('/api/agents/test-bot/export');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/gzip');
      expect(res.headers.get('content-disposition')).toContain('test-bot-export-');
      expect(res.headers.get('content-disposition')).toContain('.tar.gz');

      const buffer = Buffer.from(await res.arrayBuffer());
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('returns 404 for non-existent bot', async () => {
      const config = makeConfig([]);
      const deps = makeDeps(config);
      const app = createApp(deps);

      const res = await app.request('/api/agents/nonexistent/export');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /import', () => {
    async function getExportBuffer(): Promise<Buffer> {
      const bot = makeBot({ id: 'export-bot', name: 'Export Bot' });
      const config = makeConfig([bot]);
      const soulDir = join(SOUL_DIR, 'export-bot');
      mkdirSync(join(soulDir, 'memory'), { recursive: true });
      writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Export Bot\n');
      writeFileSync(join(soulDir, 'SOUL.md'), '# Soul\nFriendly');

      const deps = makeDeps(config);
      const app = createApp(deps);

      const res = await app.request('/api/agents/export-bot/export');
      return Buffer.from(await res.arrayBuffer());
    }

    it('imports a bot from multipart upload', async () => {
      const exportBuffer = await getExportBuffer();

      // Clean up and create fresh state
      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      const config = makeConfig([]);
      const deps = makeDeps(config);
      const app = createApp(deps);

      const formData = new FormData();
      formData.append('file', new Blob([exportBuffer], { type: 'application/gzip' }), 'bot.tar.gz');

      const res = await app.request('/api/agents/import?newBotId=imported&newBotName=Imported', {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.botId).toBe('imported');
      expect(body.botName).toBe('Imported');
      expect(body.created).toBe(true);
    });

    it('imports from raw gzip body', async () => {
      const exportBuffer = await getExportBuffer();

      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      const config = makeConfig([]);
      const deps = makeDeps(config);
      const app = createApp(deps);

      const res = await app.request('/api/agents/import?newBotId=raw-import', {
        method: 'POST',
        body: exportBuffer,
        headers: { 'Content-Type': 'application/gzip' },
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.botId).toBe('raw-import');
    });

    it('returns 409 for existing bot without overwrite', async () => {
      const exportBuffer = await getExportBuffer();

      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), 'utf-8');
      writeFileSync(BOTS_PATH, JSON.stringify([], null, 2), 'utf-8');

      const existing = makeBot({ id: 'export-bot' });
      const config = makeConfig([existing]);
      const deps = makeDeps(config);
      const app = createApp(deps);

      const formData = new FormData();
      formData.append('file', new Blob([exportBuffer], { type: 'application/gzip' }), 'bot.tar.gz');

      const res = await app.request('/api/agents/import', {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(409);
    });

    it('returns 400 for empty file', async () => {
      const config = makeConfig([]);
      const deps = makeDeps(config);
      const app = createApp(deps);

      const res = await app.request('/api/agents/import', {
        method: 'POST',
        body: Buffer.alloc(0),
        headers: { 'Content-Type': 'application/gzip' },
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for running bot with overwrite', async () => {
      const config = makeConfig([makeBot({ id: 'running-bot' })]);
      const deps = makeDeps(config, makeBotManager(new Set(['running-bot'])));
      const app = createApp(deps);

      const res = await app.request('/api/agents/import?newBotId=running-bot&overwrite=true', {
        method: 'POST',
        body: Buffer.from('fake'),
        headers: { 'Content-Type': 'application/gzip' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Stop the agent');
    });

    it('returns 400 for unsupported content type', async () => {
      const config = makeConfig([]);
      const deps = makeDeps(config);
      const app = createApp(deps);

      const res = await app.request('/api/agents/import', {
        method: 'POST',
        body: 'not a file',
        headers: { 'Content-Type': 'text/plain' },
      });

      expect(res.status).toBe(400);
    });
  });
});
