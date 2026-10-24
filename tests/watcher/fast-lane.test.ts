import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BroadcastDelivery, Broadcaster } from '../../src/watcher/broadcast';
import {
  FAST_LANE_DEFAULTS,
  type FastLaneDeps,
  fastLaneCandidates,
  fastLaneTargets,
  runFastLane,
} from '../../src/watcher/fast-lane';
import { Graph } from '../../src/watcher/graph';
import { WatcherLog } from '../../src/watcher/log';
import { buildIntegratePrompt } from '../../src/watcher/prompts';
import {
  type Neuron,
  OPERATOR_MESSAGE,
  OPERATOR_SOURCED,
  type WatcherLogRow,
} from '../../src/watcher/types';

let dir: string;
let t: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-fast-lane-'));
  t = Date.parse('2026-10-24T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NAMES: Record<string, string> = {
  finny: 'Finny',
  perf: 'AI Perfectionist',
  scout: 'Scout',
  jarvis: 'Jarvis',
  acme: 'Acme',
};

function world() {
  const graph = new Graph(join(dir, 'graph'), { now: () => t });
  graph.load();
  const bot = (id: string) =>
    graph.addNeuron({
      kind: 'entity',
      text: NAMES[id] ?? id,
      support: { bots: [id] },
      createdBy: 'watcher',
      meta: { key: `bot:${id}` },
    });
  for (const id of Object.keys(NAMES)) bot(id);
  const pattern = graph.addNeuron({
    kind: 'pattern',
    text: 'web_fetch is blocked by Cloudflare on thelancet.com and medium.com',
    support: { bots: ['finny', 'perf'] },
    createdBy: 'watcher',
    confidence: 'medium',
  });
  // Scout researches medical papers: a neuron of Scout's related to the pattern.
  const scoutTopic = graph.addNeuron({
    kind: 'topic',
    text: 'medical paper research',
    support: { bots: ['scout'] },
    createdBy: 'bot:scout',
  });
  graph.addEdge({
    from: pattern.id,
    to: scoutTopic.id,
    rel: 'related',
    weight: 0.85,
    createdBy: 'watcher',
  });
  // The tenant bot has a related neuron too: it must still get nothing.
  const acmeTopic = graph.addNeuron({
    kind: 'topic',
    text: 'medical sources',
    support: { bots: ['acme'] },
    createdBy: 'bot:acme',
  });
  graph.addEdge({
    from: pattern.id,
    to: acmeTopic.id,
    rel: 'related',
    weight: 0.85,
    createdBy: 'watcher',
  });
  return { graph, pattern };
}

function deps(
  graph: Graph,
  overrides: Partial<FastLaneDeps> = {},
  delivery: BroadcastDelivery = {}
) {
  const directives: Array<{ botId: string; text: string }> = [];
  const rows: WatcherLogRow[] = [];
  const log = new WatcherLog(join(dir, 'log'), { now: () => t, onRow: (r) => rows.push(r) });
  const broadcaster = new Broadcaster({
    dir,
    now: () => t,
    log,
    botName: (id) => NAMES[id] ?? id,
    isTenantBot: (id) => id === 'acme',
    delivery: {
      directive: (botId, text) => {
        directives.push({ botId, text });
      },
      ...delivery,
    },
  });
  const d: FastLaneDeps = {
    graph,
    broadcaster,
    log,
    config: () => FAST_LANE_DEFAULTS,
    // The eligible targets: enabled, not a tenant's (acme is filtered here and by the broadcaster).
    bots: () => ['finny', 'perf', 'scout', 'jarvis'],
    botName: (id) => NAMES[id] ?? id,
    now: () => t,
    state: {},
    ...overrides,
  };
  return { d, directives, rows, broadcaster };
}

