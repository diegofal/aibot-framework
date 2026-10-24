import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGoalEvents } from '../../src/bot/goal-events';
import { parseGoals } from '../../src/tools/goals';
import {
  BROADCAST_DAILY_CAP,
  BROADCAST_INFLIGHT_MAX_MS,
  BROADCAST_PENDING_MS,
  type BroadcastDelivery,
  Broadcaster,
  broadcastsFile,
  isStaleOpen,
  writeWatcherGoal,
} from '../../src/watcher/broadcast';
import { WatcherLog } from '../../src/watcher/log';
import type { WatcherLogRow } from '../../src/watcher/types';

let dir: string;
let t: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-broadcast-'));
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(delivery: BroadcastDelivery = {}, cap?: number) {
  const calls: string[] = [];
  const rows: WatcherLogRow[] = [];
  const log = new WatcherLog(join(dir, 'log'), { now: () => t, onRow: (r) => rows.push(r) });
  const d: BroadcastDelivery = {
    wake: (b) => {
      calls.push(`wake:${b}`);
    },
    directive: (b, text) => {
      calls.push(`directive:${b}:${text}`);
    },
    goal: (b, text, reason) => {
      calls.push(`goal:${b}:${text}:${reason}`);
    },
    question: async (b, text) => {
      calls.push(`question:${b}:${text}`);
      return { ok: true, detail: 'Message sent to the operator (chat 42)' };
    },
    ...delivery,
  };
  const make = () =>
    new Broadcaster({
      dir,
      now: () => t,
      delivery: d,
      log,
      botName: (id) => (id === 'b1' ? 'Jarvis' : id),
      ...(cap !== undefined ? { maxPerBotPerDay: cap } : {}),
    });
  return { b: make(), make, calls, rows };
}

const send = (b: Broadcaster, over: Record<string, unknown> = {}) =>
  b.send({
    botId: 'b1',
    kind: 'wake',
    text: 'Scout found the same lead',
    insightId: 'n-ins00001',
    reason: 'Two bots chase the same lead',
    ...over,
  } as never);

