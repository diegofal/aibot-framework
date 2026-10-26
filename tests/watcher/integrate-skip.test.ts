/**
 * S1 (`docs/plans/watcher-autonomy-plan.md`): a non-manual integrate pass
 * whose prompt, volatile parts removed, equals the last readable pass's is
 * skipped without a model call.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMClient } from '../../src/core/llm-client';
import { DailyBudget } from '../../src/watcher/budget';
import { Graph } from '../../src/watcher/graph';
import { INTEGRATE_MIN_GAP_MS, Integrator, integrateStateFile } from '../../src/watcher/integrate';
import { instrumented } from '../../src/watcher/llm';
import { WatcherLog } from '../../src/watcher/log';
import {
  type BufferItem,
  type SensedEvent,
  WATCHER_DEFAULTS,
  type WatcherConfig,
  type WatcherLogRow,
} from '../../src/watcher/types';

const quiet = { warn: () => {} };
const usage = {
  model: 'claude-opus-5-5',
  promptTokens: 2000,
  completionTokens: 300,
  totalTokens: 2300,
};
let dir: string;
let t: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-integrate-skip-'));
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(
  opts: { replies?: string[]; agendaMax?: number; deps?: Record<string, unknown> } = {}
) {
  const now = () => t;
  const graph = new Graph(join(dir, 'g'), { now });
  graph.load();
  const a = graph.addNeuron({
    kind: 'fact',
    text: 'Jarvis is researching Acme as a lead',
    support: { bots: ['b1'] },
    createdBy: 'watcher',
  });
  const b = graph.addNeuron({
    kind: 'fact',
    text: 'Scout is researching Acme as a lead',
    support: { bots: ['b2'] },
    createdBy: 'watcher',
  });
  graph.addEdge({ from: a.id, to: b.id, rel: 'related', weight: 0.7, createdBy: 'watcher' });
  const rows: WatcherLogRow[] = [];
  const log = new WatcherLog(join(dir, 'log'), { now, onRow: (r) => rows.push(r) });
  const budget = new DailyBudget({
    dir,
    now,
    limits: () => ({
      notice: { maxPerDay: 10 },
      integrate: { maxPerDay: 20, maxTokensPerDay: 1_000_000 },
    }),
    isCircuitOpen: () => false,
  });
  const replies = [...(opts.replies ?? [])];
  let calls = 0;
  const client = {
    backend: 'claude-cli',
    generate: async () => ({ text: '' }),
    chat: async () => {
      calls++;
      return { text: replies.shift() ?? '{"insights":[]}', usage };
    },
  } as unknown as LLMClient;
  const call = instrumented(
    { client, model: 'claude-opus-5-5', backend: 'claude-cli' },
    { tier: 'integrate', caller: 'watcher:integrate', budget, now, records: null }
  );
  const config: WatcherConfig = {
    ...WATCHER_DEFAULTS,
    enabled: true,
    integrate: {
      ...WATCHER_DEFAULTS.integrate,
      enabled: true,
      wakeSalience: 0.5,
      agendaMax: opts.agendaMax ?? 0,
    },
  };
  let karma = 51.2;
  const make = () =>
    new Integrator({
      dir,
      graph,
      log,
      client: call,
      budget,
      config: () => config,
      now,
      bots: () => [
        { id: 'b1', name: 'Jarvis' },
        { id: 'b2', name: 'Scout' },
      ],
      botName: (id) => (id === 'b1' ? 'Jarvis' : 'Scout'),
      // Volatile numbers: different on every pass.
      interoception: () => {
        karma -= 0.3;
        return { fleetKarmaAvg: karma, lastIntegrateAgoMs: t };
      },
      logger: quiet,
      ...(opts.deps ?? {}),
    });
  return {
    graph,
    replies,
    rows,
    budget,
    calls: () => calls,
    integrator: make(),
    make,
    skipped: () => rows.filter((r) => r.op === 'integrate:skipped'),
  };
}

let seq = 0;
function item(what = 'researched Acme', salience = 0.6): BufferItem {
  seq++;
  const event: SensedEvent = {
    type: 'agent:result',
    botId: 'b1',
    timestamp: t,
    data: { summary: what },
  };
  return {
    id: `b-${String(seq).padStart(8, '0')}`,
    event,
    salience,
    reasons: ['novel'],
    noticedAt: new Date(t).toISOString(),
    touched: [],
  };
}

/** A first readable pass over one event, then the same event again, later. */
async function primed(s: ReturnType<typeof setup>) {
  s.integrator.observe(item());
  expect((await s.integrator.run({ trigger: 'salience' })).status).toBe('integrated');
  t += INTEGRATE_MIN_GAP_MS;
  s.integrator.observe(item());
}

