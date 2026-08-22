import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { settingsRoutes } from '../../../src/web/routes/settings';

// GET /api/settings/claude-cli used to hand the frontend a bare
// {enabled, crossBackendFallback, model} object, so the settings page could
// only offer a free-text field for `model` — no way to know what values are
// valid without hardcoding them client-side. It must publish the same
// canonical list `claude-cli.ts` uses to build the `--model` flag.

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

const TEST_DIR = join(process.cwd(), '.test-settings-claude-cli');
const CONFIG_PATH = join(TEST_DIR, 'config.json');

function makeApp(config: Config) {
  const app = new Hono();
  app.route('/api/settings', settingsRoutes({ config, configPath: CONFIG_PATH, logger: noopLogger }));
  return app;
}

function baseConfig(): Config {
  return {
    claudeCli: { enabled: true, crossBackendFallback: false },
  } as unknown as Config;
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ claudeCli: { enabled: true } }), 'utf-8');
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('GET /api/settings/claude-cli', () => {
  test('publishes the CLI-accepted model aliases as availableModels', async () => {
    const app = makeApp(baseConfig());
    const res = await app.request('/api/settings/claude-cli');
    const body = await res.json();

    expect(Array.isArray(body.availableModels)).toBe(true);
    const values = body.availableModels.map((m: { value: string }) => m.value);
    expect(values).toContain('opus');
    expect(values).toContain('sonnet');
    expect(values).toContain('haiku');
    // Empty value = "let the CLI use its own default" — must be a real, selectable option.
    expect(values).toContain('');
  });

  test('still returns enabled/crossBackendFallback/model alongside availableModels', async () => {
    const app = makeApp({
      claudeCli: { enabled: true, crossBackendFallback: true, model: 'sonnet' },
    } as unknown as Config);
    const res = await app.request('/api/settings/claude-cli');
    const body = await res.json();

    expect(body.enabled).toBe(true);
    expect(body.crossBackendFallback).toBe(true);
    expect(body.model).toBe('sonnet');
  });
});

describe('PATCH /api/settings/claude-cli', () => {
  test('accepts any of the published alias values', async () => {
    const app = makeApp(baseConfig());
    const res = await app.request('/api/settings/claude-cli', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'opus' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).model).toBe('opus');
  });

  test('still accepts a full model id not in the alias list (custom/dated ids)', async () => {
    const app = makeApp(baseConfig());
    const res = await app.request('/api/settings/claude-cli', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5-20251022' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).model).toBe('claude-sonnet-4-5-20251022');
  });
});