describe('Broadcaster.send', () => {
  test('wake calls the wake dep and records the broadcast', async () => {
    const { b, calls, rows } = setup();
    const r = await send(b);
    expect(r.status).toBe('delivered');
    expect(calls).toEqual(['wake:b1']);
    expect(r.broadcast).toMatchObject({
      botId: 'b1',
      kind: 'wake',
      insightId: 'n-ins00001',
      createdAt: new Date(t).toISOString(),
      deliveredAt: new Date(t).toISOString(),
    });
    expect(r.broadcast?.id).toMatch(/^b-[0-9a-f]{8}$/);
    expect(rows.some((row) => row.phase === 'broadcast' && row.op === 'broadcast:sent')).toBe(true);
  });

  // Defence in depth: whatever proposes it, a tenant bot is never a target.
  test('a tenant bot is rejected before anything is recorded or delivered', async () => {
    const calls: string[] = [];
    const b = new Broadcaster({
      dir,
      now: () => t,
      delivery: {
        wake: (id) => {
          calls.push(`wake:${id}`);
        },
      },
      isTenantBot: (id) => id === 't1',
    });
    for (const kind of ['wake', 'directive', 'goal', 'question']) {
      const r = await send(b, { botId: 't1', kind, insightId: `n-${kind}` });
      expect(r.status).toBe('invalid');
    }
    expect(calls).toEqual([]);
    expect(b.list()).toEqual([]);
    expect((await send(b)).status).toBe('delivered');
  });

  test('directive, goal and question call their deps', async () => {
    const { b, calls } = setup();
    await send(b, { kind: 'directive', text: 'Check the shared lead first' });
    await send(b, { kind: 'goal', text: 'Merge the lead lists' });
    await send(b, { kind: 'question', text: 'Should Jarvis or Scout own the lead?' });
    expect(calls).toEqual([
      'directive:b1:Check the shared lead first',
      'goal:b1:Merge the lead lists:Two bots chase the same lead',
      'question:b1:Should Jarvis or Scout own the lead?',
    ]);
  });

  test('a failing delivery is recorded as failed and still counts toward the cap', async () => {
    const { b } = setup(
      {
        question: async () => ({ ok: false, detail: 'Proactive send throttled' }),
      },
      1
    );
    const r = await send(b, { kind: 'question' });
    expect(r.status).toBe('failed');
    expect(r.broadcast?.deliveryError).toBe('Proactive send throttled');
    expect((await send(b, { kind: 'wake', insightId: 'n-other' })).status).toBe('capped');
  });

  test('a throwing delivery dep is a failed broadcast, never a throw', async () => {
    const { b } = setup({
      wake: () => {
        throw new Error('boom');
      },
    });
    const r = await send(b);
    expect(r.status).toBe('failed');
    expect(r.broadcast?.deliveryError).toBe('boom');
  });

  test(`caps at ${BROADCAST_DAILY_CAP} per bot per day, and resets the next day`, async () => {
    const { b, calls } = setup();
    for (let i = 0; i < BROADCAST_DAILY_CAP; i++) {
      expect((await send(b, { insightId: `n-${i}` })).status).toBe('delivered');
    }
    expect((await send(b, { insightId: 'n-9' })).status).toBe('capped');
    expect((await send(b, { botId: 'b2', insightId: 'n-9' })).status).toBe('delivered');
    expect(calls.filter((c) => c === 'wake:b1')).toHaveLength(BROADCAST_DAILY_CAP);
    t += 86_400_000;
    expect((await send(b, { insightId: 'n-10' })).status).toBe('delivered');
  });

  test('the cap holds across a restart (persisted)', async () => {
    const { b, make } = setup(undefined, 2);
    await send(b, { insightId: 'n-1' });
    await send(b, { insightId: 'n-2' });
    expect((await send(make(), { insightId: 'n-3' })).status).toBe('capped');
  });

  test('the cap holds for concurrent sends', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { b } = setup(
      {
        question: async () => {
          await gate;
          return { ok: true, detail: 'ok' };
        },
      },
      1
    );
    const first = send(b, { kind: 'question' });
    const second = send(b, { kind: 'wake', insightId: 'n-2' });
    release();
    expect((await first).status).toBe('delivered');
    expect((await second).status).toBe('capped');
  });

  test('never two of the same kind for the same insight', async () => {
    const { b } = setup();
    expect((await send(b)).status).toBe('delivered');
    expect((await send(b)).status).toBe('duplicate');
    expect((await send(b, { botId: 'b2' })).status).toBe('duplicate');
    expect((await send(b, { kind: 'directive' })).status).toBe('delivered');
  });

  test('a failed delivery is not a duplicate: the same insight and kind may be retried', async () => {
    let ok = false;
    const { b, make } = setup({
      question: async () => ({ ok, detail: ok ? 'sent' : 'Proactive send throttled' }),
    });
    expect((await send(b, { kind: 'question' })).status).toBe('failed');
    ok = true;
    expect((await send(b, { kind: 'question' })).status).toBe('delivered');
    // Delivered now: a third is a duplicate, also after a restart.
    expect((await send(b, { kind: 'question' })).status).toBe('duplicate');
    expect((await send(make(), { kind: 'question' })).status).toBe('duplicate');
  });

  test('a retry of a failed one still counts the failure toward the daily cap', async () => {
    let ok = false;
    const { b } = setup({ question: async () => ({ ok, detail: ok ? 'sent' : 'no' }) }, 2);
    expect((await send(b, { kind: 'question' })).status).toBe('failed');
    ok = true;
    expect((await send(b, { kind: 'question' })).status).toBe('delivered');
    expect((await send(b, { kind: 'wake', insightId: 'n-3' })).status).toBe('capped');
  });

  test('one still in flight is a duplicate (concurrent sends never both go out)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { b, calls } = setup({
      question: async (bot, text) => {
        calls.push(`question:${bot}:${text}`);
        await gate;
        return { ok: true, detail: 'ok' };
      },
    });
    const first = send(b, { kind: 'question' });
    const second = await send(b, { kind: 'question' });
    release();
    expect(second.status).toBe('duplicate');
    expect((await first).status).toBe('delivered');
    expect(calls.filter((c) => c.startsWith('question:'))).toHaveLength(1);
  });

  test('invalid input is refused without calling anything', async () => {
    const { b, calls } = setup();
    expect((await send(b, { kind: 'shout' })).status).toBe('invalid');
    expect((await send(b, { botId: '' })).status).toBe('invalid');
    expect((await send(b, { kind: 'directive', text: '  ' })).status).toBe('invalid');
    expect(calls).toEqual([]);
  });

  test('a kind without a delivery dep fails', async () => {
    const b = new Broadcaster({ dir, now: () => t, delivery: {} });
    expect((await send(b)).status).toBe('failed');
  });
});