describe('Integrator: unchanged-input skip', () => {
  test('a woken pass over what the last readable pass saw is skipped: no call, no budget, one row', async () => {
    const s = setup();
    await primed(s);
    const before = s.integrator.state();
    const out = await s.integrator.run({ trigger: 'salience' });
    expect(out.status).toBe('skipped');
    expect(s.calls()).toBe(1);
    expect(s.budget.used('integrate').calls).toBe(1);
    const rows = s.skipped();
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe('integrate');
    expect(rows[0].text).toMatch(/^Nothing changed since my last thought/);
    expect(rows[0].trigger).toBe('salience');
    // What the next real pass needs stays: the pending item, the run time.
    const after = s.integrator.state();
    expect(after.pending.items).toHaveLength(1);
    expect(after.pending.salience).toBeCloseTo(0.6);
    expect(after.lastRunAt).toBe(before.lastRunAt);
    // The key is persisted with the rest of the state.
    const file = JSON.parse(readFileSync(integrateStateFile(dir), 'utf-8'));
    expect(file.lastPromptKey).toMatch(/^[0-9a-f]{64}$/);
    expect(file.lastPromptKey).toBe(after.lastPromptKey);
  });

  test('a manual pass always calls the model', async () => {
    const s = setup();
    await primed(s);
    expect((await s.integrator.run()).status).toBe('integrated');
    t += INTEGRATE_MIN_GAP_MS;
    s.integrator.observe(item());
    expect((await s.integrator.run({ trigger: 'manual' })).status).toBe('integrated');
    expect(s.calls()).toBe(3);
    expect(s.skipped()).toHaveLength(0);
  });

  test('a changed prompt calls the model', async () => {
    const s = setup();
    s.integrator.observe(item());
    await s.integrator.run({ trigger: 'salience' });
    t += INTEGRATE_MIN_GAP_MS;
    s.integrator.observe(item('wrote the Acme brief'));
    expect((await s.integrator.run({ trigger: 'salience' })).status).toBe('integrated');
    expect(s.calls()).toBe(2);
    expect(s.skipped()).toHaveLength(0);
  });

  test('a skip waits out the gap before waking again, and a repeat skip writes no second row', async () => {
    const s = setup();
    await primed(s);
    expect(s.integrator.wake()).toBe('salience');
    expect((await s.integrator.run({ trigger: 'salience' })).status).toBe('skipped');
    // No loop: the skip counts as an attempt for pacing.
    expect(s.integrator.wake()).toBeNull();
    t += INTEGRATE_MIN_GAP_MS - 1;
    expect(s.integrator.wake()).toBeNull();
    t += 1;
    // Its pending salience still wakes a pass once the gap is over.
    expect(s.integrator.wake()).toBe('salience');
    expect((await s.integrator.run({ trigger: 'salience' })).status).toBe('skipped');
    expect(s.skipped()).toHaveLength(1);
    expect(s.calls()).toBe(1);
    // New content: a real pass, which reads the held item too.
    t += INTEGRATE_MIN_GAP_MS;
    s.integrator.observe(item('wrote the Acme brief'));
    expect((await s.integrator.run({ trigger: 'salience' })).status).toBe('integrated');
    expect(s.calls()).toBe(2);
    expect(s.integrator.state().pending.items).toHaveLength(0);
    // A later skip is a new streak: it gets its row.
    t += INTEGRATE_MIN_GAP_MS;
    s.integrator.observe(item());
    s.integrator.observe(item('wrote the Acme brief'));
    expect((await s.integrator.run({ trigger: 'heartbeat' })).status).toBe('skipped');
    expect(s.skipped()).toHaveLength(2);
  });

  test('an unreadable answer records no key: the same input is tried again', async () => {
    const s = setup({ replies: ['{"insights":[]}', 'not json at all'] });
    s.integrator.observe(item());
    await s.integrator.run({ trigger: 'salience' });
    t += INTEGRATE_MIN_GAP_MS;
    s.integrator.observe(item('wrote the Acme brief'));
    const keyBefore = s.integrator.state().lastPromptKey;
    expect((await s.integrator.run({ trigger: 'salience' })).status).toBe('unparsable');
    expect(s.integrator.state().lastPromptKey).toBe(keyBefore);
    t += INTEGRATE_MIN_GAP_MS;
    expect((await s.integrator.run({ trigger: 'salience' })).status).toBe('integrated');
    expect(s.calls()).toBe(3);
  });

  test('the key survives a restart', async () => {
    const s = setup();
    s.integrator.observe(item());
    await s.integrator.run({ trigger: 'salience' });
    t += INTEGRATE_MIN_GAP_MS;
    const next = s.make();
    next.observe(item());
    expect((await next.run({ trigger: 'salience' })).status).toBe('skipped');
    expect(s.calls()).toBe(1);
  });

  test('a skipped pass leaves the agenda state to the next real pass', async () => {
    const s = setup({ agendaMax: 8 });
    // The cross-bot pair is news: an agenda pass, then one with an event.
    expect(s.integrator.wake()).toBe('agenda-changed');
    expect((await s.integrator.run({ trigger: 'agenda-changed' })).status).toBe('integrated');
    t += INTEGRATE_MIN_GAP_MS;
    await primed(s);
    const real = s.integrator.state();
    expect(real.lastAgendaAt).toBe(new Date(t - INTEGRATE_MIN_GAP_MS).toISOString());
    expect((await s.integrator.run({ trigger: 'salience' })).status).toBe('skipped');
    const after = s.integrator.state();
    expect(after.lastAgendaAt).toBe(real.lastAgendaAt);
    expect(after.agendaSettledAt).toBe(real.agendaSettledAt);
    expect(after.agendaIds).toEqual(real.agendaIds);
    expect(after.agendaCovered).toEqual(real.agendaCovered);
    expect(s.calls()).toBe(2);
  });
});