describe('fastLaneCandidates', () => {
  const n = (over: Partial<Neuron>): Neuron =>
    ({
      id: 'n-00000001',
      kind: 'pattern',
      text: 'x fails',
      support: { bots: ['a', 'b'] },
      createdBy: 'watcher',
      createdAt: '',
      lastActivatedAt: '',
      activations: 1,
      ...over,
    }) as Neuron;

  test('a pattern two bots support is a candidate', () => {
    expect(fastLaneCandidates([n({})], FAST_LANE_DEFAULTS)).toEqual([
      { neuronId: 'n-00000001', bots: ['a', 'b'], text: 'x fails' },
    ]);
  });

  test('a fact at high confidence two bots support is a candidate; at medium it is not', () => {
    expect(
      fastLaneCandidates([n({ kind: 'fact', confidence: 'high' })], FAST_LANE_DEFAULTS)
    ).toHaveLength(1);
    expect(
      fastLaneCandidates([n({ kind: 'fact', confidence: 'medium' })], FAST_LANE_DEFAULTS)
    ).toEqual([]);
  });

  test('one supporting bot, another kind, an archived neuron or the lane off: nothing', () => {
    expect(fastLaneCandidates([n({ support: { bots: ['a', 'a'] } })], FAST_LANE_DEFAULTS)).toEqual(
      []
    );
    expect(fastLaneCandidates([n({ kind: 'topic' })], FAST_LANE_DEFAULTS)).toEqual([]);
    expect(fastLaneCandidates([n({ archivedAt: 'x' })], FAST_LANE_DEFAULTS)).toEqual([]);
    expect(fastLaneCandidates([n({})], { ...FAST_LANE_DEFAULTS, enabled: false })).toEqual([]);
    expect(fastLaneCandidates([n({})], { ...FAST_LANE_DEFAULTS, minBots: 3 })).toEqual([]);
  });

  // Review 2026-10-24 (privacy): the directive quotes the neuron text
  // verbatim, and a fact may be the operator's own words.
  test('anything an operator message supports never goes out, pattern or fact', () => {
    const fromOperator = { [OPERATOR_MESSAGE]: 'true' };
    expect(fastLaneCandidates([n({ meta: fromOperator })], FAST_LANE_DEFAULTS)).toEqual([]);
    expect(
      fastLaneCandidates(
        [n({ kind: 'fact', confidence: 'high', meta: fromOperator })],
        FAST_LANE_DEFAULTS
      )
    ).toEqual([]);
  });

  test('an operatorSourced fact never goes out; a notice pattern with an explicit operatorMessage false does', () => {
    const sourced = { [OPERATOR_SOURCED]: 'true' };
    expect(
      fastLaneCandidates(
        [n({ kind: 'fact', confidence: 'high', meta: sourced })],
        FAST_LANE_DEFAULTS
      )
    ).toEqual([]);
    const clean = { ...sourced, source: 'notice', [OPERATOR_MESSAGE]: 'false' };
    expect(fastLaneCandidates([n({ meta: clean })], FAST_LANE_DEFAULTS)).toHaveLength(1);
    expect(
      fastLaneCandidates([n({ kind: 'fact', confidence: 'high', meta: clean })], FAST_LANE_DEFAULTS)
    ).toEqual([]);
  });

  // Review 2026-10-24: the live graph predates `operatorMessage`. An
  // operator-sourced pattern without the flag may rest on an operator
  // message: a missing flag counts as one.
  test('a legacy operatorSourced pattern without the operatorMessage flag is skipped', () => {
    expect(
      fastLaneCandidates([n({ meta: { [OPERATOR_SOURCED]: 'true' } })], FAST_LANE_DEFAULTS)
    ).toEqual([]);
    expect(
      fastLaneCandidates(
        [n({ meta: { [OPERATOR_SOURCED]: 'true', source: 'notice' } })],
        FAST_LANE_DEFAULTS
      )
    ).toEqual([]);
    // An explicit false from a writer other than notice is not trusted either.
    expect(
      fastLaneCandidates(
        [
          n({
            meta: { [OPERATOR_SOURCED]: 'true', source: 'integrate', [OPERATOR_MESSAGE]: 'false' },
          }),
        ],
        FAST_LANE_DEFAULTS
      )
    ).toEqual([]);
  });
});

