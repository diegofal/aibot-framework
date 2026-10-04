/**
 * Presets over HTTP (session S7 of docs/plans/jarvis-fleet-plan.md):
 * `GET /api/agents/presets` lists the catalogue and `POST /api/agents` with
 * `preset: '<id>'` applies it server-side under whatever the caller sent.
 * The soul generator is injected — no LLM.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { getPreset, listPresets } from '../../../src/bot/presets';
import type { BotConfig, Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import type { GeneratedSoul, SoulGenerationInput } from '../../../src/soul-generator';
import { parseGoals } from '../../../src/tools/goals';
import { agentsRoutes } from '../../../src/web/routes/agents';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as unknown as Logger;

const SOUL: GeneratedSoul = {
  identity: 'name: Scout\nemoji: 🔬',
  soul: '## Personality Foundation\n- curious',
  motivations: '## Core Drives\n- learn',
};

let dir: string;
let configPath: string;
let botsPath: string;

beforeEach(() => {
  dir = createTempDir('agents-presets');
  configPath = join(dir, 'config.json');
  botsPath = join(dir, 'bots.json');
  require('node:fs').writeFileSync(configPath, '{}');
  require('node:fs').writeFileSync(botsPath, '[]');
});
afterEach(() => removeTempDir(dir));

function setup(bots: BotConfig[] = []) {
  const config = {
    bots,
    paths: { data: join(dir, 'data') },
    multiTenant: { enabled: false, dataDir: join(dir, 'data', 'tenants') },
    ollama: { baseUrl: 'http://localhost:11434', timeout: 1000, models: { primary: 'llama3' } },
    claudeCli: { model: 'claude-opus-5' },
    conversation: { enabled: true, systemPrompt: '', temperature: 0.7, maxHistory: 20 },
    soul: { dir: join(dir, 'config-soul') },
    productions: { baseDir: join(dir, 'productions') },
    agentLoop: { enabled: false, every: '6h' },
  } as unknown as Config;
  const generatorCalls: SoulGenerationInput[] = [];
  const app = new Hono();
  app.route(
    '/api/agents',
    agentsRoutes({
      config,
      configPath,
      logger: noopLogger,
      botManager: {
        isRunning: () => false,
        getAvailableToolNames: () => [],
        getExternalSkillNames: () => [],
        getOllamaClient: () => ({ generate: async () => ({ text: JSON.stringify(SOUL) }) }),
      } as never,
      skillRegistry: { listAvailable: async () => [{ id: 'reflect' }] } as never,
      wizard: {
        generateSoul: async (input) => {
          generatorCalls.push(input);
          return SOUL;
        },
        telegramCheck: async () => ({ ok: true, username: 'x' }),
      },
    })
  );
  return { app, config, generatorCalls };
}

const get = (app: Hono, path: string) => app.request(`http://localhost${path}`);
const post = (app: Hono, path: string, body: unknown) =>
  app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const goalsFile = (id: string) =>
  join(dir, 'data', 'tenants', '__admin__', 'bots', id, 'soul', 'GOALS.md');
const traitsFile = (id: string) =>
  join(dir, 'data', 'tenants', '__admin__', 'bots', id, 'TRAITS.json');

describe('GET /api/agents/presets', () => {
  it('lists the five presets with card fields and the wizard prefill', async () => {
    const { app } = setup();
    const res = await get(app, '/api/agents/presets');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((p: { id: string }) => p.id)).toEqual([
      'assistant',
      'researcher',
      'job-seeker',
      'coder',
      'social',
    ]);
    for (const p of body) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.emoji).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(typeof p.purpose).toBe('string');
      expect(Object.keys(p.personality).sort()).toEqual([
        'boldness',
        'playfulness',
        'rigor',
        'warmth',
      ]);
      expect(Array.isArray(p.skills)).toBe(true);
      expect(Array.isArray(p.disabledTools)).toBe(true);
      expect(typeof p.agentLoop.every).toBe('string');
      expect(Array.isArray(p.goals)).toBe(true);
    }
  });

  it('is not shadowed by /:id (an agent literally named "presets" is unreachable by GET, like "defaults")', async () => {
    const { app } = setup([{ id: 'presets', name: 'P', token: '', skills: [] } as BotConfig]);
    const body = await (await get(app, '/api/agents/presets')).json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(listPresets().length);
  });
});

describe('POST /api/agents with preset', () => {
  it('{ id, preset } alone builds the whole agent from the preset: name, purpose, skills, tools, loop, goals, traits', async () => {
    const { app, config, generatorCalls } = setup();
    const preset = getPreset('researcher');
    if (!preset) throw new Error('missing preset');
    const res = await post(app, '/api/agents', { id: 'scout', preset: 'researcher', token: null });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent).toMatchObject({
      id: 'scout',
      name: preset.name,
      token: '',
      skills: preset.skills,
      disabledTools: preset.disabledTools,
      preset: 'researcher',
    });
    expect(body.agent.agentLoop).toMatchObject(preset.agentLoop);
    expect(body.soul.generated).toBe(true);
    expect(body.soul.preset).toBe('researcher');

    // The generator saw the preset's purpose, quirks and emoji.
    expect(generatorCalls.length).toBe(1);
    expect(generatorCalls[0].role).toBe(preset.purpose);
    expect(generatorCalls[0].personalityDescription).toContain(preset.quirks);
    expect(generatorCalls[0].emoji).toBe(preset.emoji);

    // GOALS.md: purpose goal + the preset's goals, parseable.
    const { active } = parseGoals(readFileSync(goalsFile('scout'), 'utf-8'));
    expect(active.length).toBe(preset.goals.length + 1);
    expect(active[1].text).toBe(preset.goals[0].text);
    expect(active[1].source).toBe('preset:researcher');

    // TRAITS.json from the preset's sliders (rigor 0.9 -> depth 0.82).
    const traits = JSON.parse(readFileSync(traitsFile('scout'), 'utf-8'));
    expect(traits.current.depth).toBe(0.82);

    // Persisted with the preset stamp and loop cadence.
    const persisted = JSON.parse(readFileSync(botsPath, 'utf-8'));
    expect(persisted[0]).toMatchObject({
      id: 'scout',
      preset: 'researcher',
      skills: preset.skills,
      disabledTools: preset.disabledTools,
      agentLoop: preset.agentLoop,
    });
    expect(config.bots[0].agentLoop?.every).toBe(preset.agentLoop.every);
  });

  it('what the caller sends wins over the preset, field by field', async () => {
    const { app, generatorCalls } = setup();
    const preset = getPreset('coder');
    if (!preset) throw new Error('missing preset');
    const res = await post(app, '/api/agents', {
      id: 'forge',
      preset: 'coder',
      name: 'My Forge',
      purpose: 'Only fixes flaky tests.',
      quirks: '',
      personality: { warmth: 1 },
      skills: ['reflect'],
      agentLoop: { every: '30m' },
      token: null,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.name).toBe('My Forge');
    expect(body.agent.skills).toEqual(['reflect']);
    expect(body.agent.disabledTools).toEqual(preset.disabledTools);
    expect(body.agent.agentLoop).toMatchObject({ every: '30m', mode: preset.agentLoop.mode });
    expect(generatorCalls[0].role).toBe('Only fixes flaky tests.');
    expect(generatorCalls[0].personalityDescription).not.toContain(preset.quirks);
    // warmth overridden to 1 -> sociability 0.9; rigor still the preset's 0.9 -> depth 0.82
    const traits = JSON.parse(readFileSync(traitsFile('forge'), 'utf-8'));
    expect(traits.current.sociability).toBe(0.9);
    expect(traits.current.depth).toBe(0.82);
    const { active } = parseGoals(readFileSync(goalsFile('forge'), 'utf-8'));
    expect(active[0].text).toContain('Only fixes flaky tests.');
  });

  it('an unknown preset is a 400 and nothing is written', async () => {
    const { app, config, generatorCalls } = setup();
    const res = await post(app, '/api/agents', { id: 'x', name: 'X', preset: 'wizardry' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('preset');
    expect(generatorCalls).toEqual([]);
    expect(config.bots).toEqual([]);
  });

  it('the legacy payload with a preset stays legacy-shaped only when no purpose results (never: presets carry one)', async () => {
    // A preset always brings a purpose, so `{ id, preset }` is a wizard creation —
    // documented behaviour, asserted here so nobody "optimises" it away.
    const { app, generatorCalls } = setup();
    const res = await post(app, '/api/agents', { id: 'jarvis', preset: 'assistant' });
    expect(res.status).toBe(201);
    expect((await res.json()).soul.generated).toBe(true);
    expect(generatorCalls.length).toBe(1);
  });

  it('without a preset the wizard payload is byte-for-byte what S6 shipped (no preset stamp, one goal)', async () => {
    const { app } = setup();
    const res = await post(app, '/api/agents', {
      id: 'ada',
      name: 'Ada',
      purpose: 'Keeps my reading list alive.',
      token: null,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.preset).toBeUndefined();
    expect(body.soul.preset).toBeUndefined();
    expect(body.agent.agentLoop).toBeUndefined();
    const { active } = parseGoals(readFileSync(goalsFile('ada'), 'utf-8'));
    expect(active.length).toBe(1);
  });
});
