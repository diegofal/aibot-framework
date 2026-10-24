import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmQueryEntry } from '../../src/bot/llm-query-log';
import type { LLMClient } from '../../src/core/llm-client';
import { Broadcaster } from '../../src/watcher/broadcast';
import { DailyBudget } from '../../src/watcher/budget';
import { Graph } from '../../src/watcher/graph';
import {
  INTEGRATE_MIN_GAP_MS,
  Integrator,
  integrateStateFile,
  parseIntegrateOutput,
} from '../../src/watcher/integrate';
import { instrumented } from '../../src/watcher/llm';
import { WatcherLog } from '../../src/watcher/log';
import {
  type BufferItem,
  type Neuron,
  type SensedEvent,
  WATCHER_DEFAULTS,
  type WatcherConfig,
  type WatcherLogRow,
} from '../../src/watcher/types';

const quiet = { warn: () => {} };
let dir: string;
let t: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-integrate-'));
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const usage = {
  model: 'claude-opus-5-5',
  promptTokens: 2000,
  completionTokens: 300,
  totalTokens: 2300,
  costUsd: 0.12,
};

interface Setup {
  reply?: (n: Record<string, Neuron>) => Promise<{ text: string; usage?: Record<string, unknown> }>;
  maxPerDay?: number;
  maxTokensPerDay?: number;
  open?: boolean;
  cfg?: Partial<WatcherConfig['integrate']>;
  deps?: Record<string, unknown>;
}

function setup(opts: Setup = {}) {
  const now = () => t;
  const graph = new Graph(join(dir, 'g'), { now });
  graph.load();
  const jarvis = graph.addNeuron({
    kind: 'entity',
    text: 'Jarvis',
    support: { bots: ['b1'] },
    createdBy: 'bot:b1',
    meta: { key: 'bot:b1', name: 'Jarvis' },
  });
  const leadA = graph.addNeuron({
    kind: 'fact',
    text: 'Jarvis is researching Acme as a lead',
    support: { bots: ['b1'] },
    createdBy: 'watcher',
  });
  const leadB = graph.addNeuron({
    kind: 'fact',
    text: 'Scout is researching Acme as a lead',
    support: { bots: ['b2'], conversations: ['telegram:7'] },
    createdBy: 'watcher',
  });
  const near = graph.addNeuron({
    kind: 'topic',
    text: 'Sales leads',
    support: { bots: ['b2'] },
    createdBy: 'bot:b2',
  });
  graph.addEdge({ from: leadB.id, to: near.id, rel: 'related', weight: 0.6, createdBy: 'watcher' });
  const goal = graph.addNeuron({
    kind: 'goal',
    text: 'Map the Acme account',
    support: { bots: ['b2'] },
    createdBy: 'bot:b2',
    meta: { status: 'in_progress' },
  });
  const ids: Record<string, Neuron> = { jarvis, leadA, leadB, near, goal };
  const rows: WatcherLogRow[] = [];
  const log = new WatcherLog(join(dir, 'log'), { now, onRow: (r) => rows.push(r) });
  const budget = new DailyBudget({
    dir,
    now,
    limits: () => ({
      notice: { maxPerDay: 10 },
      integrate: {
        maxPerDay: opts.maxPerDay ?? 5,
        maxTokensPerDay: opts.maxTokensPerDay ?? 1_000_000,
      },
    }),
    isCircuitOpen: () => opts.open === true,
  });
  const prompts: string[] = [];
  const client = {
    backend: 'claude-cli',
    generate: async () => ({ text: '' }),
    chat: async (messages: Array<{ role: string; content: string }>) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return (opts.reply ?? (async () => ({ text: '{"insights":[]}', usage })))(ids);
    },
  } as unknown as LLMClient;
  const entries: LlmQueryEntry[] = [];
  const call = instrumented(
    { client, model: 'claude-opus-5-5', backend: 'claude-cli' },
    {
      tier: 'integrate',
      caller: 'watcher:integrate',
      budget,
      queryLog: { append: (e) => entries.push(e) },
      now,
    }
  );
  const config: WatcherConfig = {
    ...WATCHER_DEFAULTS,
    enabled: true,
    integrate: { ...WATCHER_DEFAULTS.integrate, enabled: true, salienceBar: 1, ...opts.cfg },
  };
  const delivered: string[] = [];
  const broadcaster = new Broadcaster({
    dir,
    now,
    log,
    delivery: {
      wake: (b) => {
        delivered.push(`wake:${b}`);
      },
      directive: (b, text) => {
        delivered.push(`directive:${b}:${text}`);
      },
    },
  });
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
      botName: (id) => (id === 'b1' ? 'Jarvis' : id === 'b2' ? 'Scout' : id),
      broadcaster,
      logger: quiet,
      ...(opts.deps ?? {}),
    });
  return {
    graph,
    rows,
    log,
    budget,
    prompts,
    entries,
    broadcaster,
    delivered,
    integrator: make(),
    make,
    n: { jarvis, leadA, leadB, near, goal },
  };
}