describe('fastLaneTargets', () => {
  test('a third bot with a related neuron is a target; the supporting bots and unrelated bots are not', () => {
    const { graph, pattern } = world();
    const [c] = fastLaneCandidates([pattern], FAST_LANE_DEFAULTS);
    const targets = fastLaneTargets(c, { graph, bots: ['finny', 'perf', 'scout', 'jarvis'] });
    expect(targets.map((x) => x.botId)).toEqual(['scout']);
    expect(targets[0].via).toBe('related');
  });

  test('a bot that used the tool the pattern names in the last 7 days is a target', () => {
    const { graph, pattern } = world();
    const [c] = fastLaneCandidates([pattern], FAST_LANE_DEFAULTS);
    const targets = fastLaneTargets(c, {
      graph,
      bots: ['finny', 'perf', 'scout', 'jarvis'],
      toolsUsed: (botId) => (botId === 'jarvis' ? ['web_fetch', 'file_write'] : ['exec']),
    });
    expect(targets.map((x) => `${x.botId}:${x.via}`)).toEqual(['scout:related', 'jarvis:tool']);
    expect(targets[1].ref).toBe('web_fetch');
  });

  test('a tool name only matches as a whole word', () => {
    const { graph, pattern } = world();
    const [c] = fastLaneCandidates([pattern], FAST_LANE_DEFAULTS);
    const targets = fastLaneTargets(c, {
      graph,
      bots: ['jarvis'],
      toolsUsed: () => ['fetch', 'web'],
    });
    expect(targets).toEqual([]);
  });
});

