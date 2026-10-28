/**
 * The roster wired into the `Watcher` (brief, run now, status with bot
 * outcomes, the tick) and the admin routes `GET|PUT /api/watcher/brief`,
 * `GET|POST /api/watcher/roster`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { LlmQueryEntry } from '../../../src/bot/llm-query-log';
import type { Config } from '../../../src/config';
import type { LLMClient } from '../../../src/core/llm-client';
import { AgentProposalStore } from '../../../src/tools/agent-proposal-store';
import { WATCHER_PROPOSER } from '../../../src/watcher/roster/types';
import { WATCHER_DEFAULTS } from '../../../src/watcher/types';
import { Watcher, type WatcherDeps } from '../../../src/watcher/watcher';
import { watcherRoutes } from '../../../src/web/routes/watcher';

let root: string;
let t: number;
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roster-w-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  t = Date.parse('2026-10-28T03:00:00Z');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ANSWER = {
  proposals: [
    {
      agentId: 'role-finder',
      name: 'Role Finder',
      role: 'Finds roles',
      personality: 'Terse',
      serves: ['__WANT__'],
      deliverable: 'Five roles',
      cadence: '7d',
      delivery: 'Telegram',
      killCriterion: 'No role opened in two weeks',
      goals: ['Send five roles'],
    },
  ],
};

function make(opts: { proposals?: boolean; integrate?: boolean } = {}) {
  const workDir = join(root, 'productions', 'scout');
  mkdirSync(workDir, { recursive: true });
  const config = {
    bots: [{ id: 'scout', name: 'Scout', enabled: true, workDir, soulDir: join(root, 'soul') }],
    paths: { data: join(root, 'data') },
    soul: {},
    operator: {},
    watcher: { ...WATCHER_DEFAULTS, enabled: true },
  } as unknown as Config;
  const store =
    opts.proposals === false ? undefined : new AgentProposalStore(join(root, 'agent-proposals'));
  let reply = '';
  const client = {
    backend: 'claude-cli',
    generate: async () => ({ text: '' }),
    chat: async () => ({ text: reply, usage: { costUsd: 0.02 } }),
  } as unknown as LLMClient;
  const notice = { client, model: 'claude-haiku-5-5', backend: 'claude-cli' as const };
  const integrate = { client, model: 'claude-opus-5-5', backend: 'claude-cli' as const };
  const entries: LlmQueryEntry[] = [];
  const deps: WatcherDeps = {
    config: () => config,
    logger: noopLogger,
    activityStream: new EventEmitter(),
    hooks: new EventEmitter(),
    botManager: {
      getChannelState: () => ({ kind: 'telegram', state: 'ok', lastError: null, checkedAt: null }),
      getUserDirectory: () => ({ list: () => [], findByChannel: () => undefined }) as never,
    },
    now: () => t,
    stopTimeoutMs: 500,
    llm: opts.integrate === false ? { notice } : { notice, integrate },
    queryLog: { append: (e) => entries.push(e) },
    killSwitch: () => ({ killed: false }),
    agentProposals: () => store,
    readCycles: (botId) =>
      botId === 'scout'
        ? [
            {
              cycleId: 'c1',
              startedAt: '2026-10-29T00:00:00Z',
              endedAt: '2026-10-29T00:05:00Z',
              status: 'completed',
            },
            { cycleId: 'c2', startedAt: '2026-10-29T01:00:00Z', status: 'idle' },
          ]
        : [],
  };
  const watcher = new Watcher(deps);
  return {
    watcher,
    config,
    store,
    entries,
    workDir,
    setReply: (wantId: string) => {
      reply = JSON.stringify(ANSWER).replace('__WANT__', wantId);
    },
  };
}

const briefBody = {
  wants: [{ what: 'Five AI roles a week', cadence: 'weekly', delivery: 'Telegram', success: '' }],
  notes: '',
};

describe('the Watcher designs a roster', () => {
  test('save the brief, run now: a proposal by the watcher, a query log entry under watcher:roster', async () => {
    const { watcher, store, entries, setReply } = make();
    await watcher.start();
    const saved = watcher.saveBrief(briefBody);
    if (!saved.ok) throw new Error(saved.error);
    expect(watcher.brief().wants[0].what).toBe('Five AI roles a week');
    setReply(saved.brief.wants[0].id);
    const r = await watcher.rosterNow();
    expect(r.status === 'ran' && r.outcome.status).toBe('proposed');
    expect(store?.list().map((p) => [p.agentId, p.proposedBy])).toEqual([
      ['role-finder', WATCHER_PROPOSER],
    ]);
    expect(entries.find((e) => e.caller === 'watcher:roster')?.model).toBe('claude-opus-5-5');
    expect(watcher.log.recent(20).some((row) => row.op === 'roster:run')).toBe(true);
    await watcher.stop();
  });

  test('without the integrate tier the notice tier designs', async () => {
    const { watcher, entries, setReply } = make({ integrate: false });
    await watcher.start();
    const saved = watcher.saveBrief(briefBody);
    if (!saved.ok) throw new Error(saved.error);
    setReply(saved.brief.wants[0].id);
    const r = await watcher.rosterNow();
    expect(r.status === 'ran' && r.outcome.status).toBe('proposed');
    expect(entries.find((e) => e.caller === 'watcher:roster')?.model).toBe('claude-haiku-5-5');
    await watcher.stop();
  });

  test('status: an approved mind bot shows its completed cycles and reviewed productions', async () => {
    const { watcher, store, workDir } = make();
    const p = store?.create({
      agentId: 'scout',
      agentName: 'Scout',
      role: 'r',
      personalityDescription: '',
      skills: [],
      justification: '',
      proposedBy: WATCHER_PROPOSER,
      killCriterion: 'nothing approved in two weeks',
    });
    store?.updateStatus(p?.id as string, 'approved');
    const entry = (id: string, ts: string, status?: string) =>
      JSON.stringify({
        id,
        timestamp: ts,
        botId: 'scout',
        tool: 'file_write',
        path: `${id}.md`,
        action: 'create',
        description: '',
        size: 1,
        trackOnly: false,
        ...(status ? { evaluation: { status, evaluatedAt: ts } } : {}),
      });
    writeFileSync(
      join(workDir, 'changelog.jsonl'),
      [
        entry('old', '2020-01-01T00:00:00Z', 'approved'),
        entry('a', '2026-10-29T00:00:00Z', 'approved'),
        entry('b', '2026-10-29T01:00:00Z', 'rejected'),
        entry('c', '2026-10-29T02:00:00Z'),
      ].join('\n')
    );
    await watcher.start();
    const s = watcher.rosterStatus();
    expect(s.bots).toEqual([
      expect.objectContaining({
        botId: 'scout',
        cyclesCompleted: 1,
        lastCycleAt: '2026-10-29T00:05:00Z',
        productions: 3,
        approved: 1,
        rejected: 1,
      }),
    ]);
    await watcher.stop();
  });

  test('asleep: run now is unavailable and the tick does nothing', async () => {
    const { watcher } = make();
    const r = await watcher.rosterNow();
    expect(r).toEqual({ status: 'unavailable', reason: 'The watcher is asleep' });
    expect(watcher.rosterTick()).toBe(false);
  });
});

function app(watcher: Watcher, config: Config) {
  const a = new Hono();
  a.route('/api/watcher', watcherRoutes({ config, logger: noopLogger, watcher: () => watcher }));
  return a;
}

describe('roster routes', () => {
  test('GET/PUT /brief: saves, assigns ids, rejects a bad body with 400', async () => {
    const { watcher, config } = make();
    const a = app(watcher, config);
    expect(await (await a.request('/api/watcher/brief')).json()).toEqual({ wants: [], notes: '' });
    const put = await a.request('/api/watcher/brief', {
      method: 'PUT',
      body: JSON.stringify(briefBody),
      headers: { 'content-type': 'application/json' },
    });
    expect(put.status).toBe(200);
    const { brief } = (await put.json()) as { brief: { wants: Array<{ id: string }> } };
    expect(brief.wants[0].id).toMatch(/^w-[0-9a-f]{6}$/);
    const bad = await a.request('/api/watcher/brief', {
      method: 'PUT',
      body: JSON.stringify({ wants: 'x' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
  });

  test('GET /roster returns the status; POST /roster is 409 asleep and 200 awake', async () => {
    const { watcher, config, setReply } = make();
    const a = app(watcher, config);
    const status = (await (await a.request('/api/watcher/roster')).json()) as {
      enabled: boolean;
      proposalsOn: boolean;
    };
    expect(status).toMatchObject({ enabled: true, proposalsOn: true });
    expect((await a.request('/api/watcher/roster', { method: 'POST' })).status).toBe(409);
    await watcher.start();
    const saved = watcher.saveBrief(briefBody);
    if (!saved.ok) throw new Error(saved.error);
    setReply(saved.brief.wants[0].id);
    const res = await a.request('/api/watcher/roster', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: { status: string } };
    expect(body.outcome.status).toBe('proposed');
    await watcher.stop();
  });

  test('watcher off: 404', async () => {
    const { watcher, config } = make();
    (config.watcher as { enabled: boolean }).enabled = false;
    const a = app(watcher, config);
    expect((await a.request('/api/watcher/brief')).status).toBe(404);
    expect((await a.request('/api/watcher/roster')).status).toBe(404);
  });
});