describe('Broadcaster: records left open by a process exit', () => {
  const writeOpen = (ageMs: number, id = 'b-0000open') => {
    mkdirSync(dir, { recursive: true });
    const rec = {
      id,
      botId: 'b1',
      kind: 'wake',
      text: 'x',
      insightId: 'n-ins00001',
      createdAt: new Date(t - ageMs).toISOString(),
    };
    writeFileSync(broadcastsFile(dir), `${JSON.stringify(rec)}\n`, 'utf-8');
  };

  test('isStaleOpen: open and older than BROADCAST_INFLIGHT_MAX_MS', () => {
    const at = (ageMs: number) => ({ createdAt: new Date(t - ageMs).toISOString() });
    expect(isStaleOpen(at(BROADCAST_INFLIGHT_MAX_MS + 1), t)).toBe(true);
    expect(isStaleOpen(at(BROADCAST_INFLIGHT_MAX_MS - 1), t)).toBe(false);
    expect(isStaleOpen({ ...at(BROADCAST_INFLIGHT_MAX_MS * 2), deliveredAt: 'x' }, t)).toBe(false);
    expect(isStaleOpen({ ...at(BROADCAST_INFLIGHT_MAX_MS * 2), deliveryError: 'x' }, t)).toBe(
      false
    );
  });

  test('on load, an open record older than the limit is closed as failed and persisted', () => {
    writeOpen(BROADCAST_INFLIGHT_MAX_MS + 60_000);
    const { b, make } = setup();
    expect(b.get('b-0000open')?.deliveryError).toContain('interrupted');
    expect(b.get('b-0000open')?.deliveredAt).toBeUndefined();
    expect(make().get('b-0000open')?.deliveryError).toContain('interrupted');
    expect(readFileSync(broadcastsFile(dir), 'utf-8').trim().split('\n')).toHaveLength(2);
  });

  test('a younger open record stays open on load and still blocks a duplicate', async () => {
    writeOpen(60_000);
    const { b } = setup();
    expect(b.get('b-0000open')?.deliveryError).toBeUndefined();
    expect((await send(b)).status).toBe('duplicate');
  });

  test('a delivery of this process hanging past the limit is still in flight: a re-proposal is a duplicate', async () => {
    let release: () => void = () => {};
    const hanging = new Promise<void>((r) => {
      release = r;
    });
    const asked: string[] = [];
    const { b } = setup({
      question: async (bot) => {
        asked.push(bot);
        if (asked.length === 1) await hanging;
        return { ok: true, detail: 'sent' };
      },
    });
    const first = send(b, { kind: 'question' });
    await Promise.resolve();
    t += BROADCAST_INFLIGHT_MAX_MS + 60_000;
    expect((await send(b, { kind: 'question' })).status).toBe('duplicate');
    expect(asked).toEqual(['b1']);
    release();
    expect((await first).status).toBe('delivered');
  });

  test('an open record that went stale after load no longer blocks a retry', async () => {
    writeOpen(60_000);
    const { b, calls } = setup();
    t += BROADCAST_INFLIGHT_MAX_MS;
    expect((await send(b)).status).toBe('delivered');
    expect(calls).toEqual(['wake:b1']);
  });
});