describe('runFastLane', () => {
  test('one directive per related third bot, none to the supporting bots, none to tenant bots', async () => {
    const { graph, pattern } = world();
    const { d, directives, rows, broadcaster } = deps(graph, {
      bots: () => ['finny', 'perf', 'scout', 'jarvis', 'acme'],
    });
    const out = await runFastLane(d, [pattern]);
    expect(directives.map((x) => x.botId)).toEqual(['scout']);
    expect(directives[0].text).toContain('web_fetch is blocked by Cloudflare');
    expect(directives[0].text).toContain('Finny');
    expect(directives[0].text).toContain('AI Perfectionist');
    const sent = broadcaster.list();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      botId: 'scout',
      kind: 'directive',
      insightId: pattern.id,
      source: 'fast-lane',
    });
    expect(out).toEqual([{ neuronId: pattern.id, sent: ['scout'] }]);
    const row = rows.find((r) => r.op === 'broadcast:fast-lane');
    expect(row).toBeDefined();
    expect(row?.text).toContain('Scout');
    expect(row?.text).toContain('Finny');
    expect(row?.neuronIds).toEqual([pattern.id]);
  });

  // Review 2026-10-24: one notice pass creates the pattern from finny and
  // perf, then recognises it from scout. The `created` snapshot still says
  // finny + perf; scout now supports it and must not be told its own lesson.
  test('reads the current support at send time, never the pass snapshot', async () => {
    const { graph, pattern } = world();
    const snapshot = graph.get(pattern.id) as Neuron;
    const frozen = {
      ...snapshot,
      support: { ...snapshot.support, bots: [...snapshot.support.bots] },
    };
    graph.addSupport(pattern.id, { bots: ['scout'] });
    const { d, directives } = deps(graph, {
      toolsUsed: (botId) => (botId === 'jarvis' ? ['web_fetch'] : []),
    });
    const out = await runFastLane(d, [frozen]);
    expect(directives.map((x) => x.botId)).toEqual(['jarvis']);
    expect(directives[0].text).toContain('Scout');
    expect(out).toEqual([{ neuronId: pattern.id, sent: ['jarvis'] }]);
  });

  test('two third bots each get their own directive (one per bot, not one per pattern)', async () => {
    const { graph, pattern } = world();
    const { d, directives } = deps(graph, {
      toolsUsed: (botId) => (botId === 'jarvis' ? ['web_fetch'] : []),
    });
    await runFastLane(d, [pattern]);
    expect(directives.map((x) => x.botId)).toEqual(['scout', 'jarvis']);
    // The same pattern noticed again sends nothing more.
    await runFastLane(d, [pattern]);
    expect(directives).toHaveLength(2);
  });

  test('never a question nor a goal', async () => {
    const { graph, pattern } = world();
    const asked: string[] = [];
    const { d, broadcaster } = deps(
      graph,
      {},
      {
        question: async (b) => {
          asked.push(b);
          return { ok: true, detail: '' };
        },
        goal: (b) => {
          asked.push(b);
        },
      }
    );
    await runFastLane(d, [pattern]);
    expect(asked).toEqual([]);
    expect(broadcaster.list().every((b) => b.kind === 'directive')).toBe(true);
  });

  test('a bot with no relation gets nothing', async () => {
    const { graph, pattern } = world();
    const { d, directives, rows } = deps(graph, { bots: () => ['finny', 'perf', 'jarvis'] });
    expect(await runFastLane(d, [pattern])).toEqual([]);
    expect(directives).toEqual([]);
    expect(rows.some((r) => r.op === 'broadcast:fast-lane')).toBe(false);
  });

  test('a fact at medium confidence sends nothing', async () => {
    const { graph } = world();
    const fact = graph.addNeuron({
      kind: 'fact',
      text: 'web_fetch fails on medium.com',
      support: { bots: ['finny', 'perf'] },
      createdBy: 'watcher',
      confidence: 'medium',
    });
    const { d, directives } = deps(graph, { toolsUsed: () => ['web_fetch'] });
    await runFastLane(d, [fact]);
    expect(directives).toEqual([]);
  });

  test('at most maxPerDay fast-lane broadcasts per UTC day, then one capped row', async () => {
    const { graph } = world();
    const patterns = ['a', 'b', 'c'].map((x) =>
      graph.addNeuron({
        kind: 'pattern',
        text: `web_fetch is blocked on site-${x}.com`,
        support: { bots: ['finny', 'perf'] },
        createdBy: 'watcher',
      })
    );
    const { d, directives, rows } = deps(graph, {
      config: () => ({ ...FAST_LANE_DEFAULTS, maxPerDay: 2 }),
      toolsUsed: (botId) => (botId === 'scout' ? ['web_fetch'] : []),
    });
    await runFastLane(d, patterns);
    expect(directives).toHaveLength(2);
    expect(rows.filter((r) => r.op === 'broadcast:fast-lane-capped')).toHaveLength(1);
    await runFastLane(d, patterns);
    expect(rows.filter((r) => r.op === 'broadcast:fast-lane-capped')).toHaveLength(1);
    // The next UTC day the lane opens again.
    t += 86_400_000;
    await runFastLane(d, patterns);
    expect(directives).toHaveLength(3);
  });

  test('the lane off, or a cancelled run: nothing', async () => {
    const { graph, pattern } = world();
    const off = deps(graph, { config: () => ({ ...FAST_LANE_DEFAULTS, enabled: false }) });
    await runFastLane(off.d, [pattern]);
    expect(off.directives).toEqual([]);
    const cancelled = deps(graph, { isCancelled: () => true });
    await runFastLane(cancelled.d, [pattern]);
    expect(cancelled.directives).toEqual([]);
  });

  test('the next integrate prompt lists the fast-lane broadcast under the pattern', async () => {
    const { graph, pattern } = world();
    const { d, broadcaster } = deps(graph);
    await runFastLane(d, [pattern]);
    const b = broadcaster.list()[0];
    const prompt = buildIntegratePrompt({
      events: [],
      fresh: [pattern],
      neighbourhood: [],
      goals: [],
      insights: [],
      predictions: [],
      bots: [],
      insightBroadcasts: {
        [pattern.id]: [{ bot: 'Scout', kind: b.kind, status: 'delivered', source: 'fast-lane' }],
      },
    });
    const line = prompt.user.split('\n').find((l) => l.includes(pattern.id)) ?? '';
    expect(line).toContain('directive to Scout (delivered, fast lane)');
  });
});
