/**
 * Integrate must act (2026-10-24): after four Opus passes the watcher had two
 * cross-bot insights and zero broadcasts, while the graph held two bots
 * writing the same Monday brief. Criteria in the prompt, a standing agenda of
 * cross-bot knowledge and insights still waiting, broadcasts from existing
 * insights by id, and a `whyNoBroadcast` on every insight that should have
 * acted and did not.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMClient } from '../../src/core/llm-client';
import { Broadcaster } from '../../src/watcher/broadcast';
import { DailyBudget } from '../../src/watcher/budget';
import { Graph } from '../../src/watcher/graph';
import {
  INTEGRATE_MIN_GAP_MS,
  Integrator,
  insightNeedsBroadcast,
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

function setup(reply: Reply = () => ({}), cfg: Partial<WatcherConfig['integrate']> = {}) {
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
    integrate: { ...WATCHER_DEFAULTS.integrate, enabled: true, salienceBar: 1, ...cfg },
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
    logger: quiet,
  });
  return { graph, rows, prompts, delivered, broadcaster, integrator, a, b, edge };
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
