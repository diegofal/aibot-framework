/**
 * `GET /api/agents/defaults` must hand the dashboard the Claude CLI model
 * list (the same one Settings → Claude CLI uses) and the fleet-wide default,
 * so the agent edit form can offer a per-agent override.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CLAUDE_CLI_MODEL_OPTIONS } from '../../../src/claude-cli';
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

const TEST_DIR = join(process.cwd(), '.test-agents-defaults-claude');
const CONFIG_PATH = join(TEST_DIR, 'config.json');

function makeApp(claudeCli?: { model?: string }) {
  const bots: BotConfig[] = [];
  const config = {
    bots,
    ollama: {
      baseUrl: 'http://localhost:11434',
      timeout: 1000,
      models: { primary: 'llama3', fallbacks: ['qwen'] },
    },
    claudeCli,
    conversation: { enabled: true, systemPrompt: '', temperature: 0.7, maxHistory: 20 },
    soul: { dir: './config/soul' },
    productions: { baseDir: './productions' },
    agentLoop: { enabled: false, every: '6h' },
  } as unknown as Config;
  writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2));
  const app = new Hono();
  app.route(
    '/api/agents',
    agentsRoutes({
      config,
      configPath: CONFIG_PATH,
      logger: noopLogger,
      botManager: {
        isRunning: () => false,
        getAvailableToolNames: () => [],
        getExternalSkillNames: () => [],
      } as never,
      skillRegistry: { listAvailable: async () => [] } as never,
    })
  );
  return app;
}

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe('GET /api/agents/defaults — Claude CLI models', () => {
  test('exposes the fleet-wide model and the option list', async () => {
    const res = await makeApp({ model: 'claude-opus-5' }).request(
      'http://localhost/api/agents/defaults'
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claudeCliModel).toBe('claude-opus-5');
    expect(body.claudeCliModels).toEqual(CLAUDE_CLI_MODEL_OPTIONS);
    expect(body.availableModels).toEqual(['llama3', 'qwen', 'claude-cli']);
  });
  test('empty string when no fleet-wide model is configured', async () => {
    const body = await (
      await makeApp(undefined).request('http://localhost/api/agents/defaults')
    ).json();
    expect(body.claudeCliModel).toBe('');
  });
});
