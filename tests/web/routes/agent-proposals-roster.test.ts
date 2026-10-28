/**
 * Approving a proposal the mind made (`src/watcher/roster/`): the bot is
 * created off as always, GOALS.md gets the proposal's goals as the
 * operator's, and a preset brings its disabled tools.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { getPreset } from '../../../src/bot/presets';
import type { BotConfig, Config } from '../../../src/config';
import type { Logger } from '../../../src/logger';
import { AgentProposalStore } from '../../../src/tools/agent-proposal-store';
import { parseGoals } from '../../../src/tools/goals';
import { WATCHER_PROPOSER } from '../../../src/watcher/roster/types';
import { agentProposalRoutes } from '../../../src/web/routes/agent-proposals';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ap-roster-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeApp() {
  const store = new AgentProposalStore(join(dir, 'proposals'));
  const config = {
    bots: [],
    soul: { dir: join(dir, 'soul') },
    ollama: { baseUrl: 'http://localhost:11434', models: { primary: 'llama3' } },
    conversation: { systemPrompt: 'x', temperature: 0.7, maxHistory: 20 },
    productions: { baseDir: join(dir, 'productions') },
  } as unknown as Config;
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, '{}');
  writeFileSync(join(dir, 'bots.json'), '[]');
  const app = new Hono();
  app.route(
    '/api/agent-proposals',
    agentProposalRoutes({
      store,
      config,
      configPath,
      logger: noopLogger,
      generateSoul: async () => {
        throw new Error('no CLI in tests');
      },
    })
  );
  return { app, store, config };
}

describe('approving a mind proposal', () => {
  test('writes the goals as the operator’s, applies the preset, keeps the bot off', async () => {
    const { app, store, config } = makeApp();
    const p = store.create({
      agentId: 'role-finder',
      agentName: 'Role Finder',
      role: 'Finds roles',
      personalityDescription: 'Terse',
      skills: [],
      justification: 'Serves: roles.',
      proposedBy: WATCHER_PROPOSER,
      agentLoop: { mode: 'periodic', every: '7d' },
      serves: [{ id: 'w-aaaaaa', what: 'Five AI roles a week' }],
      goals: ['Every Monday, send five live AI roles', 'Learn which roles I open'],
      deliverable: 'Five roles with links',
      killCriterion: 'Two lists in a row with no role opened',
      preset: 'job-seeker',
    });
    const res = await app.request(`http://localhost/api/agent-proposals/${p.id}/approve`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { soulDir: string };
    const bot = config.bots.find((b: BotConfig) => b.id === 'role-finder') as BotConfig & {
      preset?: string;
      description?: string;
      disabledTools?: string[];
    };
    expect(bot.enabled).toBe(false);
    expect(bot.agentLoop?.every).toBe('7d');
    expect(bot.preset).toBe('job-seeker');
    expect(bot.description).toBe('Five roles with links');
    expect(bot.disabledTools).toEqual(getPreset('job-seeker')?.disabledTools ?? []);
    const { active } = parseGoals(readFileSync(join(data.soulDir, 'GOALS.md'), 'utf-8'));
    expect(active.map((g) => [g.text, g.priority, g.source])).toEqual([
      ['Every Monday, send five live AI roles', 'high', 'operator'],
      ['Learn which roles I open', 'medium', 'operator'],
    ]);
    expect(active[0].notes).toContain('Serves: Five AI roles a week');
    expect(active[0].notes).toContain('Kill if: Two lists in a row');
  });

  test('a proposal without goals writes no GOALS.md (bot proposals as before)', async () => {
    const { app, store } = makeApp();
    const p = store.create({
      agentId: 'plain-one',
      agentName: 'Plain',
      role: 'r',
      personalityDescription: '',
      skills: [],
      justification: '',
      proposedBy: 'bot-1',
    });
    const res = await app.request(`http://localhost/api/agent-proposals/${p.id}/approve`, {
      method: 'POST',
    });
    const data = (await res.json()) as { soulDir: string };
    expect(() => readFileSync(join(data.soulDir, 'GOALS.md'))).toThrow();
  });
});
