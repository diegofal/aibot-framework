import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botsPathFromConfigPath, loadConfig, persistBots } from '../src/config';

const TEST_DIR = join(tmpdir(), `config-split-test-${Date.now()}`);

/** Minimal config that passes Zod validation (no bots needed). */
function makeBaseConfig() {
  return {
    ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'llama3' } },
    skills: { enabled: [], config: {} },
    logging: { level: 'info' },
    paths: { data: './data', logs: './data/logs', skills: './src/skills' },
  };
}

function makeBots() {
  return [
    { id: 'bot-1', name: 'Bot One', token: 'tok-111', skills: [], enabled: true },
    { id: 'bot-2', name: 'Bot Two', token: 'tok-222', skills: ['example'], enabled: false },
  ];
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe('botsPathFromConfigPath', () => {
  test('derives bots.json sibling path', () => {
    expect(botsPathFromConfigPath('/a/b/config.json')).toBe('/a/b/bots.json');
    expect(botsPathFromConfigPath('/home/user/config/config.json')).toBe(
      '/home/user/config/bots.json'
    );
  });
});

describe('persistBots', () => {
  test('writes bots to bots.json next to configPath', () => {
    const configPath = join(TEST_DIR, 'config.json');
    const botsPath = join(TEST_DIR, 'bots.json');
    writeFileSync(configPath, '{}');

    const bots = makeBots();
    persistBots(configPath, bots as any);

    expect(existsSync(botsPath)).toBe(true);
    const written = JSON.parse(readFileSync(botsPath, 'utf-8'));
    expect(written).toHaveLength(2);
    expect(written[0].id).toBe('bot-1');
    expect(written[1].token).toBe('tok-222');
  });
});

describe('loadConfig', () => {
  test('loads bots from bots.json when present', async () => {
    const configPath = join(TEST_DIR, 'config.json');
    const botsPath = join(TEST_DIR, 'bots.json');

    writeFileSync(configPath, JSON.stringify(makeBaseConfig(), null, 2));
    writeFileSync(botsPath, JSON.stringify(makeBots(), null, 2));

    const config = await loadConfig(configPath);
    expect(config.bots).toHaveLength(2);
    expect(config.bots[0].id).toBe('bot-1');
    expect(config.bots[1].id).toBe('bot-2');
  });

  test('falls back to inline bots in config.json', async () => {
    const configPath = join(TEST_DIR, 'config.json');
    const base = makeBaseConfig();
    const full = { ...base, bots: makeBots() };
    writeFileSync(configPath, JSON.stringify(full, null, 2));
    // No bots.json → triggers auto-migration

    const config = await loadConfig(configPath);
    expect(config.bots).toHaveLength(2);
    expect(config.bots[0].id).toBe('bot-1');
  });

  test('auto-migrates: creates bots.json and strips bots from config.json', async () => {
    const configPath = join(TEST_DIR, 'config.json');
    const botsPath = join(TEST_DIR, 'bots.json');
    const base = makeBaseConfig();
    const full = { ...base, bots: makeBots() };
    writeFileSync(configPath, JSON.stringify(full, null, 2));

    expect(existsSync(botsPath)).toBe(false);

    await loadConfig(configPath);

    // bots.json should now exist
    expect(existsSync(botsPath)).toBe(true);
    const migratedBots = JSON.parse(readFileSync(botsPath, 'utf-8'));
    expect(migratedBots).toHaveLength(2);

    // config.json should no longer have bots
    const rawConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(rawConfig.bots).toBeUndefined();
    // Other keys preserved
    expect(rawConfig.ollama).toBeDefined();
    expect(rawConfig.logging).toBeDefined();
  });

  test('returns empty bots when neither bots.json nor inline bots exist', async () => {
    const configPath = join(TEST_DIR, 'config.json');
    writeFileSync(configPath, JSON.stringify(makeBaseConfig(), null, 2));

    const config = await loadConfig(configPath);
    expect(config.bots).toEqual([]);
  });

  test('bots.json takes precedence over inline bots in config.json', async () => {
    const configPath = join(TEST_DIR, 'config.json');
    const botsPath = join(TEST_DIR, 'bots.json');
    const base = makeBaseConfig();
    const full = {
      ...base,
      bots: [{ id: 'inline', name: 'Inline', token: '', skills: [], enabled: true }],
    };
    writeFileSync(configPath, JSON.stringify(full, null, 2));
    writeFileSync(
      botsPath,
      JSON.stringify([{ id: 'external', name: 'External', token: '', skills: [], enabled: true }])
    );

    const config = await loadConfig(configPath);
    expect(config.bots).toHaveLength(1);
    expect(config.bots[0].id).toBe('external');
  });
});
