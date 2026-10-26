/**
 * Autonomy rung 2 wired: the `Watcher` runs the self-study on its notice tier
 * (caller `watcher:self-study`, one query-log entry), only with the autonomy
 * API attached and the watcher awake and not killed; and the admin routes
 * `GET|POST /api/watcher/self-study` (409 cases, tenant 404).
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
import type {
  SelfStudyAutonomy,
  SelfStudyRunResult,
  SelfStudyStatus,
} from '../../../src/watcher/autonomy/self-study';
import type { KillState } from '../../../src/watcher/kill';
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
  root = mkdtempSync(join(tmpdir(), 'self-study-w-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  t = Date.parse('2026-10-25T10:00:00Z');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function soul(id: string) {
  const dir = join(root, 'souls', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), 'name: Jarvis\n');
  writeFileSync(join(dir, 'GOALS.md'), '# Goals\n\n## Active\n\n## Completed\n');
  return dir;
}

function make(opts: { kill?: { current: KillState }; proposals?: boolean } = {}) {
  const config = {
    bots: [
      { id: 'b1', name: 'b1', soulDir: soul('b1'), enabled: true, agentLoop: { every: '2h' } },
    ],
    paths: { data: join(root, 'data') },
    soul: {},
    operator: {},
    watcher: {
      ...WATCHER_DEFAULTS,
      enabled: true,
      autonomy: {
        monthlyCeilingUsd: 90,
        proposals: { enabled: opts.proposals ?? true, maxPending: 3, approvalTtlHours: 72 },
        selfStudy: { enabled: true, everyHours: 168, firstRunDelayMinutes: 30 },
      },
    },
  } as unknown as Config;
  let calls = 0;
  const client = {
    backend: 'claude-cli',
    generate: async () => ({ text: '' }),
    chat: async () => {
      calls++;
      return { text: '{"findings":["quiet"],"proposals":[]}', usage: { costUsd: 0.01 } };
    },
  } as unknown as LLMClient;
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
    llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } },
    queryLog: { append: (e) => entries.push(e) },
    killSwitch: () => opts.kill?.current ?? { killed: false },
    selfStudyReaders: {
      llm: () => [],
      cycles: () => [],
      tools: () => [],
      watcherDays: () => [],
    },
  };
  const watcher = new Watcher(deps);
  const autonomy: SelfStudyAutonomy = {
    enabled: () => opts.proposals ?? true,
    submit: async () => ({ ok: false, error: 'unused' }),
  };
  return { watcher, autonomy, calls: () => calls, entries, config };
}

describe('the Watcher runs the self-study', () => {
  test('on its notice tier, caller watcher:self-study, one call', async () => {
    const { watcher, autonomy, calls, entries } = make();
    await watcher.start();
    watcher.attachAutonomy(autonomy);
    const out = await watcher.selfStudyNow();
    expect(out.status).toBe('ran');
    expect(calls()).toBe(1);
    expect(entries.map((e) => e.caller)).toEqual(['watcher:self-study']);
    expect(watcher.log.recent(50).some((r) => r.op === 'self-study:run')).toBe(true);
    expect(watcher.selfStudyStatus().notes).toContain('quiet');
    await watcher.stop();
  });

  test('without the autonomy API, asleep, or killed: no run', async () => {
    const kill = { current: { killed: false } as KillState };
    const { watcher, autonomy, calls } = make({ kill });
    expect((await watcher.selfStudyNow()).status).toBe('unavailable');
    await watcher.start();
    expect((await watcher.selfStudyNow()).status).toBe('unavailable');
    watcher.attachAutonomy(autonomy);
    kill.current = { killed: true, source: 'env' };
    expect(await watcher.selfStudyNow()).toEqual({
      status: 'unavailable',
      reason: 'The hard kill is on',
    });
    expect(calls()).toBe(0);
    kill.current = { killed: false };
    await watcher.stop();
    expect(watcher.selfStudyTick()).toBe(false);
    expect(watcher.selfStudyStatus().nextRunAt).toBeNull();
  });

  test('the next scheduled run is the first-run delay after start', async () => {
    const { watcher, autonomy } = make();
    await watcher.start();
    watcher.attachAutonomy(autonomy);
    expect(watcher.selfStudyStatus().nextRunAt).toBe(new Date(t + 30 * 60_000).toISOString());
    expect(watcher.selfStudyTick()).toBe(false);
    await watcher.stop();
  });
});

// ── routes ──────────────────────────────────────────────────────────────

function routeApp(config: Config, watcher: Partial<Watcher> | undefined, tenantId?: string): Hono {
  const a = new Hono();
  if (tenantId) {
    a.use('*', async (c, next) => {
      c.set('tenant', { tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  a.route(
    '/api/watcher',
    watcherRoutes({ config, logger: noopLogger, watcher: () => watcher as Watcher | undefined })
  );
  return a;
}

const status: SelfStudyStatus = {
  enabled: true,
  running: false,
  lastRunAt: null,
  lastOutcome: null,
  nextRunAt: '2026-10-25T10:30:00.000Z',
  notes: null,
};

function stub(result: SelfStudyRunResult): Partial<Watcher> {
  return {
    selfStudyStatus: () => status,
    selfStudyNow: async () => result,
  };
}

describe('GET|POST /api/watcher/self-study', () => {
  const config = () =>
    ({
      bots: [],
      multiTenant: { enabled: true },
      watcher: { ...WATCHER_DEFAULTS, enabled: true },
    }) as unknown as Config;

  test('GET returns the status', async () => {
    const res = await routeApp(config(), stub({ status: 'cancelled' })).request(
      '/api/watcher/self-study'
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });

  test('POST runs one: 200 with the outcome', async () => {
    const outcome = {
      at: 'x',
      trigger: 'manual' as const,
      status: 'done' as const,
      findings: [],
      proposed: [],
      dropped: [],
      rejected: [],
    };
    const res = await routeApp(config(), stub({ status: 'ran', outcome })).request(
      '/api/watcher/self-study',
      { method: 'POST' }
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: unknown }).outcome).toEqual(outcome);
  });

  test('POST is 409 when off, killed, asleep or already running, and on a stop', async () => {
    for (const reason of [
      'Self-study is off (watcher.autonomy.selfStudy.enabled)',
      'The hard kill is on',
      'A self-study is already running',
    ]) {
      const res = await routeApp(config(), stub({ status: 'unavailable', reason })).request(
        '/api/watcher/self-study',
        { method: 'POST' }
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: reason });
    }
    const cancelled = await routeApp(config(), stub({ status: 'cancelled' })).request(
      '/api/watcher/self-study',
      { method: 'POST' }
    );
    expect(cancelled.status).toBe(409);
  });

  test('a tenant gets 404 and the watcher is never asked', async () => {
    let asked = false;
    const w = {
      selfStudyStatus: () => {
        asked = true;
        return status;
      },
      selfStudyNow: async () => {
        asked = true;
        return { status: 'cancelled' } as const;
      },
    };
    const app = routeApp(config(), w, 't1');
    expect((await app.request('/api/watcher/self-study')).status).toBe(404);
    expect((await app.request('/api/watcher/self-study', { method: 'POST' })).status).toBe(404);
    expect(asked).toBe(false);
  });

  test('with the watcher off both are 404 { enabled: false }', async () => {
    const off = { ...config(), watcher: { ...WATCHER_DEFAULTS } } as unknown as Config;
    const res = await routeApp(off, stub({ status: 'cancelled' })).request(
      '/api/watcher/self-study',
      { method: 'POST' }
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
  });
});
