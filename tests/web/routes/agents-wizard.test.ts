/**
 * The create-an-agent wizard's backend (session S6 of docs/plans/jarvis-fleet-plan.md):
 * `POST /api/agents` with `{ purpose, personality | traits, quirks }` and
 * `POST /api/agents/validate-token`. The soul generator and the Telegram check
 * are injected — no LLM, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { BotConfig, Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import type { GeneratedSoul, SoulGenerationInput } from '../../../src/soul-generator';
import { agentsRoutes } from '../../../src/web/routes/agents';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as unknown as Logger;

const SHAPED = `123456789:${'a'.repeat(35)}`;
const SOUL: GeneratedSoul = {
  identity: 'name: Ada\nemoji: 🦉\nvibe: quietly brilliant',
  soul: '## Personality Foundation\n- curious',
  motivations: '## Core Drives\n- learn',
};

let dir: string;
let configPath: string;
let botsPath: string;

beforeEach(() => {
  dir = createTempDir('agents-wizard');
  configPath = join(dir, 'config.json');
  botsPath = join(dir, 'bots.json');
  writeFileSync(configPath, '{}');
  writeFileSync(botsPath, '[]');
});
afterEach(() => removeTempDir(dir));

function makeConfig(bots: BotConfig[] = []): Config {
  return {
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
}

interface Harness {
  app: Hono;
  config: Config;
  generatorCalls: SoulGenerationInput[];
  checkerCalls: string[];
}

function setup(
  opts: {
    bots?: BotConfig[];
    generate?: (input: SoulGenerationInput) => Promise<GeneratedSoul>;
    telegramCheck?: (
      token: string
    ) => Promise<
      { ok: true; username: string } | { ok: false; unauthorized: boolean; message: string }
    >;
    ollamaGenerate?: (prompt: string) => Promise<string>;
  } = {}
): Harness {
  const config = makeConfig(opts.bots ?? []);
  const generatorCalls: SoulGenerationInput[] = [];
  const checkerCalls: string[] = [];
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
        getOllamaClient: () => ({
          generate: async (prompt: string) => ({
            text: opts.ollamaGenerate ? await opts.ollamaGenerate(prompt) : JSON.stringify(SOUL),
          }),
        }),
      } as never,
      skillRegistry: { listAvailable: async () => [{ id: 'reflect' }] } as never,
      wizard: {
        generateSoul: async (input, genOpts) => {
          generatorCalls.push(input);
          if (opts.generate) return opts.generate(input);
          // The ollama path hands us a `generate` function; exercise it so the
          // test can see which backend the route chose.
          if (genOpts.generate) return JSON.parse(await genOpts.generate('p')) as GeneratedSoul;
          return SOUL;
        },
        telegramCheck: async (token) => {
          checkerCalls.push(token);
          if (opts.telegramCheck) return opts.telegramCheck(token);
          return { ok: true, username: 'ada_bot' };
        },
      },
    })
  );
  return { app, config, generatorCalls, checkerCalls };
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const wizardBody = (extra: Record<string, unknown> = {}) => ({
  id: 'ada',
  name: 'Ada',
  purpose: 'Keeps my reading list alive.',
  personality: { warmth: 1, boldness: 0, rigor: 0.5, playfulness: 0.5 },
  quirks: 'Loves puns',
  token: null,
  enabled: true,
  greet: true,
  ...extra,
});

describe('POST /api/agents — legacy payload', () => {
  it('is unchanged: flat bot body, disabled, token kept, no soul written', async () => {
    const h = setup();
    const res = await post(h.app, '/api/agents', {
      id: 'old',
      name: 'Old',
      token: 'tok-secret-1234',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('old');
    expect(body.enabled).toBe(false);
    expect(body.token).toBe('tok-****1234');
    expect(body.skills).toEqual(['reflect']);
    expect(body.agent).toBeUndefined();
    expect(body.soul).toBeUndefined();
    expect(h.generatorCalls).toEqual([]);
    expect(JSON.parse(readFileSync(botsPath, 'utf-8'))[0].id).toBe('old');
    expect(existsSync(join(dir, 'data'))).toBe(false);
  });
  it('still requires id and name and rejects duplicates', async () => {
    const h = setup({ bots: [{ id: 'dup', name: 'Dup', token: '', skills: [] } as BotConfig] });
    expect((await post(h.app, '/api/agents', { name: 'x' })).status).toBe(400);
    expect((await post(h.app, '/api/agents', { id: 'dup', name: 'x' })).status).toBe(409);
  });
  it('rejects ids that cannot be a directory name', async () => {
    const h = setup();
    for (const id of ['bad/id', 'bad\\id', '..', 'a b', '']) {
      const res = await post(h.app, '/api/agents', { id, name: 'x' });
      expect([id, res.status]).toEqual([id, 400]);
    }
  });
});

describe('POST /api/agents — wizard payload', () => {
  it('generates and applies the soul, seeds TRAITS.json and answers { agent, soul }', async () => {
    const h = setup();
    const res = await post(h.app, '/api/agents', wizardBody());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent).toMatchObject({ id: 'ada', name: 'Ada', token: '', enabled: true });
    expect(body.agent.running).toBe(false);
    expect(body.soul.generated).toBe(true);
    expect(body.soul.files).toEqual([
      'IDENTITY.md',
      'SOUL.md',
      'MOTIVATIONS.md',
      'GOALS.md',
      'TRAITS.json',
    ]);

    const soulDir = join(dir, 'data', 'tenants', '__admin__', 'bots', 'ada', 'soul');
    // resolveAgentConfig joins with '/', node:path with the platform separator.
    expect(body.soul.soulDir.replace(/\\/g, '/')).toBe(soulDir.replace(/\\/g, '/'));
    expect(readFileSync(join(soulDir, 'IDENTITY.md'), 'utf-8')).toBe(SOUL.identity);
    expect(readFileSync(join(soulDir, 'SOUL.md'), 'utf-8')).toBe(SOUL.soul);
    expect(readFileSync(join(soulDir, 'MOTIVATIONS.md'), 'utf-8')).toBe(SOUL.motivations);
    expect(readFileSync(join(soulDir, '.baseline', 'IDENTITY.md'), 'utf-8')).toBe(SOUL.identity);
    expect(readFileSync(join(soulDir, 'GOALS.md'), 'utf-8')).toContain(
      'Keeps my reading list alive.'
    );

    // TRAITS.json where BotManager's TraitRegisters reads it: <paths.data>/tenants/__admin__/bots/<id>/
    const traitsFile = join(dir, 'data', 'tenants', '__admin__', 'bots', 'ada', 'TRAITS.json');
    const traits = JSON.parse(readFileSync(traitsFile, 'utf-8'));
    expect(traits.current).toEqual({
      sociability: 0.9,
      independence: 0.1,
      risk_tolerance: 0.1,
      caution: 0.9,
      depth: 0.5,
      persistence: 0.5,
      creativity: 0.5,
      curiosity: 0.5,
    });
    expect(traits.history[0].source).toBe('adaptive');

    // The generator saw the purpose as the role and the sliders + quirks as prose.
    expect(h.generatorCalls.length).toBe(1);
    expect(h.generatorCalls[0].name).toBe('Ada');
    expect(h.generatorCalls[0].role).toContain('Keeps my reading list alive.');
    expect(h.generatorCalls[0].personalityDescription).toContain('Loves puns');
    expect(h.generatorCalls[0].personalityDescription).toMatch(/warm/i);

    // Persisted, headless, enabled, all skills by default.
    const persisted = JSON.parse(readFileSync(botsPath, 'utf-8'));
    expect(persisted[0]).toMatchObject({
      id: 'ada',
      token: '',
      enabled: true,
      skills: ['reflect'],
    });
    expect(h.config.bots[0].token).toBe('');
  });

  it('accepts explicit traits instead of sliders and clamps them', async () => {
    const h = setup();
    const res = await post(
      h.app,
      '/api/agents',
      wizardBody({ personality: undefined, traits: { curiosity: 0.95, caution: 0.2 } })
    );
    expect(res.status).toBe(201);
    const traits = JSON.parse(
      readFileSync(join(dir, 'data', 'tenants', '__admin__', 'bots', 'ada', 'TRAITS.json'), 'utf-8')
    );
    expect(traits.current.curiosity).toBe(0.9);
    expect(traits.current.caution).toBe(0.2);
    expect(traits.current.depth).toBe(0.5);
  });

  it('keeps a Telegram token, channel configs, language, emoji and model overrides', async () => {
    const h = setup();
    const res = await post(
      h.app,
      '/api/agents',
      wizardBody({
        token: SHAPED,
        whatsapp: { phoneNumberId: '1', accessToken: 'EAAB' },
        discord: { token: 'd.t.k' },
        language: 'English',
        emoji: '🦉',
        llmBackend: 'claude-cli',
        model: 'claude-opus-5',
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.token).toBe(`${SHAPED.slice(0, 4)}****${SHAPED.slice(-4)}`);
    expect(h.config.bots[0].token).toBe(SHAPED);
    expect(h.config.bots[0].whatsapp).toEqual({ phoneNumberId: '1', accessToken: 'EAAB' });
    expect(h.config.bots[0].discord).toEqual({ token: 'd.t.k' });
    expect(h.config.bots[0].llmBackend).toBe('claude-cli');
    expect(h.config.bots[0].model).toBe('claude-opus-5');
    expect(h.generatorCalls[0].language).toBe('English');
    expect(h.generatorCalls[0].emoji).toBe('🦉');
  });

  it('routes soul generation to Ollama when asked', async () => {
    const prompts: string[] = [];
    const h = setup({
      ollamaGenerate: async (p) => {
        prompts.push(p);
        return JSON.stringify(SOUL);
      },
    });
    const res = await post(
      h.app,
      '/api/agents',
      wizardBody({ generation: { llmBackend: 'ollama', model: 'qwen' } })
    );
    expect(res.status).toBe(201);
    expect(prompts.length).toBe(1);
  });

  it('a generator failure leaves no bot behind (502, nothing persisted, no soul dir)', async () => {
    const h = setup({
      generate: async () => {
        throw new Error('Claude CLI exited 1');
      },
    });
    const res = await post(h.app, '/api/agents', wizardBody());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('soul_generation_failed');
    expect(body.error).toContain('Claude CLI exited 1');
    expect(h.config.bots).toEqual([]);
    expect(JSON.parse(readFileSync(botsPath, 'utf-8'))).toEqual([]);
    expect(existsSync(join(dir, 'data', 'tenants', '__admin__', 'bots', 'ada'))).toBe(false);
  });

  it('a write failure after generation rolls back (500, nothing persisted)', async () => {
    const h = setup();
    // A *file* where the soul dir must go makes mkdir fail after the soul was generated.
    const botDir = join(dir, 'data', 'tenants', '__admin__', 'bots', 'ada');
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(botDir, 'soul'), 'not a directory');
    const res = await post(h.app, '/api/agents', wizardBody());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('soul_write_failed');
    expect(h.generatorCalls.length).toBe(1);
    expect(h.config.bots).toEqual([]);
    expect(JSON.parse(readFileSync(botsPath, 'utf-8'))).toEqual([]);
    expect(existsSync(join(botDir, 'TRAITS.json'))).toBe(false);
  });

  it('refuses to overwrite an existing soul dir for a new id', async () => {
    const h = setup();
    const soulDir = join(dir, 'data', 'tenants', '__admin__', 'bots', 'ada', 'soul');
    mkdirSync(soulDir, { recursive: true });
    writeFileSync(join(soulDir, 'IDENTITY.md'), 'name: Old Ada');
    const res = await post(h.app, '/api/agents', wizardBody());
    expect(res.status).toBe(409);
    expect(readFileSync(join(soulDir, 'IDENTITY.md'), 'utf-8')).toBe('name: Old Ada');
    expect(h.generatorCalls).toEqual([]);
    expect(h.config.bots).toEqual([]);
  });

  it('validates purpose and personality shapes', async () => {
    const h = setup();
    expect((await post(h.app, '/api/agents', wizardBody({ purpose: '   ' }))).status).toBe(400);
    expect(
      (await post(h.app, '/api/agents', wizardBody({ personality: { warmth: 'hot' } }))).status
    ).toBe(400);
    expect(h.generatorCalls).toEqual([]);
  });

  it('duplicate id is refused before the generator runs', async () => {
    const h = setup({ bots: [{ id: 'ada', name: 'Ada', token: '', skills: [] } as BotConfig] });
    expect((await post(h.app, '/api/agents', wizardBody())).status).toBe(409);
    expect(h.generatorCalls).toEqual([]);
  });
});

describe('POST /api/agents/validate-token', () => {
  it('shape-only for missing and placeholder Telegram tokens', async () => {
    const h = setup();
    const missing = await (
      await post(h.app, '/api/agents/validate-token', { kind: 'telegram', token: '' })
    ).json();
    expect(missing).toMatchObject({ kind: 'telegram', state: 'missing', live: false });
    const ph = await (
      await post(h.app, '/api/agents/validate-token', { kind: 'telegram', token: 'nothing' })
    ).json();
    expect(ph).toMatchObject({ state: 'placeholder', live: false });
    expect(h.checkerCalls).toEqual([]);
  });
  it('live getMe only for a shaped Telegram token', async () => {
    const h = setup();
    const res = await post(h.app, '/api/agents/validate-token', {
      kind: 'telegram',
      token: SHAPED,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'ok', username: 'ada_bot', live: true });
    expect(h.checkerCalls).toEqual([SHAPED]);
  });
  it('reports revoked and unreachable distinctly', async () => {
    const revoked = setup({
      telegramCheck: async () => ({ ok: false, unauthorized: true, message: 'Unauthorized' }),
    });
    expect(
      await (
        await post(revoked.app, '/api/agents/validate-token', { kind: 'telegram', token: SHAPED })
      ).json()
    ).toMatchObject({ state: 'revoked' });
    const down = setup({
      telegramCheck: async () => ({ ok: false, unauthorized: false, message: 'timeout' }),
    });
    expect(
      await (
        await post(down.app, '/api/agents/validate-token', { kind: 'telegram', token: SHAPED })
      ).json()
    ).toMatchObject({ state: 'error' });
  });
  it('Discord and WhatsApp are shape-only; unknown kinds are 400', async () => {
    const h = setup();
    const d = `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`;
    expect(
      await (await post(h.app, '/api/agents/validate-token', { kind: 'discord', token: d })).json()
    ).toMatchObject({ state: 'shaped', live: false });
    expect(
      await (
        await post(h.app, '/api/agents/validate-token', { kind: 'whatsapp', token: 'EAAB' })
      ).json()
    ).toMatchObject({ state: 'shaped' });
    expect(
      (await post(h.app, '/api/agents/validate-token', { kind: 'slack', token: 'x' })).status
    ).toBe(400);
    expect((await post(h.app, '/api/agents/validate-token', { token: 'x' })).status).toBe(400);
    expect(h.checkerCalls).toEqual([]);
  });
});