let seq = 0;
function item(event: SensedEvent, salience = 0.6, extra: Partial<BufferItem> = {}): BufferItem {
  seq++;
  return {
    id: `b-${String(seq).padStart(8, '0')}`,
    event,
    salience,
    reasons: ['novel'],
    noticedAt: new Date(t).toISOString(),
    touched: [],
    ...extra,
  };
}
const cycleDone = (botId: string, ts = t): SensedEvent => ({
  type: 'agent:result',
  botId,
  timestamp: ts,
  data: { summary: 'researched Acme', cycleId: `c-${botId}` },
});

function answer(o: (n: Record<string, Neuron>) => Record<string, unknown>) {
  return async (n: Record<string, Neuron>) => ({ text: JSON.stringify(o(n)), usage });
}

describe('parseIntegrateOutput', () => {
  test('reads every list and drops malformed entries', () => {
    const out = parseIntegrateOutput(
      JSON.stringify({
        insights: [{ text: 'a', support: ['n-1'], confidence: 'high' }, 'bad'],
        contradictions: [{ a: 'n-1', b: 'n-2', text: 'x' }],
        predictions: [{ text: 'p', horizonHours: 12, probability: 0.6, neuronIds: ['n-1'] }],
        broadcasts: [{ bot: 'b1', kind: 'wake', text: '', insightIndex: 0 }],
        attending: ['n-1', 3],
      }),
      quiet
    );
    expect(out?.insights).toEqual([{ text: 'a', support: ['n-1'], confidence: 'high' }]);
    expect(out?.contradictions).toHaveLength(1);
    expect(out?.predictions[0]).toMatchObject({ horizonHours: 12, probability: 0.6 });
    expect(out?.broadcasts[0]).toMatchObject({ bot: 'b1', kind: 'wake', insightIndex: 0 });
    expect(out?.attending).toEqual(['n-1']);
  });

  test('reads drivenBy as a list of strings, empty when absent', () => {
    const out = parseIntegrateOutput(
      JSON.stringify({ insights: [], drivenBy: ['operatorSilenceHours', 7] }),
      quiet
    );
    expect(out?.drivenBy).toEqual(['operatorSilenceHours']);
    expect(parseIntegrateOutput('{"insights":[]}', quiet)?.drivenBy).toEqual([]);
  });

  test('null when it is not the integrate JSON', () => {
    expect(parseIntegrateOutput('hello', quiet)).toBeNull();
  });

  test('missing lists are empty', () => {
    expect(parseIntegrateOutput('{"insights": []}', quiet)).toEqual({
      insights: [],
      contradictions: [],
      predictions: [],
      broadcasts: [],
      attending: [],
      drivenBy: [],
      agendaCovered: [],
      noBroadcast: [],
    });
  });
});

