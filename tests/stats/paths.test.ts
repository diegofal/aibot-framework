import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { classifyToken, resolveBotPaths, resolveStatsDirs } from '../../src/stats/paths';
import { removeTempDir } from '../helpers/temp-dir';
import { type StatsFixture, VALID_TOKEN, createStatsFixture, makeBot } from './fixture';

let fx: StatsFixture;
beforeEach(() => {
  fx = createStatsFixture();
});
afterEach(() => removeTempDir(fx.dir));

describe('resolveStatsDirs', () => {
  it('derives every store directory from config', () => {
    const d = resolveStatsDirs(fx.config);
    expect(d.dataDir).toBe(fx.dir);
    expect(d.llmQueryLog).toBe(join(fx.dir, 'llm-query-log'));
    expect(d.toolAudit).toBe(join(fx.dir, 'tool-audit'));
    expect(d.outcomeLedger).toBe(join(fx.dir, 'outcome-ledger'));
    expect(d.scheduler).toBe(join(fx.dir, 'agent-scheduler'));
    expect(d.karma).toBe(join(fx.dir, 'karma'));
    expect(d.conversations).toBe(join(fx.dir, 'conversations'));
    expect(d.sessions).toBe(join(fx.dir, 'sessions'));
    expect(d.cron).toBe(join(fx.dir, 'cron'));
    expect(d.mesh).toBe(join(fx.dir, 'shared', 'knowledge-mesh.jsonl'));
    expect(d.logFile).toBe(join(fx.dir, 'logs', 'aibot.log'));
  });
  it('falls back to data-relative defaults when optional sections are absent', () => {
    const cfg = {
      ...fx.config,
      karma: undefined,
      conversations: undefined,
      session: undefined,
      cron: undefined,
      logging: undefined,
    } as never;
    const d = resolveStatsDirs(cfg);
    expect(d.karma).toBe(join(fx.dir, 'karma'));
    expect(d.conversations).toBe(join(fx.dir, 'conversations'));
    expect(d.sessions).toBe(join(fx.dir, 'sessions'));
    expect(d.cron).toBe(join(fx.dir, 'cron'));
    expect(d.logFile).toBe(join(fx.dir, 'logs', 'aibot.log'));
  });
});

describe('resolveBotPaths', () => {
  it('uses the same soul/work resolution as BotManager', () => {
    const p = resolveBotPaths(fx.config, fx.bots.b1);
    expect(p.soulDir).toBe(`${join(fx.dir, 'tenants')}/__admin__/bots/b1/soul`);
    expect(p.workDir).toBe(`${join(fx.dir, 'productions')}/b1`);
    expect(p.backend).toBe('ollama');
    expect(p.model).toBe('qwen');
  });
  it('honours explicit soulDir/workDir and claude-cli model default', () => {
    const bot = makeBot({ id: 'x', llmBackend: 'claude-cli', soulDir: '/s', workDir: '/w' });
    const p = resolveBotPaths(fx.config, bot);
    expect(p).toEqual({
      soulDir: '/s',
      workDir: '/w',
      backend: 'claude-cli',
      model: 'claude-sonnet',
    });
  });
  it('bot without llmBackend reports the ollama default backend', () => {
    expect(resolveBotPaths(fx.config, fx.bots.b3).backend).toBe('ollama');
  });
});

describe('classifyToken', () => {
  it('missing / placeholder / configured', () => {
    expect(classifyToken(undefined)).toBe('missing');
    expect(classifyToken('')).toBe('missing');
    expect(classifyToken('   ')).toBe('missing');
    expect(classifyToken('YOUR_TELEGRAM_TOKEN')).toBe('placeholder');
    expect(classifyToken('${TELEGRAM_TOKEN}')).toBe('placeholder');
    expect(classifyToken(VALID_TOKEN)).toBe('configured');
  });
});
