/**
 * A freshly seeded deployment must be inert.
 *
 * `docker-entrypoint.sh` copies `config/*.example.json` into an empty config
 * volume on first boot, and Compose injects the operator's real `.env` on that
 * same boot. Anything the examples leave live-by-default therefore takes effect
 * the instant a container starts with production credentials — which, during a
 * cutover, is while the previous instance is still running. Telegram allows one
 * `getUpdates` consumer per token; two of them drop messages silently.
 *
 * These tests pin the seeded state so that hazard cannot be reintroduced by an
 * edit to the example files. They assert on the shipped files themselves rather
 * than on fixtures, because the shipped files are the artefact being shipped.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoStartEnabledBots } from '../src/bot/auto-start';
import { loadConfig } from '../src/config';
import type { Logger } from '../src/logger';

const REPO_ROOT = join(import.meta.dir, '..');
const BOTS_EXAMPLE = join(REPO_ROOT, 'config', 'bots.example.json');
const CONFIG_EXAMPLE = join(REPO_ROOT, 'config', 'config.example.json');
const ENTRYPOINT = join(REPO_ROOT, 'docker-entrypoint.sh');

const TEST_DIR = join(tmpdir(), `seeded-deployment-test-${Date.now()}`);
const SAVED_ENV = { ...process.env };

/** Replays what the entrypoint does: copy the examples into an empty volume. */
function seedConfigVolume(): string {
  const configPath = join(TEST_DIR, 'config.json');
  copyFileSync(CONFIG_EXAMPLE, configPath);
  copyFileSync(BOTS_EXAMPLE, join(TEST_DIR, 'bots.json'));
  return configPath;
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  // Supplied by Compose on a real boot; without it the URL fails validation.
  process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  process.env = { ...SAVED_ENV };
});

describe('config/bots.example.json', () => {
  test('ships every bot disabled', () => {
    const bots = JSON.parse(readFileSync(BOTS_EXAMPLE, 'utf-8'));
    expect(Array.isArray(bots)).toBe(true);
    expect(bots.length).toBeGreaterThan(0);
    for (const bot of bots) {
      expect({ id: bot.id, enabled: bot.enabled }).toEqual({ id: bot.id, enabled: false });
    }
  });

  test('carries no literal tokens — only ${VAR} references', () => {
    const bots = JSON.parse(readFileSync(BOTS_EXAMPLE, 'utf-8'));
    for (const bot of bots) {
      expect(bot.token).toMatch(/^\$\{[A-Z0-9_]+\}$/);
    }
  });
});

describe('a config volume seeded from the examples', () => {
  test('loads with zero enabled bots', async () => {
    const config = await loadConfig(seedConfigVolume());
    expect(config.bots.length).toBeGreaterThan(0);
    expect(config.bots.filter((b) => b.enabled).map((b) => b.id)).toEqual([]);
  });

  test('opens no network listener and runs no autonomous loop', async () => {
    const config = await loadConfig(seedConfigVolume());
    // Each of these starts a server or drives an agent unattended once a bot
    // is running, so none may be live on a boot the operator has not blessed.
    expect(config.web.enabled).toBe(false);
    expect(config.agentLoop.enabled).toBe(false);
    expect(config.mcp.expose.enabled).toBe(false);
    expect(config.a2a.enabled).toBe(false);
    expect(config.multiTenant.enabled).toBe(false);
  });

  test('enables no credential-consuming outbound integration', async () => {
    const config = await loadConfig(seedConfigVolume());
    expect(config.reddit?.enabled ?? false).toBe(false);
    expect(config.twitter?.enabled ?? false).toBe(false);
    expect(config.calendar?.enabled ?? false).toBe(false);
    expect(config.phoneCall?.enabled ?? false).toBe(false);
    expect(config.media.enabled).toBe(false);
    expect(config.webTools.enabled).toBe(false);
  });

  test('grants no filesystem or process reach', async () => {
    const config = await loadConfig(seedConfigVolume());
    expect(config.exec.enabled).toBe(false);
    expect(config.fileTools.enabled).toBe(false);
    expect(config.processTools.enabled).toBe(false);
    expect(config.browserTools.enabled).toBe(false);
  });

  test('auto-starts nothing, even though auto-start is on by default', async () => {
    // Boot-time auto-start is now enabled by default — a restart has to heal
    // itself. A fresh volume stays inert on the strength of one fact only:
    // every seeded bot ships `enabled: false`. That is the fact this asserts,
    // by running the real auto-start against the real seeded config.
    const config = await loadConfig(seedConfigVolume());
    expect(config.startup.autoStartBots).toBe(true);

    const started: string[] = [];
    const noop = (() => {
      const logger = {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => logger,
      };
      return logger as unknown as Logger;
    })();

    const result = await autoStartEnabledBots({
      bots: config.bots,
      startBot: async (bot) => {
        started.push(bot.id);
      },
      logger: noop,
    });

    expect(started).toEqual([]);
    expect(result.started).toEqual([]);
    expect(result.skippedDisabled).toEqual(config.bots.map((b) => b.id));
  });

  test('survives a boot with no Telegram tokens in the environment', async () => {
    // biome-ignore lint/performance/noDelete: only way to truly unset an env var
    delete process.env.TELEGRAM_BOT_TOKEN;
    // biome-ignore lint/performance/noDelete: only way to truly unset an env var
    delete process.env.TELEGRAM_BOT_TOKEN_AGENT;
    const config = await loadConfig(seedConfigVolume());
    for (const bot of config.bots) expect(bot.token).toBe('');
  });
});

describe('docker-entrypoint.sh', () => {
  const script = readFileSync(ENTRYPOINT, 'utf-8');

  test('seeds bots.json from the example that ships them disabled', () => {
    expect(script).toContain('bots.example.json');
    expect(script).toMatch(/cp "\$DEFAULTS_DIR\/bots\.example\.json" "\$CONFIG_DIR\/bots\.json"/);
  });

  test('never overwrites an existing bots.json', () => {
    expect(script).toMatch(/if \[ ! -f "\$CONFIG_DIR\/bots\.json" \]/);
  });

  test('announces the disabled-by-default state on first seed', () => {
    expect(script).toMatch(/seeded_bots=1/);
    expect(script).toMatch(/if \[ "\$seeded_bots" = 1 \]/);
    expect(script).toContain('DISABLED and STOPPED');
  });

  test('does not claim bots are never restarted automatically — they are, when enabled', () => {
    // The banner used to say bots never come back after a container restart.
    // That was true and is now false; an operator acting on it would babysit
    // every deploy for no reason.
    expect(script).not.toMatch(/NOT restarted automatically/i);
  });
});
