import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const TEST_DIR = join(process.cwd(), '.test-agents-tts-routes');
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

function makeConfig(bots: BotConfig[], mediaTts?: any): Config {
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
    },
    media: mediaTts
      ? {
          enabled: true,
          maxFileSizeMb: 10,
          tts: mediaTts,
        }
      : undefined,
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

describe('agents routes - TTS', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  function setupConfig(bots: BotConfig[], mediaTts?: any) {
    const config = makeConfig(bots, mediaTts);
    writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2));
    writeFileSync(BOTS_PATH, JSON.stringify(config.bots, null, 2));
    return { config, app: makeApp(config, CONFIG_PATH) };
  }

  describe('GET /defaults', () => {
    test('includes ttsEnabled=true and ttsVoiceId when TTS configured', async () => {
      const { app } = setupConfig(makeBots(), {
        provider: 'elevenlabs',
        apiKey: 'test-key',
        voiceId: 'pMsXg123',
      });

      const res = await app.request('http://localhost/api/agents/defaults');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ttsEnabled).toBe(true);
      expect(data.ttsVoiceId).toBe('pMsXg123');
    });

    test('includes ttsEnabled=false when TTS not configured', async () => {
      const { app } = setupConfig(makeBots());

      const res = await app.request('http://localhost/api/agents/defaults');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ttsEnabled).toBe(false);
      expect(data.ttsVoiceId).toBeUndefined();
    });
  });

  describe('PATCH /:id - tts override', () => {
    test('persists tts override with voiceId', async () => {
      const bots = makeBots();
      const { config, app } = setupConfig(bots);

      const res = await app.request('http://localhost/api/agents/bot1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tts: { voiceId: 'newVoice123' } }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(config.bots[0].tts).toEqual({ voiceId: 'newVoice123' });
    });

    test('persists tts override with voiceSettings', async () => {
      const bots = makeBots();
      const { config, app } = setupConfig(bots);

      const res = await app.request('http://localhost/api/agents/bot1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tts: {
            voiceId: 'voice456',
            voiceSettings: { speed: 1.2, stability: 0.8 },
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(config.bots[0].tts).toEqual({
        voiceId: 'voice456',
        voiceSettings: { speed: 1.2, stability: 0.8 },
      });
    });

    test('clears tts override when set to undefined', async () => {
      const bots = makeBots();
      bots[0].tts = { voiceId: 'old-voice' } as any;
      const { config, app } = setupConfig(bots);

      const res = await app.request('http://localhost/api/agents/bot1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tts: null }),
      });

      expect(res.status).toBe(200);
      expect(config.bots[0].tts).toBeUndefined();
    });

    test('clears tts override when all values are undefined', async () => {
      const bots = makeBots();
      bots[0].tts = { voiceId: 'old-voice' } as any;
      const { config, app } = setupConfig(bots);

      const res = await app.request('http://localhost/api/agents/bot1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tts: {} }),
      });

      expect(res.status).toBe(200);
      expect(config.bots[0].tts).toBeUndefined();
    });

    test('tts override is persisted to config file', async () => {
      const bots = makeBots();
      const { app } = setupConfig(bots);

      await app.request('http://localhost/api/agents/bot1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tts: { voiceId: 'persisted-voice' } }),
      });

      const raw = JSON.parse(readFileSync(BOTS_PATH, 'utf-8'));
      expect(raw[0].tts).toEqual({ voiceId: 'persisted-voice' });
    });
  });
});
