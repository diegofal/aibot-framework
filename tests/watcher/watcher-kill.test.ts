/**
 * Autonomy rung 0 in the `Watcher`: the hard kill (C1) at start and while
 * running, and the monthly ceiling (C6) in its state and log.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../src/config';
import type { LLMClient } from '../../src/core/llm-client';
import { budgetFile } from '../../src/watcher/budget';
import type { KillState } from '../../src/watcher/kill';
import { WATCHER_DEFAULTS, type WatcherEvent } from '../../src/watcher/types';
import { KILL_POLL_MS, Watcher, type WatcherDeps } from '../../src/watcher/watcher';

let root: string;
let t: number;
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function soul(id: string) {
  const dir = join(root, 'souls', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'IDENTITY.md'), 'name: Jarvis\n');
  writeFileSync(join(dir, 'GOALS.md'), '# Goals\n\n## Active\n\n## Completed\n');
  return dir;
}

function chatClient(chat: (opts?: { signal?: AbortSignal }) => Promise<unknown>) {
  const calls: Array<AbortSignal | undefined> = [];
  const client = {
    backend: 'claude-cli',
    generate: async () => ({ text: '' }),
    chat: (_m: unknown, opts?: { signal?: AbortSignal }) => {
      calls.push(opts?.signal);
      return chat(opts);
    },
  } as unknown as LLMClient;
  return { client, calls };
}

function make(overrides: Partial<WatcherDeps> = {}, watcherCfg: Record<string, unknown> = {}) {
  const config = {
    bots: [{ id: 'b1', name: 'b1', soulDir: soul('b1'), enabled: true }],
    paths: { data: join(root, 'data') },
    soul: {},
    operator: { telegramChatId: 42 },
    watcher: { ...WATCHER_DEFAULTS, enabled: true, ...watcherCfg },
  } as unknown as Config;
  const activityStream = new EventEmitter();
  const deps: WatcherDeps = {
    config: () => config,
    logger: noopLogger,
    activityStream,
    hooks: new EventEmitter(),
    botManager: {
      getChannelState: () => ({ kind: 'telegram', state: 'ok', lastError: null, checkedAt: null }),
      getUserDirectory: () => ({ list: () => [], findByChannel: () => undefined }) as never,
    },
    now: () => t,
    stopTimeoutMs: 500,
    ...overrides,
  };
  const watcher = new Watcher(deps);
  const events: WatcherEvent[] = [];
  watcher.on('event', (e: WatcherEvent) => events.push(e));
  return { watcher, events, config, activityStream };
}

const sentinel = () => join(root, 'data', 'watcher-kill');
const noticeOn = { notice: { ...WATCHER_DEFAULTS.notice, enabled: true } };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watcher-kill-w-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Watcher hard kill (C1)', () => {
  test('the poll runs every 5 s', () => {
    expect(KILL_POLL_MS).toBe(5_000);
  });

  test('start() refuses while the sentinel exists: one row, killed in the state, no birth', async () => {
    writeFileSync(sentinel(), '');
    const { watcher, events } = make();
    const state = await watcher.start();
    expect(state.running).toBe(false);
    expect(state.killed).toEqual({ source: 'file', since: '2026-10-23T10:00:00.000Z' });
    const rows = watcher.log.recent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('kill:refused');
    expect(rows[0].text).toContain('I did not start');
    expect(rows[0].text).toContain('watcher-kill');
    expect(rows[0].text).toContain('start me again');
    expect(watcher.readBirth()).toBeNull();
    const published = events.filter((e) => e.type === 'watcher:state');
    expect((published.at(-1)?.data as { killed?: unknown }).killed).toEqual(state.killed);
  });

  test('start() refuses while the environment kills, naming the variable', async () => {
    const { watcher } = make({ killSwitch: () => ({ killed: true, source: 'env' }) });
    const state = await watcher.start();
    expect(state.running).toBe(false);
    expect(state.killed?.source).toBe('env');
    expect(watcher.log.recent(1)[0].text).toContain('AIBOT_WATCHER_KILL');
  });

  test('a kill reader that throws never makes start throw', async () => {
    const { watcher } = make({
      killSwitch: () => {
        throw new Error('boom');
      },
    });
    const state = await watcher.start();
    expect(state.running).toBe(true);
    expect(state.killed).toBeUndefined();
    await watcher.stop();
  });

  test('state().killed follows the switch on every read, asleep included', () => {
    const { watcher } = make();
    expect(watcher.state().killed).toBeUndefined();
    writeFileSync(sentinel(), '');
    expect(watcher.state().killed).toEqual({ source: 'file', since: '2026-10-23T10:00:00.000Z' });
    t += 60_000;
    // `since` is when it was first seen on, not each read
    expect(watcher.state().killed?.since).toBe('2026-10-23T10:00:00.000Z');
    rmSync(sentinel());
    expect(watcher.state().killed).toBeUndefined();
  });

  test('turning on while running stops it through stop(), with one row saying why', async () => {
    let kill: KillState = { killed: false };
    const { watcher } = make({ killSwitch: () => kill });
    await watcher.start();
    await watcher.idle();
    expect(await watcher.checkKillSwitch()).toBe(false);
    expect(watcher.state().running).toBe(true);
    kill = { killed: true, source: 'env' };
    expect(await watcher.checkKillSwitch()).toBe(true);
    const state = watcher.state();
    expect(state.running).toBe(false);
    expect(state.phase).toBe('sleep');
    expect(state.killed?.source).toBe('env');
    const ops = watcher.log.recent(5).map((r) => r.op);
    expect(ops.slice(0, 2)).toEqual(['sleep', 'kill:stopped']);
    const row = watcher.log.recent(5).find((r) => r.op === 'kill:stopped');
    expect(row?.text).toContain('AIBOT_WATCHER_KILL');
    expect(row?.text).toContain('start me again');
    // a second check while killed and asleep writes nothing more
    expect(await watcher.checkKillSwitch()).toBe(true);
    expect(watcher.log.recent(10).filter((r) => r.op === 'kill:stopped')).toHaveLength(1);
  });

  test('clearing the switch never restarts it; the operator starts it', async () => {
    let kill: KillState = { killed: false };
    const { watcher } = make({ killSwitch: () => kill });
    await watcher.start();
    await watcher.idle();
    kill = { killed: true, source: 'file' };
    await watcher.checkKillSwitch();
    kill = { killed: false };
    expect(await watcher.checkKillSwitch()).toBe(false);
    expect(watcher.state().running).toBe(false);
    expect(watcher.state().killed).toBeUndefined();
    expect((await watcher.start()).running).toBe(true);
    await watcher.stop();
  });

  test('the poll timer finds the sentinel and stops the watcher by itself', async () => {
    const { watcher } = make({ killPollMs: 10 });
    await watcher.start();
    await watcher.idle();
    writeFileSync(sentinel(), '');
    for (let i = 0; i < 100 && watcher.state().running; i++) await settle(10);
    expect(watcher.state().running).toBe(false);
    expect(watcher.log.recent(5).some((r) => r.op === 'kill:stopped')).toBe(true);
  });

  test('the poll stops with the watcher (no row after an operator stop)', async () => {
    const { watcher } = make({ killPollMs: 10 });
    await watcher.start();
    await watcher.idle();
    await watcher.stop();
    writeFileSync(sentinel(), '');
    await settle(50);
    expect(watcher.log.recent(10).some((r) => r.op.startsWith('kill:'))).toBe(false);
  });

  test('a call in flight is aborted when the kill stops the watcher, and no call leaves after', async () => {
    let kill: KillState = { killed: false };
    const { client, calls } = chatClient(() => new Promise(() => {}));
    const { watcher, activityStream } = make(
      {
        killSwitch: () => kill,
        llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } },
      },
      noticeOn
    );
    await watcher.start();
    await watcher.idle();
    activityStream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    activityStream.emit('activity', { type: 'worker:waiting', botId: 'b1', timestamp: t });
    await settle();
    const pass = watcher.noticeNow();
    await settle();
    expect(calls).toHaveLength(1);
    kill = { killed: true, source: 'file' };
    const started = Date.now();
    await watcher.checkKillSwitch();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls[0]?.aborted).toBe(true);
    expect((await pass)?.status).not.toBe('noticed');
    const res = await watcher.tierClient('notice')?.chat([{ role: 'user', content: 'x' }]);
    expect(res).toEqual({ ok: false, reason: 'killed' });
    expect(calls).toHaveLength(1);
  });

  test('a call refused as killed stops a running watcher at once, without waiting for the poll', async () => {
    let kill: KillState = { killed: false };
    const { client, calls } = chatClient(async () => ({ text: '{"keep":[]}' }));
    const { watcher } = make(
      {
        killSwitch: () => kill,
        llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } },
      },
      noticeOn
    );
    await watcher.start();
    await watcher.idle();
    kill = { killed: true, source: 'env' };
    const res = await watcher.tierClient('notice')?.chat([{ role: 'user', content: 'x' }]);
    expect(res).toEqual({ ok: false, reason: 'killed' });
    expect(calls).toHaveLength(0);
    for (let i = 0; i < 100 && watcher.state().running; i++) await settle(10);
    expect(watcher.state().running).toBe(false);
    expect(watcher.log.recent(5).some((r) => r.op === 'kill:stopped')).toBe(true);
  });
});

describe('Watcher monthly ceiling (C6)', () => {
  function spent(date: string, costUsd: number) {
    const dir = join(root, 'data', 'watcher');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      budgetFile(dir, date),
      JSON.stringify({
        date,
        notice: { calls: 0, tokens: 0, costUsd: 0 },
        integrate: { calls: 1, tokens: 1, costUsd },
        capLogged: [],
      })
    );
  }

  test('state().month is this month to date and the configured ceiling (default 90)', () => {
    spent('2026-10-05', 12.5);
    spent('2026-09-30', 70);
    const { watcher } = make();
    expect(watcher.state().month).toEqual({ costUsd: 12.5, ceilingUsd: 90 });
  });

  test('the ceiling comes from watcher.autonomy and a live change applies', () => {
    spent('2026-10-05', 30);
    const { watcher, config } = make(
      {},
      { autonomy: { ...WATCHER_DEFAULTS.autonomy, monthlyCeilingUsd: 50 } }
    );
    expect(watcher.state().month?.ceilingUsd).toBe(50);
    expect(watcher.budget.reserve('notice')).toEqual({ ok: true });
    watcher.budget.record('notice', {});
    (config.watcher as { autonomy: { monthlyCeilingUsd: number } }).autonomy.monthlyCeilingUsd = 20;
    expect(watcher.budget.reserve('notice')).toEqual({ ok: false, reason: 'ceiling' });
    expect(watcher.state().month?.ceilingUsd).toBe(20);
  });

  test('a config without autonomy gets the default ceiling', () => {
    const cfg = { ...WATCHER_DEFAULTS, enabled: true } as Record<string, unknown>;
    cfg.autonomy = undefined;
    const { watcher } = make({}, cfg);
    expect(watcher.state().month?.ceilingUsd).toBe(90);
  });

  test('reaching the ceiling refuses every tier and logs one row a day', async () => {
    spent('2026-10-05', 95);
    const { client, calls } = chatClient(async () => ({ text: '{"keep":[]}' }));
    const { watcher } = make(
      { llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } } },
      noticeOn
    );
    const notice = watcher.tierClient('notice');
    expect(await notice?.chat([{ role: 'user', content: 'x' }])).toEqual({
      ok: false,
      reason: 'ceiling',
    });
    await notice?.chat([{ role: 'user', content: 'y' }]);
    expect(calls).toHaveLength(0);
    const rows = watcher.log.recent(10).filter((r) => r.op === 'budget:ceiling');
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain('$95.00');
    expect(rows[0].text).toContain('$90.00');
    t = Date.parse('2026-10-24T09:00:00Z');
    await notice?.chat([{ role: 'user', content: 'z' }]);
    expect(watcher.log.recent(10).filter((r) => r.op === 'budget:ceiling')).toHaveLength(2);
  });
});