describe('Integrator.due', () => {
  test('nothing pending is never due', () => {
    const s = setup();
    t += 10 * 3_600_000;
    expect(s.integrator.due()).toBe(false);
  });

  test('due when the accumulated salience reaches the bar', () => {
    const s = setup();
    t += INTEGRATE_MIN_GAP_MS;
    s.integrator.observe(item(cycleDone('b1'), 0.6));
    expect(s.integrator.due()).toBe(false);
    s.integrator.observe(item(cycleDone('b2'), 0.6));
    expect(s.integrator.due()).toBe(true);
  });

  // Changed on 2026-10-24 (was "due with anything pending"): heartbeat passes
  // on 1-3 events produced nothing live, so the heartbeat now waits for
  // `integrate.minItems` salient items.
  test('the heartbeat makes a pass due only with integrate.minItems salient items pending', () => {
    const s = setup({ cfg: { heartbeatMs: 3_600_000, salienceBar: 100, minItems: 3 } });
    s.integrator.observeNotice({ status: 'noticed', created: [s.n.leadA], recognised: [] });
    s.integrator.observe(item(cycleDone('b1'), 0.2));
    s.integrator.observe(item(cycleDone('b2'), 0.2));
    t += 3_600_000;
    expect(s.integrator.due()).toBe(false);
    s.integrator.observe(item(cycleDone('b1'), 0.2));
    expect(s.integrator.due()).toBe(true);
  });

  test('minItems defaults to 5 and agendaMax to 8', () => {
    expect(WATCHER_DEFAULTS.integrate.minItems).toBe(5);
    expect(WATCHER_DEFAULTS.integrate.agendaMax).toBe(8);
  });

  test('never two attempts closer than the minimum gap', async () => {
    const s = setup({ reply: async () => ({ text: 'nope', usage }) });
    t += INTEGRATE_MIN_GAP_MS;
    s.integrator.observe(item(cycleDone('b1'), 2));
    expect(s.integrator.due()).toBe(true);
    await s.integrator.run();
    expect(s.integrator.due()).toBe(false);
    t += INTEGRATE_MIN_GAP_MS;
    expect(s.integrator.due()).toBe(true);
  });
});