describe('Broadcaster.pendingFor / markShown / markServed / signal', () => {
  test('pendingFor: delivered, not yet shown to the planner, newer than 24 h', async () => {
    const { b } = setup({ question: async () => ({ ok: false, detail: 'no' }) });
    const old = (await send(b, { insightId: 'n-old' })).broadcast;
    t += BROADCAST_PENDING_MS + 1;
    const fresh = (await send(b, { insightId: 'n-new', kind: 'directive' })).broadcast;
    await send(b, { insightId: 'n-q', kind: 'question' });
    await send(b, { botId: 'b2', insightId: 'n-b2' });
    expect(b.pendingFor('b1').map((x) => x.id)).toEqual([fresh?.id]);
    expect(old).toBeDefined();
    b.markShown([fresh?.id as string], 'c-1');
    expect(b.pendingFor('b1')).toEqual([]);
    expect(b.get(fresh?.id as string)).toMatchObject({ shownInCycle: 'c-1' });
  });

  test('markServed and signal persist (last line per id wins)', async () => {
    const { b, make } = setup();
    const x = (await send(b)).broadcast as { id: string };
    expect(b.markServed(x.id, 'c-9')).toBe(true);
    expect(b.markServed(x.id, 'c-10')).toBe(false);
    expect(b.signal(x.id, 'up')).toMatchObject({ signal: 'up' });
    expect(b.signal('b-missing', 'up')).toBeUndefined();
    const again = make();
    expect(again.get(x.id)).toMatchObject({ servedByCycle: 'c-9', signal: 'up' });
    const lines = readFileSync(broadcastsFile(dir), 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(1);
  });

  test('a malformed line is skipped on load', async () => {
    const { b, make } = setup();
    await send(b);
    const path = broadcastsFile(dir);
    writeFileSync(path, `${readFileSync(path, 'utf-8')}{oops\n`);
    expect(make().list()).toHaveLength(1);
  });

  test('list is newest first, filtered by bot', async () => {
    const { b } = setup();
    await send(b, { insightId: 'n-1' });
    t += 1000;
    await send(b, { insightId: 'n-2', botId: 'b2' });
    expect(b.list().map((x) => x.insightId)).toEqual(['n-2', 'n-1']);
    expect(b.list({ botId: 'b1' }).map((x) => x.insightId)).toEqual(['n-1']);
  });
});

describe('writeWatcherGoal', () => {
  test('appends a To do goal with source watcher and a goal event by the watcher', () => {
    const soul = join(dir, 'soul');
    const path = join(soul, 'GOALS.md');
    mkdirSync(soul, { recursive: true });
    writeFileSync(
      path,
      '## Active\n\n- [ ] Existing goal\n  - status: pending\n  - priority: high\n'
    );
    writeWatcherGoal(path, 'Merge the lead lists', 'Two bots chase the same lead', {
      now: () => new Date(t),
    });
    const { active } = parseGoals(readFileSync(path, 'utf-8'));
    const goal = active.find((g) => g.text === 'Merge the lead lists');
    expect(goal).toMatchObject({ status: 'pending', priority: 'medium', source: 'watcher' });
    expect(active.some((g) => g.text === 'Existing goal')).toBe(true);
    const events = readGoalEvents(soul);
    const add = events.find((e) => e.title === 'Merge the lead lists');
    expect(add).toMatchObject({
      op: 'add',
      actor: 'watcher',
      reason: 'Two bots chase the same lead',
    });
  });

  test('creates GOALS.md when the bot has none yet', () => {
    const soul = join(dir, 'soul2');
    mkdirSync(soul, { recursive: true });
    const path = join(soul, 'GOALS.md');
    writeWatcherGoal(path, 'First goal', 'why', { now: () => new Date(t) });
    expect(existsSync(path)).toBe(true);
    expect(parseGoals(readFileSync(path, 'utf-8')).active[0].text).toBe('First goal');
  });
});