describe('Integrator: unchanged-input skip never blocks a retry', () => {
  test('a due broadcast retry calls even when the text is unchanged', async () => {
    const sends: string[] = [];
    const s = setup({
      agendaMax: 8,
      deps: {
        // The failed send leaves no record the prompt could show.
        broadcaster: {
          send: async (req: { insightId: string }) => {
            sends.push(req.insightId);
            return { status: 'failed', broadcast: {} };
          },
          list: () => [],
        },
      },
    });
    const insight = s.graph.addNeuron({
      kind: 'insight',
      text: 'Jarvis and Scout both research Acme',
      support: { bots: ['b1', 'b2'] },
      confidence: 'medium',
      createdBy: 'watcher',
    });
    s.replies.push(
      JSON.stringify({
        insights: [],
        broadcasts: [{ bot: 'b1', kind: 'wake', text: 'look at Acme', insightId: insight.id }],
      })
    );
    s.integrator.observe(item());
    expect((await s.integrator.run({ trigger: 'salience' })).status).toBe('integrated');
    expect(sends).toEqual([insight.id]);
    expect(s.integrator.state().agendaRetryAt?.[insight.id]).toBeDefined();
    t += 2 * 3_600_000;
    s.integrator.observe(item());
    expect((await s.integrator.run({ trigger: 'salience' })).status).toBe('integrated');
    expect(s.calls()).toBe(2);
    expect(s.skipped()).toHaveLength(0);
  });
});