describe('Integrator.run', () => {
  const full = answer((n) => ({
    insights: [
      {
        text: 'Jarvis and Scout both chase Acme without knowing it',
        support: [n.leadA.id, n.leadB.id, 'n-invented'],
        confidence: 'high',
      },
      { text: 'Unsupported idea', support: ['n-invented'] },
    ],
    contradictions: [
      { a: n.leadA.id, b: n.goal.id, text: 'Who owns Acme is unclear' },
      { a: n.leadA.id, b: 'n-invented', text: 'dropped' },
    ],
    predictions: [
      {
        text: 'Scout contacts Acme within a day',
        horizonHours: 24,
        probability: 0.7,
        about: 'b2',
        neuronIds: [n.leadB.id],
      },
    ],
    broadcasts: [
      { bot: 'b1', kind: 'directive', text: 'Coordinate with Scout on Acme', insightIndex: 0 },
      { bot: 'b2', kind: 'wake', text: '', insightIndex: 0 },
      { bot: 'nobody', kind: 'wake', text: '', insightIndex: 0 },
      { bot: 'b1', kind: 'wake', text: '', insightIndex: 1 },
    ],
    attending: [n.leadA.id, 'n-unknown'],
  }));

  async function ran(s: ReturnType<typeof setup>) {
    s.integrator.observe(item(cycleDone('b1', t - 60_000), 1.5));
    s.integrator.observeNotice({
      status: 'noticed',
      created: [s.n.leadA, s.n.leadB],
      recognised: [],
    });
    return s.integrator.run();
  }

  test('a cancel during a slow broadcast keeps what the pass wrote consumed: a restart does not re-integrate it', async () => {
    const gate: { release?: () => void; calls: number } = { calls: 0 };
    let cancelled = false;
    const slow = {
      send: () => {
        gate.calls++;
        return new Promise((resolve) => {
          gate.release = () => resolve({ status: 'delivered' });
        });
      },
    };
    // agendaMax 0: the insight this pass writes would otherwise wait on the
    // standing agenda, and the restart below would run a (legitimate) agenda
    // pass on the canned reply. This test is about pending items only.
    const s = setup({ reply: full, deps: { broadcaster: slow }, cfg: { agendaMax: 0 } });
    s.integrator.observe(item(cycleDone('b1', t - 60_000), 1.5));
    s.integrator.observeNotice({
      status: 'noticed',
      created: [s.n.leadA, s.n.leadB],
      recognised: [],
    });
    const pass = s.integrator.run({ isCancelled: () => cancelled });
    for (let i = 0; i < 100 && gate.calls === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(gate.calls).toBe(1);
    cancelled = true;
    gate.release?.();
    expect((await pass).status).toBe('cancelled');
    expect(gate.calls).toBe(1);

    const count = (kind: string) => s.graph.list().filter((x) => x.kind === kind).length;
    expect(count('prediction')).toBe(1);
    expect(count('contradiction')).toBe(1);

    // Restart: a fresh integrator reads the persisted state.
    t += INTEGRATE_MIN_GAP_MS;
    const again = s.make();
    expect(again.state().pending).toMatchObject({ items: [], neurons: [] });
    expect(again.due()).toBe(false);
    await again.run();
    expect(count('prediction')).toBe(1);
    expect(count('contradiction')).toBe(1);
  });

  test('writes neurons, edges, broadcasts and a pass row with cost', async () => {
    const s = setup({ reply: full });
    const out = await ran(s);
    expect(out.status).toBe('integrated');

    const insight = s.graph.list().find((x) => x.kind === 'insight');
    expect(insight).toMatchObject({
      text: 'Jarvis and Scout both chase Acme without knowing it',
      createdBy: 'watcher',
      confidence: 'high',
      support: { bots: ['b1', 'b2'], conversations: ['telegram:7'] },
    });
    expect(insight?.meta?.supportNeurons).toBe(`${s.n.leadA.id},${s.n.leadB.id}`);
    expect(insight?.meta?.model).toBe('claude-opus-5-5');
    expect(insight?.meta?.eventAt).toBe(new Date(t - 60_000).toISOString());
    expect(s.graph.list().filter((x) => x.kind === 'insight')).toHaveLength(1);
    const caused = s.graph.edgesOf(insight?.id as string).filter((e) => e.rel === 'caused');
    expect(caused.map((e) => e.from).sort()).toEqual([s.n.leadA.id, s.n.leadB.id].sort());

    const contra = s.graph.list().filter((x) => x.kind === 'contradiction');
    expect(contra).toHaveLength(1);
    expect(contra[0].meta).toMatchObject({ a: s.n.leadA.id, b: s.n.goal.id });
    const contraEdges = s.graph.edgesOf(contra[0].id).filter((e) => e.rel === 'contradicts');
    expect(contraEdges).toHaveLength(2);

    const pred = s.graph.list().find((x) => x.kind === 'prediction');
    expect(pred?.meta).toMatchObject({
      probability: '0.7',
      horizonHours: '24',
      about: 'b2',
      dueAt: new Date(t + 24 * 3_600_000).toISOString(),
    });
    expect(s.graph.edgesOf(pred?.id as string).some((e) => e.rel === 'predicts')).toBe(true);

    expect(s.delivered).toEqual(['directive:b1:Coordinate with Scout on Acme', 'wake:b2']);
    const bs = s.broadcaster.list();
    expect(bs.every((b) => b.insightId === insight?.id)).toBe(true);

    const pass = s.rows.find((r) => r.op === 'integrate:pass');
    expect(pass).toMatchObject({
      phase: 'integrate',
      model: 'claude-opus-5-5',
      tokens: 2300,
      costUsd: 0.12,
      source: 'watcher:integrate',
    });
    expect(pass?.text).toBe(
      'Integrated 1 event: 1 insight, 1 contradiction, 1 prediction, 2 broadcasts.'
    );
    expect(s.rows.filter((r) => r.op === 'integrate:insight')).toHaveLength(1);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ botId: '__watcher__', caller: 'watcher:integrate' });
  });

  test('phase 4: the prompt shows how I am and what I attend to; drivenBy lands on the pass row', async () => {
    const s = setup({
      reply: answer(() => ({
        insights: [],
        drivenBy: ['operatorSilenceHours', 'not-a-variable', 'bufferSalience'],
      })),
      deps: {
        interoception: () => ({ operatorSilenceHours: 30, bufferSalience: 1.5 }),
        attention: () => ({
          phase: 'integrate',
          items: [],
          focusNeuronIds: [],
          focus: [{ id: 'n-x', kind: 'insight', text: 'Two bots, one lead' }],
        }),
      },
    });
    await ran(s);
    expect(s.prompts[0]).toContain('## How I am');
    expect(s.prompts[0]).toContain('## What I am attending to');
    expect(s.prompts[0]).toContain('Two bots, one lead');
    const pass = s.rows.find((r) => r.op === 'integrate:pass');
    expect(pass?.drivenBy).toEqual(['operatorSilenceHours', 'bufferSalience']);
  });

  test('phase 4: without an interoception record drivenBy is not written', async () => {
    const s = setup({
      reply: answer(() => ({ insights: [], drivenBy: ['operatorSilenceHours'] })),
    });
    await ran(s);
    const pass = s.rows.find((r) => r.op === 'integrate:pass');
    expect(pass).not.toHaveProperty('drivenBy');
  });

  test('the prompt shows events, fresh neurons, neighbourhood, goals and bots', async () => {
    const s = setup({ reply: full });
    await ran(s);
    expect(s.prompts[0]).toContain('## What happened since my last thought');
    expect(s.prompts[0]).toContain(`[${s.n.leadA.id}] fact: Jarvis is researching Acme`);
    expect(s.prompts[0]).toContain(`[${s.n.near.id}] topic: Sales leads`);
    expect(s.prompts[0]).toContain(`Scout (b2): [${s.n.goal.id}] Map the Acme account`);
    expect(s.prompts[0]).toContain('- b1: Jarvis');
  });

  test('`attending` is stored on the state (known ids only) and survives a restart', async () => {
    const s = setup({ reply: full });
    await ran(s);
    expect(s.integrator.attending()).toEqual([s.n.leadA.id]);
    expect(s.make().attending()).toEqual([s.n.leadA.id]);
    expect(integrateStateFile(dir)).toContain('integrate.json');
  });

  test('a successful pass empties what was pending; the next run is idle', async () => {
    const s = setup({ reply: full });
    await ran(s);
    expect(s.integrator.state().pending.items).toHaveLength(0);
    expect(s.integrator.state().pending.neurons).toHaveLength(0);
    t += INTEGRATE_MIN_GAP_MS;
    expect((await s.integrator.run()).status).toBe('idle');
  });

  test('an insight the graph already has is recognised, not duplicated', async () => {
    const s = setup({ reply: full });
    const existing = s.graph.addNeuron({
      kind: 'insight',
      text: 'Jarvis and Scout both chase Acme without knowing it',
      support: { bots: ['b1', 'b2'] },
      createdBy: 'watcher',
    });
    await ran(s);
    const insights = s.graph.list().filter((x) => x.kind === 'insight');
    expect(insights).toHaveLength(1);
    expect(s.graph.get(existing.id)?.activations).toBe(1);
    expect(s.broadcaster.list()[0].insightId).toBe(existing.id);
  });

  test('unparsable output keeps everything pending and logs a failed row', async () => {
    const s = setup({ reply: async () => ({ text: 'I think things', usage }) });
    const out = await ran(s);
    expect(out.status).toBe('unparsable');
    expect(s.integrator.state().pending.items).toHaveLength(1);
    expect(s.integrator.state().pending.neurons).toHaveLength(2);
    expect(s.rows.some((r) => r.op === 'integrate:failed' && r.costUsd === 0.12)).toBe(true);
    expect(s.graph.list().some((x) => x.kind === 'insight')).toBe(false);
  });

  test('a failing call keeps everything pending', async () => {
    const s = setup({
      reply: async () => {
        throw new Error('cli died');
      },
    });
    const out = await ran(s);
    expect(out.status).toBe('failed');
    expect(s.integrator.state().pending.items).toHaveLength(1);
    expect(s.rows.some((r) => r.op === 'integrate:failed')).toBe(true);
  });

  test('the daily cap stops it with one log row, and no call is made', async () => {
    const s = setup({ maxPerDay: 0 });
    expect((await ran(s)).status).toBe('capped');
    t += INTEGRATE_MIN_GAP_MS;
    expect((await s.integrator.run()).status).toBe('capped');
    expect(s.prompts).toHaveLength(0);
    expect(s.rows.filter((r) => r.op === 'integrate:capped')).toHaveLength(1);
  });

  test('the token cap stops it too', async () => {
    const s = setup({ maxTokensPerDay: 0 });
    expect((await ran(s)).status).toBe('capped');
    expect(s.rows.find((r) => r.op === 'integrate:capped')?.text).toContain('token budget');
  });

  test('an open breaker pauses it with one row per episode', async () => {
    const s = setup({ open: true });
    expect((await ran(s)).status).toBe('breaker');
    t += INTEGRATE_MIN_GAP_MS;
    expect((await s.integrator.run()).status).toBe('breaker');
    expect(s.prompts).toHaveLength(0);
    expect(s.rows.filter((r) => r.op === 'integrate:paused')).toHaveLength(1);
  });

  test('concurrent runs share one pass (one call)', async () => {
    const s = setup({ reply: full });
    s.integrator.observe(item(cycleDone('b1'), 1.5));
    const [a, b] = await Promise.all([s.integrator.run(), s.integrator.run()]);
    expect(a).toBe(b);
    expect(s.prompts).toHaveLength(1);
  });

  test('items observed while a pass runs stay pending for the next one', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = setup({
      reply: async () => {
        await gate;
        return { text: '{"insights": []}', usage };
      },
    });
    s.integrator.observe(item(cycleDone('b1'), 1.5));
    const run = s.integrator.run();
    await new Promise((r) => setTimeout(r, 5));
    const late = item(cycleDone('b2'), 0.4);
    s.integrator.observe(late);
    release();
    await run;
    expect(s.integrator.state().pending.items.map((i) => i.id)).toEqual([late.id]);
    expect(s.integrator.state().pending.salience).toBeCloseTo(0.4, 10);
  });

  test('neurons made from operator-sourced material are operator-sourced', async () => {
    const s = setup({ reply: full });
    s.graph.patchMeta(s.n.leadB.id, { operatorSourced: 'true' });
    await ran(s);
    for (const kind of ['insight', 'contradiction', 'prediction'] as const) {
      const n = s.graph.list().find((x) => x.kind === kind);
      expect(n?.meta?.operatorSourced).toBe('true');
    }
  });

  test('an operator event shown to the model marks what the pass creates', async () => {
    const s = setup({ reply: full });
    s.integrator.observe(
      item(
        {
          botId: 'b1',
          channelKind: 'dashboard',
          chatId: 'operator',
          userId: 'operator',
          timestamp: t,
          text: 'Acme is my brother-in-law',
        },
        1,
        { fromOperator: true }
      )
    );
    await ran(s);
    expect(s.graph.list().find((x) => x.kind === 'insight')?.meta?.operatorSourced).toBe('true');
  });

  // A cycle is what the operator's bot works on: operator material.
  test('bot activity shown to the model marks what the pass creates', async () => {
    const s = setup({ reply: full });
    await ran(s);
    expect(s.graph.list().find((x) => x.kind === 'insight')?.meta?.operatorSourced).toBe('true');
  });

  test('only non-operator messages and unmarked neurons: nothing is operator-sourced', async () => {
    const s = setup({ reply: full });
    s.integrator.observe(
      item(
        {
          botId: 'b1',
          channelKind: 'web',
          chatId: 'w-anon',
          userId: 'w-anon',
          timestamp: t - 60_000,
          text: 'acme leads',
        },
        1.5
      )
    );
    s.integrator.observeNotice({
      status: 'noticed',
      created: [s.n.leadA, s.n.leadB],
      recognised: [],
    });
    await s.integrator.run();
    const insight = s.graph.list().find((x) => x.kind === 'insight');
    expect(insight).toBeDefined();
    expect(insight?.meta?.operatorSourced).toBeUndefined();
  });

  // Integrate shows the neighbourhood, goals, insights and predictions in
  // full: an operator-sourced one marks the pass even when nothing cites it.
  test('an operator-sourced neuron only shown (never cited) marks what the pass creates', async () => {
    const s = setup({ reply: full });
    s.graph.patchMeta(s.n.near.id, { operatorSourced: 'true' });
    s.integrator.observe(
      item(
        {
          botId: 'b1',
          channelKind: 'web',
          chatId: 'w-anon',
          userId: 'w-anon',
          timestamp: t - 60_000,
          text: 'acme leads',
        },
        1.5
      )
    );
    s.integrator.observeNotice({
      status: 'noticed',
      created: [s.n.leadA, s.n.leadB],
      recognised: [],
    });
    await s.integrator.run();
    expect(s.prompts[0]).toContain(`[${s.n.near.id}]`);
    const insight = s.graph.list().find((x) => x.kind === 'insight');
    expect(insight?.meta?.supportNeurons).not.toContain(s.n.near.id);
    expect(insight?.meta?.operatorSourced).toBe('true');
  });

  test('integrate off (config) makes run idle without a call', async () => {
    const s = setup({ reply: full, cfg: { enabled: false } });
    expect((await ran(s)).status).toBe('idle');
    expect(s.prompts).toHaveLength(0);
  });
});
