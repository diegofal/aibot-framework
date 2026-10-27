/**
 * The self-improvement loop wired into the `Watcher` (hourly check, run when
 * enabled and due, status, dismiss; tenant bots left out) and the admin
 * routes `GET|POST /api/watcher/self-improve` and the dismiss.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { LessonStore } from '../../src/bot/self-improve/store';
import type { ToolAuditEntry } from '../../src/bot/tool-audit-log';
import type { Config } from '../../src/config';
import type { KillState } from '../../src/watcher/kill';
import { watcherDir } from '../../src/watcher/paths';
import {
  type SelfImproveRunResult,
  type SelfImproveStatus,
  readSelfImproveState,
  writeSelfImproveState,
} from '../../src/watcher/self-improve';
import { WATCHER_DEFAULTS } from '../../src/watcher/types';
import { Watcher, type WatcherDeps } from '../../src/watcher/watcher';
import { watcherRoutes } from '../../src/web/routes/watcher';

const H = 3_600_000;
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
  root = mkdtempSync(join(tmpdir(), 'self-improve-w-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  t = Date.parse('2026-10-27T10:00:00Z');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function soul(id: string) {
  const dir = join(root, 'souls', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), `name: ${id}\n`);
  writeFileSync(join(dir, 'GOALS.md'), '# Goals\n\n## Active\n\n## Completed\n');
  return dir;
}

function notFound(n: number): ToolAuditEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(t - (i + 1) * H).toISOString(),
    botId: 'x',
    chatId: 0,
    toolName: 'file_read',
    args: {},
    success: false,
    result: 'File not found: a.md',
    durationMs: 1,
    retryAttempts: 0,
  }));
}

function make(
  opts: {
    enabled?: boolean;
    kill?: { current: KillState };
    tenantBot?: boolean;
    audit?: Record<string, ToolAuditEntry[]>;
  } = {}
) {
  const bot = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    soulDir: soul(id),
    enabled: true,
    agentLoop: { selfImprove: { enabled: true } },
    ...extra,
  });
  const config = {
    bots: [
      bot('b1'),
      bot('b2'),
      ...(opts.tenantBot ? [bot('t1bot', { tenantId: 't1' })] : [bot('b3')]),
      bot('off', { enabled: false }),
    ],
    multiTenant: { enabled: !!opts.tenantBot },
    paths: { data: join(root, 'data') },
    soul: {},
    operator: {},
    watcher: {
      ...WATCHER_DEFAULTS,
      enabled: true,
      selfImprove: { enabled: opts.enabled ?? true, toolProblemBots: 3, everyHours: 24 },
    },
  } as unknown as Config;
  const audit = opts.audit ?? {
    b1: notFound(3),
    b2: notFound(3),
    b3: notFound(3),
    t1bot: notFound(3),
    off: notFound(3),
  };
  const read: string[] = [];
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
    killSwitch: () => opts.kill?.current ?? { killed: false },
    selfImproveAudit: (botId) => {
      read.push(botId);
      return audit[botId] ?? [];
    },
  };
  return { watcher: new Watcher(deps), config, read };
}

describe('the Watcher runs the fleet self-improvement', () => {
  test('run now: a tool problem, the state file, a log row; disabled and tenant bots left out', async () => {
    const { watcher, config, read } = make();
    await watcher.start();
    const out = await watcher.selfImproveNow();
    expect(out.status).toBe('ran');
    if (out.status !== 'ran') throw new Error('unreachable');
    expect(out.result.toolProblems.map((p) => p.classKey)).toEqual(['file_read:file-not-found']);
    expect(read.sort()).toEqual(['b1', 'b2', 'b3']);
    expect(watcher.log.recent(50).some((r) => r.op === 'self-improve:tool-problem')).toBe(true);
    const state = readSelfImproveState(watcherDir(config));
    expect(state.last?.ranAt).toBe(new Date(t).toISOString());
    const status = watcher.selfImproveStatus();
    expect(status.enabled).toBe(true);
    expect(status.ranAt).toBe(new Date(t).toISOString());
    expect(status.nextRunAt).toBe(new Date(t + 24 * H).toISOString());
    await watcher.stop();
  });

  test('a tenant bot is never read, counted or written', async () => {
    const { watcher, config, read } = make({ tenantBot: true });
    await watcher.start();
    const out = await watcher.selfImproveNow();
    if (out.status !== 'ran') throw new Error('expected a run');
    expect(read.sort()).toEqual(['b1', 'b2']);
    expect(out.result.toolProblems).toEqual([]);
    expect(Object.keys(out.result.perBot).sort()).toEqual(['b1', 'b2']);
    const tenantSoul = (config.bots as Array<{ id: string; soulDir: string }>).find(
      (b) => b.id === 't1bot'
    )?.soulDir as string;
    expect(new LessonStore(tenantSoul).read().suppressed).toEqual([]);
    await watcher.stop();
  });

  test('the tick runs only when enabled, awake, not killed and due', async () => {
    const kill = { current: { killed: false } as KillState };
    const { watcher, config } = make({ kill });
    expect(watcher.selfImproveTick()).toBe(false); // asleep
    await watcher.start();
    kill.current = { killed: true, source: 'env' };
    expect(watcher.selfImproveTick()).toBe(false);
    kill.current = { killed: false };
    // Ran 23 h ago: not due.
    writeSelfImproveState(watcherDir(config), {
      dismissed: [],
      last: {
        ranAt: new Date(t - 23 * H).toISOString(),
        toolProblems: [],
        borrowed: [],
        perBot: {},
      },
    });
    expect(watcher.selfImproveTick()).toBe(false);
    t += 2 * H;
    expect(watcher.selfImproveTick()).toBe(true);
    await watcher.selfImproveIdle();
    expect(readSelfImproveState(watcherDir(config)).last?.ranAt).toBe(new Date(t).toISOString());
    await watcher.stop();
  });

  test('disabled: no tick, run now unavailable, status enabled false', async () => {
    const { watcher } = make({ enabled: false });
    await watcher.start();
    expect(watcher.selfImproveTick()).toBe(false);
    expect(await watcher.selfImproveNow()).toEqual({
      status: 'unavailable',
      reason: 'Self-improvement is off (watcher.selfImprove.enabled)',
    });
    expect(watcher.selfImproveStatus().enabled).toBe(false);
    expect(watcher.selfImproveStatus().nextRunAt).toBeNull();
    await watcher.stop();
  });

  test('never ran: the first tick runs', async () => {
    const { watcher } = make();
    await watcher.start();
    expect(watcher.selfImproveTick()).toBe(true);
    expect(watcher.selfImproveTick()).toBe(false); // one in flight
    await watcher.selfImproveIdle();
    await watcher.stop();
  });

  test('dismiss: kept in the state, suppressions lifted, a row; the next run skips it', async () => {
    const { watcher, config } = make();
    await watcher.start();
    await watcher.selfImproveNow();
    const b1 = (config.bots as Array<{ id: string; soulDir: string }>)[0].soulDir;
    expect(new LessonStore(b1).read().suppressed).toHaveLength(1);
    expect(watcher.dismissToolProblem('file_read:file-not-found')).toEqual({
      ok: true,
      dismissed: ['file_read:file-not-found'],
    });
    expect(new LessonStore(b1).read().suppressed).toEqual([]);
    expect(watcher.selfImproveStatus().last?.toolProblems).toEqual([]);
    expect(watcher.log.recent(50).some((r) => r.op === 'self-improve:dismissed')).toBe(true);
    t += 25 * H;
    const again = await watcher.selfImproveNow();
    if (again.status !== 'ran') throw new Error('expected a run');
    expect(again.result.toolProblems).toEqual([]);
    expect(new LessonStore(b1).read().suppressed).toEqual([]);
    expect(watcher.dismissToolProblem('not a key')).toEqual({
      ok: false,
      error: 'Not a failure class key',
    });
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

const status: SelfImproveStatus = {
  enabled: true,
  running: false,
  ranAt: null,
  nextRunAt: null,
  last: null,
  dismissed: [],
};

function stub(result: SelfImproveRunResult, dismissed: string[] = []): Partial<Watcher> {
  return {
    selfImproveStatus: () => status,
    selfImproveNow: async () => result,
    dismissToolProblem: (k: string) =>
      k.includes(':') ? { ok: true, dismissed: [...dismissed, k] } : { ok: false, error: 'bad' },
  };
}

describe('the /api/watcher/self-improve routes', () => {
  const config = () =>
    ({
      bots: [],
      multiTenant: { enabled: true },
      watcher: { ...WATCHER_DEFAULTS, enabled: true },
    }) as unknown as Config;
  const result = { ranAt: 'x', toolProblems: [], borrowed: [], perBot: {} };

  test('GET returns the status', async () => {
    const res = await routeApp(config(), stub({ status: 'ran', result })).request(
      '/api/watcher/self-improve'
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });

  test('POST runs one: 200 with the result and the status', async () => {
    const res = await routeApp(config(), stub({ status: 'ran', result })).request(
      '/api/watcher/self-improve',
      { method: 'POST' }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result, status });
  });

  test('POST is 409 asleep, killed, disabled or already running', async () => {
    for (const reason of [
      'The watcher is asleep',
      'The hard kill is on',
      'Self-improvement is off (watcher.selfImprove.enabled)',
      'A self-improvement run is already running',
    ]) {
      const res = await routeApp(config(), stub({ status: 'unavailable', reason })).request(
        '/api/watcher/self-improve',
        { method: 'POST' }
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: reason });
    }
  });

  test('dismiss: 200 with the dismissed list and status, 400 for a bad key', async () => {
    const app = routeApp(config(), stub({ status: 'ran', result }));
    const res = await app.request(
      `/api/watcher/self-improve/tool-problems/${encodeURIComponent('file_read:file-not-found')}/dismiss`,
      { method: 'POST' }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dismissed: ['file_read:file-not-found'], status });
    const bad = await app.request('/api/watcher/self-improve/tool-problems/nope/dismiss', {
      method: 'POST',
    });
    expect(bad.status).toBe(400);
  });

  test('a tenant gets 404 on all three and the watcher is never asked', async () => {
    let asked = false;
    const w = {
      selfImproveStatus: () => {
        asked = true;
        return status;
      },
      selfImproveNow: async () => {
        asked = true;
        return { status: 'ran', result } as const;
      },
      dismissToolProblem: () => {
        asked = true;
        return { ok: true as const, dismissed: [] };
      },
    };
    const app = routeApp(config(), w, 't1');
    expect((await app.request('/api/watcher/self-improve')).status).toBe(404);
    expect((await app.request('/api/watcher/self-improve', { method: 'POST' })).status).toBe(404);
    expect(
      (await app.request('/api/watcher/self-improve/tool-problems/a:b/dismiss', { method: 'POST' }))
        .status
    ).toBe(404);
    expect(asked).toBe(false);
  });

  test('with the watcher off all three are 404 { enabled: false }', async () => {
    const off = { ...config(), watcher: { ...WATCHER_DEFAULTS } } as unknown as Config;
    const app = routeApp(off, stub({ status: 'ran', result }));
    for (const [path, method] of [
      ['/api/watcher/self-improve', 'GET'],
      ['/api/watcher/self-improve', 'POST'],
      ['/api/watcher/self-improve/tool-problems/a:b/dismiss', 'POST'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
    }
  });
});
