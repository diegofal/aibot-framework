/**
 * Integrate must act (2026-10-24): after four Opus passes the watcher had two
 * cross-bot insights and zero broadcasts, while the graph held two bots
 * writing the same Monday brief. Criteria in the prompt, a standing agenda of
 * cross-bot knowledge and insights still waiting, broadcasts from existing
 * insights by id, and a `whyNoBroadcast` on every insight that should have
 * acted and did not.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMClient } from '../../src/core/llm-client';
import { BROADCAST_INFLIGHT_MAX_MS, Broadcaster } from '../../src/watcher/broadcast';
import { DailyBudget } from '../../src/watcher/budget';
import { Graph } from '../../src/watcher/graph';
import {
  DEFERRED_QUESTIONS_MAX,
  DEFERRED_QUESTION_MAX_AGE_MS,
  INTEGRATE_MIN_GAP_MS,
  Integrator,
  insightNeedsBroadcast,
  integrateStateFile,
  parseIntegrateOutput,
} from '../../src/watcher/integrate';
import { instrumented } from '../../src/watcher/llm';
import { WatcherLog } from '../../src/watcher/log';
import {
  type BufferItem,
  type Neuron,
  WATCHER_DEFAULTS,
  type WatcherConfig,
  type WatcherLogRow,
} from '../../src/watcher/types';

const quiet = { warn: () => {} };
const usage = { model: 'claude-opus-5-5', promptTokens: 10, completionTokens: 10, totalTokens: 20 };
let dir: string;
let t: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-act-'));
  t = Date.parse('2026-10-24T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Reply = () => Record<string, unknown>;

function setup(
  reply: Reply = () => ({}),
  cfg: Partial<WatcherConfig['integrate']> = {},
  deps: Record<string, unknown> = {}
) {
  const now = () => t;
  const graph = new Graph(join(dir, 'g'), { now });
  graph.load();
  const a = graph.addNeuron({
    kind: 'fact',
    text: 'Jarvis writes the Monday AI-engineer brief',
    support: { bots: ['b1'] },
    createdBy: 'watcher',
  });
  const b = graph.addNeuron({
    kind: 'fact',
    text: 'Scout writes the Monday AI-engineer brief',
    support: { bots: ['b2'] },
    createdBy: 'watcher',
  });
  const edge = graph.addEdge({
    from: a.id,
    to: b.id,
    rel: 'related',
    weight: 0.9,
    createdBy: 'watcher',
  });
  const rows: WatcherLogRow[] = [];
  const warns: string[] = [];
  const log = new WatcherLog(join(dir, 'log'), { now, onRow: (r) => rows.push(r) });
  const budget = new DailyBudget({
    dir,
    now,
    limits: () => ({
      notice: { maxPerDay: 10 },
      integrate: { maxPerDay: 10, maxTokensPerDay: 1_000_000 },
    }),
    isCircuitOpen: () => false,
  });
  const prompts: string[] = [];
  const client = {
    backend: 'claude-cli',
    generate: async () => ({ text: '' }),
    chat: async (messages: Array<{ content: string }>) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return { text: JSON.stringify(reply()), usage };
    },
  } as unknown as LLMClient;
  const call = instrumented(
    { client, model: 'claude-opus-5-5', backend: 'claude-cli' },
    { tier: 'integrate', caller: 'watcher:integrate', budget, now }
  );
  const config: WatcherConfig = {
    ...WATCHER_DEFAULTS,
    enabled: true,
    integrate: { ...WATCHER_DEFAULTS.integrate, enabled: true, wakeSalience: 1, ...cfg },
  };
  const delivered: string[] = [];
  const broadcaster = new Broadcaster({
    dir,
    now,
    log,
    delivery: {
      wake: (bot) => {
        delivered.push(`wake:${bot}`);
      },
      directive: (bot, text) => {
        delivered.push(`directive:${bot}:${text}`);
      },
    },
  });
  const integrator = new Integrator({
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
    logger: { warn: (_o: object, msg: string) => warns.push(msg) },
    ...deps,
  });
  return { graph, rows, prompts, delivered, broadcaster, integrator, a, b, edge, warns };
}

let seq = 0;
function item(salience = 1.5): BufferItem {
  seq++;
  return {
    id: `b-${String(seq).padStart(8, '0')}`,
    event: { type: 'agent:result', botId: 'b1', timestamp: t - 60_000, data: { summary: 'x' } },
    salience,
    reasons: ['novel'],
    noticedAt: new Date(t).toISOString(),
    touched: [],
  };
}

function pass(s: ReturnType<typeof setup>) {
  s.integrator.observe(item());
  return s.integrator.run();
}

const agendaOf = (prompt: string) => prompt.split('## Standing agenda')[1]?.split('\n## ')[0] ?? '';
const DUP = 'Jarvis and Scout both write the Monday AI-engineer brief';

describe('Integrator: making integrate act', () => {
  test('a duplicate-work insight comes with a directive to one bot, from the standing agenda', async () => {
    const ref: { s?: ReturnType<typeof setup> } = {};
    const s = setup(() => ({
      insights: [{ text: DUP, support: [ref.s?.a.id, ref.s?.b.id], confidence: 'medium' }],
      broadcasts: [
        {
          bot: 'b2',
          kind: 'directive',
          text: 'Jarvis owns the Monday brief; stop yours',
          insightIndex: 0,
        },
      ],
      agendaCovered: [ref.s?.edge.id],
    }));
    ref.s = s;
    const out = await pass(s);
    expect(out.status).toBe('integrated');
    expect(agendaOf(s.prompts[0] as string)).toContain(`[${s.edge.id}]`);
    expect(s.prompts[0]).toContain('broadcasts today 0/3');
    expect(s.delivered).toEqual(['directive:b2:Jarvis owns the Monday brief; stop yours']);
    const row = s.rows.find((r) => r.op === 'integrate:insight');
    expect(row?.whyNoBroadcast).toBeUndefined();
    expect(row?.broadcastReasonMissing).toBeUndefined();
  });

  test('whyNoBroadcast is logged on the insight row and kept on the neuron', async () => {
    const ref: { s?: ReturnType<typeof setup> } = {};
    const why = 'Only the operator can pick which brief stays; Scout is capped today';
    const s = setup(() => ({
      insights: [
        {
          text: DUP,
          support: [ref.s?.a.id, ref.s?.b.id],
          confidence: 'high',
          whyNoBroadcast: why,
        },
      ],
      broadcasts: [],
    }));
    ref.s = s;
    await pass(s);
    const row = s.rows.find((r) => r.op === 'integrate:insight');
    expect(row?.whyNoBroadcast).toBe(why);
    expect(row?.text).toContain(`no broadcast: "${why}"`);
    const insight = s.graph.list().find((n) => n.kind === 'insight');
    expect(insight?.meta?.whyNoBroadcast).toBe(why);
  });

  test('an insight that needs a broadcast and has neither says so on its row', async () => {
    const ref: { s?: ReturnType<typeof setup> } = {};
    const s = setup(() => ({
      insights: [{ text: DUP, support: [ref.s?.a.id, ref.s?.b.id], confidence: 'medium' }],
    }));
    ref.s = s;
    await pass(s);
    const row = s.rows.find((r) => r.op === 'integrate:insight');
    expect(row?.broadcastReasonMissing).toBe(true);
    expect(row?.text).toContain('no broadcast and no reason given');
  });

  test('a low-confidence or single-bot insight needs no reason', async () => {
    const ref: { s?: ReturnType<typeof setup> } = {};
    const s = setup(() => ({
      insights: [
        { text: DUP, support: [ref.s?.a.id, ref.s?.b.id], confidence: 'low' },
        {
          text: 'Jarvis keeps rewriting its Monday brief',
          support: [ref.s?.a.id],
          confidence: 'high',
        },
      ],
    }));
    ref.s = s;
    await pass(s);
    const rows = s.rows.filter((r) => r.op === 'integrate:insight');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.broadcastReasonMissing === undefined)).toBe(true);
  });

  test('per-bot caps still hold, and the prompt shows the bot as capped', async () => {
    const ref: { s?: ReturnType<typeof setup> } = {};
    const s = setup(() => ({
      insights: [{ text: DUP, support: [ref.s?.a.id, ref.s?.b.id], confidence: 'high' }],
      broadcasts: [{ bot: 'b2', kind: 'directive', text: 'Stop the brief', insightIndex: 0 }],
    }));
    ref.s = s;
    for (let i = 0; i < 3; i++) {
      await s.broadcaster.send({ botId: 'b2', kind: 'wake', text: '', insightId: `n-other00${i}` });
    }
    s.delivered.length = 0;
    const out = await pass(s);
    expect(s.prompts[0]).toContain('- b2: Scout · broadcasts today 3/3 (capped)');
    expect(out.status === 'integrated' && out.broadcasts.map((b) => b.status)).toEqual(['capped']);
    expect(s.delivered).toEqual([]);
  });

  test('a broadcast may come from an insight already in the graph, by insightId', async () => {
    const ref: { existing?: Neuron } = {};
    const s = setup(() => ({
      broadcasts: [{ bot: 'b1', kind: 'wake', text: '', insightId: ref.existing?.id }],
    }));
    ref.existing = s.graph.addNeuron({
      kind: 'insight',
      text: 'The recruiting pilot rests on a RoBERTa figure that Jarvis found to be wrong',
      support: { bots: ['b1', 'b2'] },
      createdBy: 'watcher',
      confidence: 'high',
    });
    await pass(s);
    expect(agendaOf(s.prompts[0] as string)).toContain(`[${ref.existing.id}]`);
    expect(s.delivered).toEqual(['wake:b1']);
    expect(s.broadcaster.list()[0]?.insightId).toBe(ref.existing.id);
  });

  test('agendaCovered and noBroadcast take items off the standing agenda', async () => {
    const ref: { s?: ReturnType<typeof setup>; existing?: Neuron; first: boolean } = {
      first: true,
    };
    const s = setup(() => {
      const o = ref.first
        ? {
            agendaCovered: [ref.s?.edge.id, 'e-unknown0'],
            noBroadcast: [{ insightId: ref.existing?.id, why: 'The operator already chose' }],
          }
        : {};
      ref.first = false;
      return o;
    });
    ref.s = s;
    const existing = s.graph.addNeuron({
      kind: 'insight',
      text: 'Two Monday briefs overlap',
      support: { bots: ['b1', 'b2'] },
      createdBy: 'watcher',
      confidence: 'medium',
    });
    ref.existing = existing;
    await pass(s);
    expect(agendaOf(s.prompts[0] as string)).toContain(`[${s.edge.id}]`);
    expect(agendaOf(s.prompts[0] as string)).toContain(`[${existing.id}]`);
    expect(s.graph.get(existing.id)?.meta?.whyNoBroadcast).toBe('The operator already chose');
    const row = s.rows.find((r) => r.op === 'integrate:no-broadcast');
    expect(row?.text).toContain('The operator already chose');
    expect(row?.neuronIds).toEqual([existing.id]);
    expect(s.integrator.state().agendaCovered).toEqual([s.edge.id]);

    t += INTEGRATE_MIN_GAP_MS;
    await pass(s);
    expect(s.prompts).toHaveLength(2);
    expect(agendaOf(s.prompts[1] as string)).not.toContain(s.edge.id);
    expect(agendaOf(s.prompts[1] as string)).not.toContain(existing.id);
  });

  test('a pair an insight already stands on is not on the agenda', async () => {
    const s = setup();
    const ins = s.graph.addNeuron({
      kind: 'insight',
      text: 'Both write it',
      support: { bots: ['b1', 'b2'] },
      createdBy: 'watcher',
      meta: { whyNoBroadcast: 'handled' },
    });
    for (const x of [s.a, s.b]) {
      s.graph.addEdge({ from: x.id, to: ins.id, rel: 'caused', weight: 0.8, createdBy: 'watcher' });
    }
    await pass(s);
    expect(s.prompts[0]).not.toContain(s.edge.id);
  });

  test('a related pair within one bot is not on the agenda', async () => {
    const s = setup();
    const c = s.graph.addNeuron({
      kind: 'topic',
      text: 'Monday briefs',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
    });
    const own = s.graph.addEdge({
      from: s.a.id,
      to: c.id,
      rel: 'related',
      weight: 0.95,
      createdBy: 'watcher',
    });
    await pass(s);
    expect(agendaOf(s.prompts[0] as string)).toContain(s.edge.id);
    expect(agendaOf(s.prompts[0] as string)).not.toContain(own.id);
  });

  test('the agenda shows at most integrate.agendaMax pairs, strongest first', async () => {
    const s = setup(undefined, { agendaMax: 1 });
    const c = s.graph.addNeuron({
      kind: 'topic',
      text: 'AI engineer hiring',
      support: { bots: ['b2'] },
      createdBy: 'watcher',
    });
    const weak = s.graph.addEdge({
      from: s.a.id,
      to: c.id,
      rel: 'related',
      weight: 0.5,
      createdBy: 'watcher',
    });
    await pass(s);
    expect(agendaOf(s.prompts[0] as string)).toContain(s.edge.id);
    expect(agendaOf(s.prompts[0] as string)).not.toContain(weak.id);
  });

  test('parse reads whyNoBroadcast, insightId, agendaCovered and noBroadcast', () => {
    const out = parseIntegrateOutput(
      JSON.stringify({
        insights: [{ text: 'x', support: ['n-1'], whyNoBroadcast: 'because' }],
        broadcasts: [{ bot: 'b1', kind: 'wake', text: '', insightId: 'n-2' }],
        agendaCovered: ['e-1', 3],
        noBroadcast: [{ insightId: 'n-3', why: 'no' }, { insightId: 'n-4' }, 'junk'],
      }),
      quiet
    );
    expect(out?.insights[0]?.whyNoBroadcast).toBe('because');
    expect(out?.broadcasts[0]).toMatchObject({ insightId: 'n-2', insightIndex: -1 });
    expect(out?.agendaCovered).toEqual(['e-1']);
    expect(out?.noBroadcast).toEqual([{ insightId: 'n-3', why: 'no' }]);
  });
});

describe('insightNeedsBroadcast', () => {
  const bots = [
    { id: 'b1', name: 'Jarvis' },
    { id: 'b2', name: 'Scout' },
  ];
  const n = (text: string, botsOf: string[], confidence?: 'low' | 'medium' | 'high') =>
    ({ text, support: { bots: botsOf }, ...(confidence ? { confidence } : {}) }) as Neuron;

  test('medium or high, two or more bots, names a bot (by name or id)', () => {
    expect(insightNeedsBroadcast(n('Jarvis duplicates work', ['b1', 'b2'], 'medium'), bots)).toBe(
      true
    );
    expect(insightNeedsBroadcast(n('b2 duplicates work', ['b1', 'b2'], 'high'), bots)).toBe(true);
  });

  test('not when low, single-bot, or naming no bot', () => {
    expect(insightNeedsBroadcast(n('Jarvis duplicates work', ['b1', 'b2'], 'low'), bots)).toBe(
      false
    );
    expect(insightNeedsBroadcast(n('Jarvis duplicates work', ['b1'], 'high'), bots)).toBe(false);
    expect(insightNeedsBroadcast(n('Two agents duplicate work', ['b1', 'b2'], 'high'), bots)).toBe(
      false
    );
    expect(insightNeedsBroadcast(n('Scoutish words', ['b1', 'b2'], 'high'), bots)).toBe(false);
  });
});

// Changed deliberately on 2026-10-24 (O2, docs/plans/watcher-optimizations-plan.md):
// an agenda-only pass used to run on the heartbeat at most every
// `integrate.agendaEveryMs` (6 h) whatever the agenda held. It now runs when
// the agenda CHANGED since the last agenda pass (a pair or an insight the last
// one was not shown); an unchanged agenda never wakes a pass on its own.
// `agendaEveryMs` stays in the schema, unused.
describe('Integrator: wakes on salience, a changed agenda or the heartbeat (O2)', () => {
  const HOUR = 3_600_000;
  const quietCfg = { heartbeatMs: HOUR, minItems: 5, wakeSalience: 100 };

  /** A second cross-bot related pair, new to the agenda. */
  function newPair(s: ReturnType<typeof setup>) {
    const c = s.graph.addNeuron({
      kind: 'fact',
      text: 'Jarvis tracks the Q3 invoices',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
    });
    const d = s.graph.addNeuron({
      kind: 'fact',
      text: 'Scout tracks the Q3 invoices',
      support: { bots: ['b2'] },
      createdBy: 'watcher',
    });
    return s.graph.addEdge({
      from: c.id,
      to: d.id,
      rel: 'related',
      weight: 0.9,
      createdBy: 'watcher',
    });
  }

  test('an agenda never passed on is a change: due at once, as agenda-changed', () => {
    const s = setup(() => ({ insights: [] }), quietCfg);
    expect(s.integrator.wake()).toBe('agenda-changed');
  });

  test('unchanged agenda: not due, however long; one new pair: due once', async () => {
    const s = setup(() => ({ insights: [] }), quietCfg);
    expect(s.integrator.due()).toBe(true);
    const out = await s.integrator.run({ trigger: 'agenda-changed' });
    expect(out.status).toBe('integrated');
    expect(agendaOf(s.prompts[0] as string)).toContain(`[${s.edge.id}]`);
    t += INTEGRATE_MIN_GAP_MS;
    expect(s.integrator.due()).toBe(false);
    t += 12 * HOUR;
    expect(s.integrator.due()).toBe(false);
    const fresh = newPair(s);
    t += INTEGRATE_MIN_GAP_MS;
    expect(s.integrator.wake()).toBe('agenda-changed');
    await s.integrator.run({ trigger: 'agenda-changed' });
    expect(agendaOf(s.prompts[1] as string)).toContain(`[${fresh.id}]`);
    t += INTEGRATE_MIN_GAP_MS;
    expect(s.integrator.due()).toBe(false);
  });

  test('the salience pending since the last pass reaches wakeSalience: due, as salience', () => {
    const s = setup(() => ({}), { heartbeatMs: HOUR, minItems: 5, wakeSalience: 3, agendaMax: 0 });
    s.integrator.observe(item(1.5));
    expect(s.integrator.due()).toBe(false);
    s.integrator.observe(item(1.5));
    expect(s.integrator.wake()).toBe('salience');
    // The stakes may raise the line (budget pressure doubles it).
    expect(s.integrator.wake({ wakeSalience: 6 })).toBeNull();
  });

  test('the heartbeat stays as a floor: minItems pending after heartbeatMs, as heartbeat', () => {
    const s = setup(() => ({}), { ...quietCfg, minItems: 2, agendaMax: 0 });
    s.integrator.observe(item(0.2));
    s.integrator.observe(item(0.2));
    expect(s.integrator.due()).toBe(false);
    t += HOUR;
    expect(s.integrator.wake()).toBe('heartbeat');
  });

  test('the agenda pass time and the ids it was shown are kept in the state', async () => {
    const s = setup(() => ({ insights: [] }), quietCfg);
    await s.integrator.run();
    expect(s.integrator.state().lastAgendaAt).toBe(new Date(t).toISOString());
    expect(s.integrator.state().agendaIds).toEqual([s.edge.id]);
  });

  test('every pass row records its trigger (manual without one)', async () => {
    const s = setup(() => ({ insights: [] }), quietCfg);
    await s.integrator.run({ trigger: 'agenda-changed' });
    t += INTEGRATE_MIN_GAP_MS;
    await pass(s);
    const passes = s.rows.filter((r) => r.op === 'integrate:pass');
    expect(passes.map((r) => r.trigger)).toEqual(['agenda-changed', 'manual']);
  });

  test('a breaker-refused agenda pass does not use up the change: due again after the min gap', async () => {
    const refused = {
      backend: 'claude-cli',
      model: 'claude-opus-5-5',
      chat: async () => ({ ok: false as const, reason: 'breaker' as const }),
    };
    const s = setup(() => ({}), quietCfg, { client: refused });
    expect(s.integrator.due()).toBe(true);
    expect((await s.integrator.run()).status).toBe('breaker');
    expect(s.integrator.state().lastAgendaAt).toBeUndefined();
    expect(s.integrator.state().agendaIds).toBeUndefined();
    t += INTEGRATE_MIN_GAP_MS;
    expect(s.integrator.due()).toBe(true);
  });

  const agendaSpy = (s: ReturnType<typeof setup>) =>
    spyOn(s.integrator as unknown as { standingAgenda: () => unknown }, 'standingAgenda');

  test('an agenda-only pass computes the standing agenda once: due() carries it into the pass', async () => {
    const s = setup(() => ({ insights: [] }), quietCfg);
    const spy = agendaSpy(s);
    expect(s.integrator.due()).toBe(true);
    expect((await s.integrator.run()).status).toBe('integrated');
    expect(agendaOf(s.prompts[0] as string)).toContain(`[${s.edge.id}]`);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a pass with items pending computes the agenda once', async () => {
    const s = setup(() => ({ insights: [] }));
    const spy = agendaSpy(s);
    expect((await pass(s)).status).toBe('integrated');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('due() scans the graph at most once per minimum gap', () => {
    const s = setup(() => ({ insights: [] }), { ...quietCfg, agendaMax: 0 });
    const spy = agendaSpy(s);
    expect(s.integrator.due()).toBe(false);
    t += 60_000;
    expect(s.integrator.due()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    t += INTEGRATE_MIN_GAP_MS;
    expect(s.integrator.due()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // Changed deliberately (was "idle without computing it"): whether a direct
  // run with nothing pending has anything to do now depends on whether the
  // agenda changed, which takes one scan.
  test('a direct run with nothing pending and an unchanged agenda is idle', async () => {
    const s = setup(() => ({ insights: [] }), quietCfg);
    await s.integrator.run();
    t += INTEGRATE_MIN_GAP_MS;
    const spy = agendaSpy(s);
    expect((await s.integrator.run()).status).toBe('idle');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(s.prompts).toHaveLength(1);
  });

  test('an agenda carried by due() goes stale: a later pass computes its own', async () => {
    const s = setup(() => ({ insights: [] }), quietCfg);
    expect(s.integrator.due()).toBe(true);
    // No run follows that due(); the graph may change before the next pass.
    s.integrator.observe(item());
    t += INTEGRATE_MIN_GAP_MS;
    const spy = agendaSpy(s);
    await s.integrator.run();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('an empty agenda and 2 pending (below minItems): not due', () => {
    const s = setup(() => ({}), { ...quietCfg, agendaMax: 0 });
    s.integrator.observe(item(0.2));
    s.integrator.observe(item(0.2));
    t += HOUR;
    expect(s.integrator.due()).toBe(false);
  });

  test('agendaEveryMs is kept (deprecated, unused) with its 6 h default', () => {
    expect(WATCHER_DEFAULTS.integrate.agendaEveryMs).toBe(6 * HOUR);
  });

  // Review 2026-10-24: with a backlog larger than agendaMax (live ~1,388
  // related links) covering one pair slid an old one into the top ids and
  // every pass woke Opus again. Only an item created (or left unacted) after
  // the last agenda pass is news, and agenda-only passes keep a floor.
  describe('a backlog larger than agendaMax', () => {
    /** `n` more cross-bot related pairs, weights below the setup pair's 0.9. */
    function backlog(
      s: ReturnType<typeof setup>,
      n: number,
      weight = (i: number) => 0.5 + i / 100
    ) {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const c = s.graph.addNeuron({
          kind: 'fact',
          text: `Jarvis backlog fact number ${i} about topic ${i * 7}`,
          support: { bots: ['b1'] },
          createdBy: 'watcher',
        });
        const d = s.graph.addNeuron({
          kind: 'fact',
          text: `Scout backlog fact number ${i} about subject ${i * 11}`,
          support: { bots: ['b2'] },
          createdBy: 'watcher',
        });
        ids.push(
          s.graph.addEdge({
            from: c.id,
            to: d.id,
            rel: 'related',
            weight: weight(i),
            createdBy: 'watcher',
          }).id
        );
      }
      return ids;
    }

    test('covering one pair does not make the next pass due; a pair created later does, once', async () => {
      const covers: string[][] = [];
      const s = setup(() => ({ insights: [], agendaCovered: covers.shift() ?? [] }), {
        ...quietCfg,
        agendaMax: 8,
      });
      backlog(s, 19);
      covers.push([s.edge.id]);
      expect(s.integrator.wake()).toBe('agenda-changed');
      expect((await s.integrator.run({ trigger: 'agenda-changed' })).status).toBe('integrated');
      expect(agendaOf(s.prompts[0] as string)).toContain(`[${s.edge.id}]`);
      for (const step of [INTEGRATE_MIN_GAP_MS, 3 * HOUR, 12 * HOUR]) {
        t += step;
        expect(s.integrator.wake()).toBeNull();
      }
      expect(s.prompts).toHaveLength(1);
      const [fresh] = backlog(s, 1, () => 0.95);
      t += INTEGRATE_MIN_GAP_MS;
      expect(s.integrator.wake()).toBe('agenda-changed');
      await s.integrator.run({ trigger: 'agenda-changed' });
      expect(agendaOf(s.prompts[1] as string)).toContain(`[${fresh}]`);
      t += 3 * HOUR;
      expect(s.integrator.wake()).toBeNull();
    });

    test('agenda-only passes keep a floor (integrate.agendaFloorMs, default 2 h)', async () => {
      expect(WATCHER_DEFAULTS.integrate.agendaFloorMs).toBe(2 * HOUR);
      const s = setup(() => ({ insights: [] }), quietCfg);
      await s.integrator.run({ trigger: 'agenda-changed' });
      t += 30 * 60_000;
      newPair(s);
      t += INTEGRATE_MIN_GAP_MS;
      expect(s.integrator.wake()).toBeNull();
      t += 2 * HOUR;
      expect(s.integrator.wake()).toBe('agenda-changed');
    });

    test('an insight whose broadcast failed after the last agenda pass is news again', async () => {
      const s = setup(() => ({ insights: [] }), { ...quietCfg, agendaMax: 8 });
      await s.integrator.run({ trigger: 'agenda-changed' });
      t += 60_000;
      const insight = s.graph.addNeuron({
        kind: 'insight',
        text: 'Jarvis and Scout both track the Q3 invoices',
        support: { bots: ['b1', 'b2'] },
        confidence: 'medium',
        createdBy: 'watcher',
      });
      t += 3 * HOUR;
      expect(s.integrator.wake()).toBe('agenda-changed');
      await s.integrator.run({ trigger: 'agenda-changed' });
      t += 3 * HOUR;
      expect(s.integrator.wake()).toBeNull();
      // A fast-lane send for it fails later: it became unacted after that pass.
      s.broadcaster.list = () => [
        {
          id: 'bc-1',
          botId: 'b1',
          kind: 'directive',
          text: 'x',
          insightId: insight.id,
          reason: 'x',
          createdAt: new Date(t).toISOString(),
          deliveryError: 'chat not found',
        } as never,
      ];
      t += 3 * HOUR;
      expect(s.integrator.wake()).toBe('agenda-changed');
    });
  });
});

// O3 (stakes): what the watcher feels shapes what it does.
describe('Integrator: stakes shape the pass (O3)', () => {
  function withQuestions(reply: Reply, sent: string[], deferNext = { value: false }) {
    const qlog = new WatcherLog(join(dir, 'qlog'), { now: () => t });
    const broadcaster = new Broadcaster({
      dir,
      now: () => t,
      log: qlog,
      delivery: {
        question: async (bot, text) => {
          if (deferNext.value) return { ok: false, detail: 'throttled', deferred: true };
          sent.push(`${bot}:${text}`);
          return { ok: true, detail: 'sent' };
        },
      },
    });
    return setup(reply, {}, { broadcaster });
  }
  const askAnswer = (s: () => ReturnType<typeof setup>) => () => ({
    insights: [{ text: DUP, support: [s().a.id, s().b.id], confidence: 'high' }],
    broadcasts: [{ bot: 'b1', kind: 'question', text: 'Who owns the brief?', insightIndex: 0 }],
  });

  test('operator silent: a question is deferred, logged, and its insight stays on the agenda', async () => {
    const sent: string[] = [];
    const ref: { s?: ReturnType<typeof setup> } = {};
    const s = withQuestions(
      askAnswer(() => ref.s as ReturnType<typeof setup>),
      sent
    );
    ref.s = s;
    s.integrator.observe(item());
    const out = await s.integrator.run({ deferQuestions: true, drivenBy: ['operatorSilence'] });
    expect(out.status).toBe('integrated');
    expect(sent).toEqual([]);
    const row = s.rows.find((r) => r.op === 'integrate:question-deferred');
    expect(row?.whyNoBroadcast).toBe('operator silent');
    expect(row?.drivenBy).toEqual(['operatorSilence']);
    const insight = s.graph.list().find((n) => n.kind === 'insight') as Neuron;
    expect(insight.meta?.whyNoBroadcast).toBeUndefined();
    expect(s.integrator.deferredQuestions().map((q) => q.insightId)).toEqual([insight.id]);
    expect(s.rows.find((r) => r.op === 'integrate:pass')?.drivenBy).toContain('operatorSilence');
    // Still on the agenda for the next pass.
    t += INTEGRATE_MIN_GAP_MS;
    s.integrator.observe(item());
    await s.integrator.run();
    expect(agendaOf(s.prompts[1] as string)).toContain(`[${insight.id}]`);
  });

  test('the operator writes: the deferred question goes out at once, without a pass', async () => {
    const sent: string[] = [];
    const ref: { s?: ReturnType<typeof setup> } = {};
    const s = withQuestions(
      askAnswer(() => ref.s as ReturnType<typeof setup>),
      sent
    );
    ref.s = s;
    s.integrator.observe(item());
    await s.integrator.run({ deferQuestions: true });
    const results = await s.integrator.releaseQuestions();
    expect(results.map((r) => r.status)).toEqual(['delivered']);
    expect(sent).toEqual(['b1:Who owns the brief?']);
    expect(s.integrator.deferredQuestions()).toEqual([]);
    expect(s.prompts).toHaveLength(1);
    const row = s.rows.find((r) => r.op === 'integrate:question-released');
    expect(row?.drivenBy).toEqual(['operatorPresent']);
  });

  test('a released question the throttle defers again stays deferred', async () => {
    const sent: string[] = [];
    const deferNext = { value: false };
    const ref: { s?: ReturnType<typeof setup> } = {};
    const s = withQuestions(
      askAnswer(() => ref.s as ReturnType<typeof setup>),
      sent,
      deferNext
    );
    ref.s = s;
    s.integrator.observe(item());
    await s.integrator.run({ deferQuestions: true });
    deferNext.value = true;
    expect((await s.integrator.releaseQuestions()).map((r) => r.status)).toEqual(['deferred']);
    expect(s.integrator.deferredQuestions()).toHaveLength(1);
  });

  // Review 2026-10-24: a held question dropped by age or by the cap left no trace.
  test('a held question older than 7 days is dropped unsent, with a row', async () => {
    const sent: string[] = [];
    const ref: { s?: ReturnType<typeof setup> } = {};
    const s = withQuestions(
      askAnswer(() => ref.s as ReturnType<typeof setup>),
      sent
    );
    ref.s = s;
    s.integrator.observe(item());
    await s.integrator.run({ deferQuestions: true });
    t += DEFERRED_QUESTION_MAX_AGE_MS + 1;
    expect(await s.integrator.releaseQuestions()).toEqual([]);
    expect(sent).toEqual([]);
    expect(s.integrator.deferredQuestions()).toEqual([]);
    const row = s.rows.find((r) => r.op === 'integrate:question-dropped');
    expect(row?.text).toContain('Who owns the brief?');
    expect(row?.whyNoBroadcast).toBe('held over 7 days');
  });

  test('a held question pushed out by the cap is dropped with a row', async () => {
    const old = Array.from({ length: DEFERRED_QUESTIONS_MAX }, (_, i) => ({
      insightId: `n-old0000${i}`,
      botId: 'b2',
      text: `Old question ${i}?`,
      reason: 'x',
      deferredAt: new Date(t - 60_000).toISOString(),
    }));
    writeFileSync(
      integrateStateFile(dir),
      JSON.stringify({
        attending: [],
        pending: { items: [], neurons: [], salience: 0 },
        deferredQuestions: old,
      })
    );
    const sent: string[] = [];
    const ref: { s?: ReturnType<typeof setup> } = {};
    const s = withQuestions(
      askAnswer(() => ref.s as ReturnType<typeof setup>),
      sent
    );
    ref.s = s;
    s.integrator.observe(item());
    await s.integrator.run({ deferQuestions: true });
    expect(s.integrator.deferredQuestions()).toHaveLength(DEFERRED_QUESTIONS_MAX);
    expect(s.integrator.deferredQuestions().map((q) => q.text)).not.toContain('Old question 0?');
    const row = s.rows.find((r) => r.op === 'integrate:question-dropped');
    expect(row?.text).toContain('Old question 0?');
    expect(row?.whyNoBroadcast).toBe(`more than ${DEFERRED_QUESTIONS_MAX} held`);
  });

  test('without deferral a question goes out in the pass', async () => {
    const sent: string[] = [];
    const ref: { s?: ReturnType<typeof setup> } = {};
    const s = withQuestions(
      askAnswer(() => ref.s as ReturnType<typeof setup>),
      sent
    );
    ref.s = s;
    s.integrator.observe(item());
    await s.integrator.run();
    expect(sent).toEqual(['b1:Who owns the brief?']);
    expect(s.integrator.deferredQuestions()).toEqual([]);
  });

  test('fleet karma falling: the prompt opens with "Something is wrong"', async () => {
    const s = setup(() => ({ insights: [] }));
    s.integrator.observe(item());
    await s.integrator.run({
      somethingWrong: 'Fleet karma fell from 60 to 52 in 24 h.',
      drivenBy: ['fleetKarmaFalling'],
    });
    expect(s.prompts[0]).toContain(
      '## Something is wrong\nFleet karma fell from 60 to 52 in 24 h.'
    );
    expect(s.rows.find((r) => r.op === 'integrate:pass')?.drivenBy).toEqual(['fleetKarmaFalling']);
    expect(s.integrator.drivenBy()).toEqual(['fleetKarmaFalling']);
  });
});

describe('Integrator: a broadcast and a "no broadcast" for the same insight', () => {
  const existingInsight = (s: ReturnType<typeof setup>, text = DUP) =>
    s.graph.addNeuron({
      kind: 'insight',
      text,
      support: { bots: ['b1', 'b2'] },
      createdBy: 'watcher',
      confidence: 'medium',
    });

  test('a recognised insight with a proposed broadcast does not keep its whyNoBroadcast', async () => {
    const ref: { s?: ReturnType<typeof setup> } = {};
    const s = setup(() => ({
      insights: [
        {
          text: DUP,
          support: [ref.s?.a.id, ref.s?.b.id],
          confidence: 'medium',
          whyNoBroadcast: 'Nobody needs to hear it',
        },
      ],
      broadcasts: [{ bot: 'b2', kind: 'directive', text: 'Stop the brief', insightIndex: 0 }],
    }));
    ref.s = s;
    const existing = existingInsight(s);
    await pass(s);
    expect(s.delivered).toEqual(['directive:b2:Stop the brief']);
    expect(s.graph.get(existing.id)?.meta?.whyNoBroadcast).toBeUndefined();
    const row = s.rows.find((r) => r.op === 'integrate:recognised');
    expect(row?.whyNoBroadcast).toBeUndefined();
  });

  test('a recognised insight broadcast by insightId does not keep its whyNoBroadcast either', async () => {
    const ref: { s?: ReturnType<typeof setup>; existing?: Neuron } = {};
    const s = setup(() => ({
      insights: [
        { text: DUP, support: [ref.s?.a.id, ref.s?.b.id], whyNoBroadcast: 'Nobody needs it' },
      ],
      broadcasts: [{ bot: 'b1', kind: 'wake', text: '', insightId: ref.existing?.id }],
    }));
    ref.s = s;
    ref.existing = existingInsight(s);
    await pass(s);
    expect(s.delivered).toEqual(['wake:b1']);
    expect(s.graph.get(ref.existing.id)?.meta?.whyNoBroadcast).toBeUndefined();
  });

  test('a broadcast that is never sent (unknown bot, bad kind) does not drop the whyNoBroadcast', async () => {
    const ref: { s?: ReturnType<typeof setup>; existing?: Neuron } = {};
    const s = setup(() => ({
      insights: [
        { text: DUP, support: [ref.s?.a.id, ref.s?.b.id], whyNoBroadcast: 'Nobody needs it' },
      ],
      broadcasts: [
        { bot: 'b9', kind: 'wake', text: '', insightId: ref.existing?.id },
        { bot: 'b1', kind: 'shout', text: 'x', insightIndex: 0 },
      ],
    }));
    ref.s = s;
    ref.existing = existingInsight(s);
    await pass(s);
    expect(s.delivered).toEqual([]);
    expect(s.graph.get(ref.existing.id)?.meta?.whyNoBroadcast).toBe('Nobody needs it');
    const row = s.rows.find((r) => r.op === 'integrate:recognised');
    expect(row?.whyNoBroadcast).toBe('Nobody needs it');
  });

  test('noBroadcast for an insight broadcast in the same pass is skipped (broadcast wins), logged once', async () => {
    const ref: { one?: Neuron; two?: Neuron } = {};
    const s = setup(() => ({
      noBroadcast: [
        { insightId: ref.one?.id, why: 'The operator already chose' },
        { insightId: ref.two?.id, why: 'Too early' },
      ],
      broadcasts: [
        { bot: 'b1', kind: 'wake', text: '', insightId: ref.one?.id },
        { bot: 'b2', kind: 'wake', text: '', insightId: ref.two?.id },
      ],
    }));
    ref.one = existingInsight(s);
    ref.two = existingInsight(s, 'Scout and Jarvis duplicate the recruiting pilot');
    await pass(s);
    expect(s.delivered).toEqual(['wake:b1', 'wake:b2']);
    expect(s.graph.get(ref.one.id)?.meta?.whyNoBroadcast).toBeUndefined();
    expect(s.graph.get(ref.two.id)?.meta?.whyNoBroadcast).toBeUndefined();
    expect(s.rows.filter((r) => r.op === 'integrate:no-broadcast')).toHaveLength(0);
    expect(s.warns.filter((m) => m.includes('noBroadcast'))).toHaveLength(1);
  });

  test('a broadcast that cannot be sent (unknown bot) does not cancel the noBroadcast', async () => {
    const ref: { one?: Neuron } = {};
    const s = setup(() => ({
      noBroadcast: [{ insightId: ref.one?.id, why: 'The operator already chose' }],
      broadcasts: [{ bot: 'nope', kind: 'wake', text: '', insightId: ref.one?.id }],
    }));
    ref.one = existingInsight(s);
    await pass(s);
    expect(s.graph.get(ref.one.id)?.meta?.whyNoBroadcast).toBe('The operator already chose');
    expect(s.warns.filter((m) => m.includes('noBroadcast'))).toHaveLength(0);
  });
});

describe('Integrator: a broadcast record left open by a dead process', () => {
  const openRecord = (insightId: string, ageMs: number) => ({
    id: 'b-00000aaa',
    botId: 'b1',
    kind: 'wake' as const,
    text: '',
    insightId,
    createdAt: new Date(t - ageMs).toISOString(),
  });
  const withRecords = (records: () => unknown[]) => ({
    broadcaster: { send: async () => ({ status: 'invalid' as const }), list: records },
  });
  const myInsightsOf = (prompt: string) =>
    prompt.split('## My last insights')[1]?.split('\n## ')[0] ?? '';
  const waiting = (s: ReturnType<typeof setup>) =>
    s.graph.addNeuron({
      kind: 'insight',
      text: 'Two Monday briefs overlap',
      support: { bots: ['b1', 'b2'] },
      createdBy: 'watcher',
      confidence: 'medium',
    });

  test('an open record older than BROADCAST_INFLIGHT_MAX_MS counts as failed: back on the agenda', async () => {
    const ref: { existing?: Neuron } = {};
    const age = BROADCAST_INFLIGHT_MAX_MS + 60_000;
    const s = setup(
      () => ({}),
      {},
      withRecords(() => [openRecord(ref.existing?.id ?? '', age)])
    );
    ref.existing = waiting(s);
    await pass(s);
    expect(agendaOf(s.prompts[0] as string)).toContain(`[${ref.existing.id}]`);
    expect(myInsightsOf(s.prompts[0] as string)).toContain('wake to Jarvis (failed)');
  });

  test('an open record younger than that is still in flight: off the agenda', async () => {
    const ref: { existing?: Neuron } = {};
    const s = setup(
      () => ({}),
      {},
      withRecords(() => [openRecord(ref.existing?.id ?? '', 60_000)])
    );
    ref.existing = waiting(s);
    await pass(s);
    expect(agendaOf(s.prompts[0] as string)).not.toContain(`[${ref.existing.id}]`);
    expect(myInsightsOf(s.prompts[0] as string)).toContain('wake to Jarvis (in flight)');
  });
});

describe('Integrator: agendaCovered retires an insight only once it acted (review 2026-10-24)', () => {
  function covering(
    broadcast: Record<string, unknown> | undefined,
    deps: Record<string, unknown> = {},
    extra: (id: string) => Record<string, unknown> = () => ({})
  ) {
    const ref: { existing?: Neuron; first: boolean } = { first: true };
    const s = setup(
      () => {
        const id = ref.existing?.id as string;
        const o = ref.first
          ? {
              ...(broadcast ? { broadcasts: [{ ...broadcast, insightId: id }] } : {}),
              agendaCovered: [id],
              ...extra(id),
            }
          : {};
        ref.first = false;
        return o;
      },
      {},
      deps
    );
    ref.existing = s.graph.addNeuron({
      kind: 'insight',
      text: 'Jarvis and Scout both write the Monday brief',
      support: { bots: ['b1', 'b2'] },
      createdBy: 'watcher',
      confidence: 'high',
    });
    return { s, id: ref.existing.id };
  }

  async function twoPasses(s: ReturnType<typeof setup>) {
    const out = await pass(s);
    t += INTEGRATE_MIN_GAP_MS;
    await pass(s);
    return out;
  }

  test('delivered: the insight leaves the agenda', async () => {
    const { s, id } = covering({ bot: 'b1', kind: 'wake', text: '' });
    const out = await twoPasses(s);
    expect(out.status === 'integrated' && out.broadcasts.map((b) => b.status)).toEqual([
      'delivered',
    ]);
    expect(s.integrator.state().agendaCovered).toEqual([id]);
    expect(agendaOf(s.prompts[1] as string)).not.toContain(id);
  });

  test('deferred: the insight stays on the agenda for a retry', async () => {
    const log = new WatcherLog(join(dir, 'log2'), { now: () => t });
    const broadcaster = new Broadcaster({
      dir: join(dir, 'b2'),
      now: () => t,
      log,
      delivery: { question: async () => ({ ok: false, detail: 'cooldown', deferred: true }) },
    });
    const { s, id } = covering(
      { bot: 'b1', kind: 'question', text: 'Which brief?' },
      { broadcaster }
    );
    const out = await twoPasses(s);
    expect(out.status === 'integrated' && out.broadcasts.map((b) => b.status)).toEqual([
      'deferred',
    ]);
    expect(s.integrator.state().agendaCovered ?? []).not.toContain(id);
    expect(agendaOf(s.prompts[1] as string)).toContain(`[${id}]`);
  });

  test('failed: the insight stays on the agenda for a retry', async () => {
    // Goals are not wired in setup's broadcaster: the delivery fails.
    const { s, id } = covering({ bot: 'b1', kind: 'goal', text: 'Merge the briefs' });
    const out = await twoPasses(s);
    expect(out.status === 'integrated' && out.broadcasts.map((b) => b.status)).toEqual(['failed']);
    expect(s.integrator.state().agendaCovered ?? []).not.toContain(id);
    expect(agendaOf(s.prompts[1] as string)).toContain(`[${id}]`);
  });

  test('capped: the insight stays on the agenda for a retry', async () => {
    const { s, id } = covering({ bot: 'b1', kind: 'wake', text: '' });
    for (let i = 0; i < 3; i++) {
      await s.broadcaster.send({ botId: 'b1', kind: 'wake', text: '', insightId: `n-other00${i}` });
    }
    const out = await pass(s);
    expect(out.status === 'integrated' && out.broadcasts.map((b) => b.status)).toEqual(['capped']);
    expect(s.integrator.state().agendaCovered ?? []).not.toContain(id);
  });

  test('a whyNoBroadcast retires it without a broadcast', async () => {
    const withWhy = covering(undefined, {}, (id) => ({
      noBroadcast: [{ insightId: id, why: 'The operator already chose' }],
    }));
    await twoPasses(withWhy.s);
    expect(withWhy.s.integrator.state().agendaCovered).toEqual([withWhy.id]);
    expect(agendaOf(withWhy.s.prompts[1] as string)).not.toContain(withWhy.id);
  });

  test('covered with neither a broadcast nor a whyNoBroadcast stays on the agenda', async () => {
    const bare = covering(undefined);
    await twoPasses(bare.s);
    expect(bare.s.integrator.state().agendaCovered ?? []).not.toContain(bare.id);
    expect(agendaOf(bare.s.prompts[1] as string)).toContain(`[${bare.id}]`);
  });

  test('an edge on the agenda is still retired by agendaCovered alone', async () => {
    const ref: { s?: ReturnType<typeof setup> } = {};
    const s = setup(() => ({ agendaCovered: [ref.s?.edge.id] }));
    ref.s = s;
    await pass(s);
    expect(s.integrator.state().agendaCovered).toEqual([s.edge.id]);
  });
});

describe('Integrator: a recognised insight with a stale whyNoBroadcast (gap 2026-10-24)', () => {
  // The insight already carries a reason from an earlier pass; this pass
  // recognises it and proposes a broadcast. The old reason must not keep it
  // off the agenda when that broadcast does not land.
  function stale(broadcast: Record<string, unknown>) {
    const ref: { s?: ReturnType<typeof setup>; first: boolean } = { first: true };
    const s = setup(() => {
      if (!ref.first) return {};
      ref.first = false;
      return {
        insights: [{ text: DUP, support: [ref.s?.a.id, ref.s?.b.id], confidence: 'medium' }],
        broadcasts: [{ ...broadcast, insightIndex: 0 }],
      };
    });
    ref.s = s;
    const existing = s.graph.addNeuron({
      kind: 'insight',
      text: DUP,
      support: { bots: ['b1', 'b2'] },
      createdBy: 'watcher',
      confidence: 'medium',
      meta: { whyNoBroadcast: 'Nobody needed it last week' },
    });
    return { s, id: existing.id };
  }

  test('a failed broadcast puts it back on the standing agenda', async () => {
    // Goals are not wired in setup's broadcaster: the delivery fails.
    const { s, id } = stale({ bot: 'b1', kind: 'goal', text: 'Merge the briefs' });
    const out = await pass(s);
    expect(out.status === 'integrated' && out.broadcasts.map((b) => b.status)).toEqual(['failed']);
    expect(s.graph.get(id)?.meta?.whyNoBroadcast).toBeUndefined();
    t += INTEGRATE_MIN_GAP_MS;
    await pass(s);
    expect(agendaOf(s.prompts[1] as string)).toContain(`[${id}]`);
  });

  test('a delivered broadcast retires it', async () => {
    const { s, id } = stale({ bot: 'b1', kind: 'wake', text: '' });
    const out = await pass(s);
    expect(out.status === 'integrated' && out.broadcasts.map((b) => b.status)).toEqual([
      'delivered',
    ]);
    expect(s.graph.get(id)?.meta?.whyNoBroadcast).toBeUndefined();
    t += INTEGRATE_MIN_GAP_MS;
    await pass(s);
    expect(agendaOf(s.prompts[1] as string)).not.toContain(id);
  });
});

describe('Integrator: an insight retired by a reason, then broadcast (gap 2026-10-24)', () => {
  // Pass 1 covers the agenda insight with a `noBroadcast`: retired, its id in
  // `agendaCovered`. Pass 2 recognises it and proposes a broadcast, which
  // clears the reason. The covered id must go with it, or a broadcast that
  // does not land leaves the insight off the agenda for good.
  function retiredThenBroadcast(broadcast: Record<string, unknown>) {
    const ref: { s?: ReturnType<typeof setup>; existing?: Neuron; n: number } = { n: 0 };
    const s = setup(() => {
      const id = ref.existing?.id as string;
      ref.n += 1;
      if (ref.n === 1) {
        return {
          agendaCovered: [id],
          noBroadcast: [{ insightId: id, why: 'Nobody needed it last week' }],
        };
      }
      if (ref.n === 2) {
        return {
          insights: [{ text: DUP, support: [ref.s?.a.id, ref.s?.b.id], confidence: 'high' }],
          broadcasts: [{ ...broadcast, insightIndex: 0 }],
        };
      }
      return {};
    });
    ref.s = s;
    ref.existing = s.graph.addNeuron({
      kind: 'insight',
      text: DUP,
      support: { bots: ['b1', 'b2'] },
      createdBy: 'watcher',
      confidence: 'high',
    });
    return { s, id: ref.existing.id };
  }

  async function firstTwoPasses(s: ReturnType<typeof setup>, id: string) {
    await pass(s);
    expect(s.integrator.state().agendaCovered).toEqual([id]);
    t += INTEGRATE_MIN_GAP_MS;
    const out = await pass(s);
    t += INTEGRATE_MIN_GAP_MS;
    return out;
  }

  test('a failed broadcast puts it back on the following agenda', async () => {
    // Goals are not wired in setup's broadcaster: the delivery fails.
    const { s, id } = retiredThenBroadcast({ bot: 'b1', kind: 'goal', text: 'Merge the briefs' });
    const out = await firstTwoPasses(s, id);
    expect(out.status === 'integrated' && out.broadcasts.map((b) => b.status)).toEqual(['failed']);
    expect(s.graph.get(id)?.meta?.whyNoBroadcast).toBeUndefined();
    expect(s.integrator.state().agendaCovered ?? []).not.toContain(id);
    await pass(s);
    expect(agendaOf(s.prompts[2] as string)).toContain(`[${id}]`);
  });

  test('a delivered broadcast retires it again', async () => {
    const { s, id } = retiredThenBroadcast({ bot: 'b1', kind: 'wake', text: '' });
    const out = await firstTwoPasses(s, id);
    expect(out.status === 'integrated' && out.broadcasts.map((b) => b.status)).toEqual([
      'delivered',
    ]);
    expect(s.integrator.state().agendaCovered).toEqual([id]);
    await pass(s);
    expect(agendaOf(s.prompts[2] as string)).not.toContain(id);
  });
});
