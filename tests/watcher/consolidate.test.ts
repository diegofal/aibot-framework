import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../src/config';
import type { LLMClient } from '../../src/core/llm-client';
import {
  type ConsolidateDeps,
  chunkCluster,
  findClusters,
  provenanceClass,
  runConsolidation,
  validateSummary,
} from '../../src/watcher/consolidate';
import { Graph } from '../../src/watcher/graph';
import type { InstrumentedClient, WatcherCallResult } from '../../src/watcher/llm';
import { WatcherLog } from '../../src/watcher/log';
import { type Neuron, WATCHER_DEFAULTS } from '../../src/watcher/types';
import { Watcher, fleetQuietFrom } from '../../src/watcher/watcher';

const DAY = 86_400_000;
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
  root = mkdtempSync(join(tmpdir(), 'watcher-consolidate-'));
  t = Date.parse('2026-10-01T10:00:00Z');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function graph(): Graph {
  const g = new Graph(join(root, 'g'), { now: () => t });
  g.load();
  return g;
}

const LONG = 'failed its nightly deploy on a stale build cache and had to retry by hand';

function fact(g: Graph, i: number, extra: Partial<Neuron> = {}): Neuron {
  return g.addNeuron({
    kind: 'fact',
    text: `Run ${i} of the pipeline ${LONG}`,
    support: { bots: ['b1'], cycles: [`c-${i}`] },
    createdBy: 'bot:b1',
    activations: 1,
    meta: { operatorMessage: 'false' },
    ...extra,
  } as never);
}

/** A chain of `related` edges among the neurons. */
function chain(g: Graph, ns: Neuron[]): void {
  for (let i = 1; i < ns.length; i++) {
    g.addEdge({
      from: ns[i - 1].id,
      to: ns[i].id,
      rel: 'related',
      weight: 0.9,
      createdBy: 'watcher',
    });
  }
}

function importance(g: Graph) {
  return () => ({ nowMs: t, graph: g, graceDays: 7, servedInsights: new Set<string>() });
}

function fakeClient(reply: () => string): InstrumentedClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    tier: 'notice',
    model: 'claude-haiku-5-5',
    backend: 'claude-cli',
    calls,
    chat: async (messages): Promise<WatcherCallResult> => {
      calls.push(messages.map((m) => m.content).join('\n'));
      return {
        ok: true,
        text: reply(),
        model: 'claude-haiku-5-5',
        backend: 'claude-cli',
        tokens: 20,
        durationMs: 7,
      };
    },
  };
}

function deps(g: Graph, client: InstrumentedClient, over: Partial<ConsolidateDeps> = {}) {
  return {
    graph: g,
    log: new WatcherLog(join(root, 'log'), { now: () => t }),
    client,
    importance: importance(g),
    threshold: 0.15,
    minCluster: 6,
    maxClusters: 10,
    bots: () => [
      { id: 'b1', name: 'Jarvis' },
      { id: 'b2', name: 'Scout' },
    ],
    isQuiet: () => true,
    ...over,
  } satisfies ConsolidateDeps;
}

const SUMMARY = JSON.stringify({ summary: 'Nightly deploys kept failing on a stale build cache.' });

describe('clusters', () => {
  test('connected components over related edges among low-importance facts, at least minCluster', () => {
    const g = graph();
    const big = Array.from({ length: 6 }, (_, i) => fact(g, i));
    chain(g, big);
    const small = Array.from({ length: 3 }, (_, i) => fact(g, 10 + i));
    chain(g, small);
    t += 10 * DAY;
    const clusters = findClusters(g, importance(g)(), { threshold: 0.15, minCluster: 6 });
    expect(clusters.length).toBe(1);
    expect(clusters[0].members.map((n) => n.id).sort()).toEqual(big.map((n) => n.id).sort());
    expect(clusters[0].provenance).toBe('public');
  });

  test('protected, young, non-fact and important neurons are never members', () => {
    const g = graph();
    const ns = Array.from({ length: 6 }, (_, i) => fact(g, i));
    g.patchMeta(ns[2].id, { signal: 'up' });
    chain(g, ns);
    t += 10 * DAY;
    // the 👍 breaks the chain: two components of 2 and 3, both under minCluster
    expect(
      findClusters(g, importance(g)(), { threshold: 0.15, minCluster: 2 })
        .map((c) => c.members.length)
        .sort()
    ).toEqual([2, 3]);
    const young = graph();
    const ys = Array.from({ length: 6 }, (_, i) => fact(young, i));
    chain(young, ys);
    expect(findClusters(young, importance(young)(), { threshold: 0.15, minCluster: 6 })).toEqual(
      []
    );
  });

  test('a cluster mixing provenance classes is split by class', () => {
    const g = graph();
    const pub = Array.from({ length: 6 }, (_, i) => fact(g, i));
    const op = Array.from({ length: 6 }, (_, i) =>
      fact(g, 20 + i, { meta: { operatorSourced: 'true', operatorMessage: 'false' } } as never)
    );
    chain(g, [...pub, ...op]);
    t += 10 * DAY;
    const clusters = findClusters(g, importance(g)(), { threshold: 0.15, minCluster: 6 });
    // an operator-sourced fact may carry the operator's words (mayCarryOperatorMessage)
    expect(clusters.map((c) => c.provenance).sort()).toEqual(['operator-message', 'public']);
    for (const c of clusters) {
      expect(new Set(c.members.map((n) => provenanceClass(n))).size).toBe(1);
    }
  });
});

describe('validateSummary', () => {
  const members = [
    { text: 'a'.repeat(60), support: { bots: ['b1'] } },
    { text: 'b'.repeat(40), support: { bots: ['b1'] } },
  ] as Neuron[];
  const bots = [
    { id: 'b1', name: 'Jarvis' },
    { id: 'b2', name: 'Scout' },
  ];
  test('empty, longer than the members mean, or naming a bot not in support', () => {
    expect(validateSummary('', members, bots)).toContain('empty');
    expect(validateSummary('x'.repeat(51), members, bots)).toContain('longer');
    expect(validateSummary('Scout saw it too', members, bots)).toContain('Scout');
    expect(validateSummary('Jarvis saw it', members, bots)).toBeNull();
  });
});

describe('runConsolidation', () => {
  test('a Haiku fixture becomes a summary; members are archived into it and their topics linked', async () => {
    const g = graph();
    const ns = Array.from({ length: 6 }, (_, i) =>
      fact(g, i, i === 3 ? ({ support: { bots: ['b2'], cycles: ['c-x'] } } as never) : {})
    );
    chain(g, ns);
    const topic = g.addNeuron({
      kind: 'topic',
      text: 'deploys',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
    });
    g.addEdge({ from: ns[0].id, to: topic.id, rel: 'about', weight: 1, createdBy: 'watcher' });
    t += 10 * DAY;
    const client = fakeClient(() => SUMMARY);
    const d = deps(g, client);
    const out = await runConsolidation(d);
    expect(client.calls.length).toBe(1);
    expect(client.calls[0]).toContain('Run 0 of the pipeline');
    expect(out.summaries.length).toBe(1);
    const s = g.get(out.summaries[0].id) as Neuron;
    expect(s.kind).toBe('summary');
    expect(s.text).toBe('Nightly deploys kept failing on a stale build cache.');
    expect(s.meta?.consolidated).toBe('true');
    expect(s.meta?.members?.split(',').sort()).toEqual(ns.map((n) => n.id).sort());
    expect(s.support.bots.sort()).toEqual(['b1', 'b2']);
    expect(s.createdBy).toBe('watcher');
    for (const n of ns) {
      const m = g.get(n.id) as Neuron;
      expect(m.archivedAt).toBeDefined();
      expect(m.meta?.mergedInto).toBe(s.id);
      expect(m.meta?.consolidatedInto).toBe(s.id);
      expect(m.meta?.archivedReason).toContain('consolidated into a summary');
    }
    expect(
      g.edgesOf(s.id).some((e) => e.rel === 'about' && e.to === topic.id && e.from === s.id)
    ).toBe(true);
    // activating a member fires the summary
    expect(g.activate(ns[1].id)?.id).toBe(s.id);
    const rows = d.log.recent(10);
    const row = rows.find((r) => r.op === 'consolidate:summary');
    expect(row?.phase).toBe('sleep');
    expect(row?.source).toBe('watcher:consolidate');
    expect(row?.neuronIds?.[0]).toBe(s.id);
    expect(rows.find((r) => r.op === 'consolidate:pass')?.text).toContain('1 summary');
  });

  test('the summary of operator-sourced members carries the strictest provenance', async () => {
    const g = graph();
    const ns = Array.from({ length: 6 }, (_, i) =>
      fact(g, i, {
        meta: { operatorSourced: 'true', operatorMessage: i === 0 ? 'true' : 'false' },
      } as never)
    );
    chain(g, ns);
    t += 10 * DAY;
    const out = await runConsolidation(
      deps(
        g,
        fakeClient(() => SUMMARY)
      )
    );
    const s = g.get(out.summaries[0].id) as Neuron;
    expect(s.meta?.operatorSourced).toBe('true');
    expect(s.meta?.operatorMessage).toBe('true');
  });

  test('a summary that fails validation is skipped and logged; the facts stay', async () => {
    const g = graph();
    const ns = Array.from({ length: 6 }, (_, i) => fact(g, i));
    chain(g, ns);
    t += 10 * DAY;
    const d = deps(
      g,
      fakeClient(() => JSON.stringify({ summary: 'Scout broke the deploys.' }))
    );
    const out = await runConsolidation(d);
    expect(out.summaries.length).toBe(0);
    expect(out.skipped).toBe(1);
    for (const n of ns) expect(g.get(n.id)?.archivedAt).toBeUndefined();
    expect(g.list().some((n) => n.kind === 'summary')).toBe(false);
    const row = d.log.recent(10).find((r) => r.op === 'consolidate:skipped');
    expect(row?.text).toContain('Scout');
  });

  test('never while the loop runs: a fleet that wakes up stops the night', async () => {
    const g = graph();
    for (const k of [0, 10]) {
      const ns = Array.from({ length: 6 }, (_, i) => fact(g, k + i));
      chain(g, ns);
    }
    t += 10 * DAY;
    let quiet = true;
    const client = fakeClient(() => {
      quiet = false;
      return SUMMARY;
    });
    const out = await runConsolidation(deps(g, client, { isQuiet: () => quiet }));
    expect(client.calls.length).toBe(1);
    expect(out.stopped).toBe('busy');
    const none = fakeClient(() => SUMMARY);
    const out2 = await runConsolidation(deps(g, none, { isQuiet: () => false }));
    expect(none.calls.length).toBe(0);
    expect(out2.stopped).toBe('busy');
  });

  test('at most maxClusters calls a night', async () => {
    const g = graph();
    for (const k of [0, 10, 20])
      chain(
        g,
        Array.from({ length: 6 }, (_, i) => fact(g, k + i))
      );
    t += 10 * DAY;
    const client = fakeClient(() => SUMMARY);
    const out = await runConsolidation(deps(g, client, { maxClusters: 2 }));
    expect(client.calls.length).toBe(2);
    expect(out.summaries.length).toBe(2);
  });
});

describe('runConsolidation: what the model saw, what changed meanwhile, the cap', () => {
  test('a cluster of 55 is split into calls of at most 40; no member is archived that was not in a prompt', async () => {
    const g = graph();
    const ns = Array.from({ length: 55 }, (_, i) => fact(g, i));
    chain(g, ns);
    t += 10 * DAY;
    const client = fakeClient(() => SUMMARY);
    const out = await runConsolidation(deps(g, client));
    expect(client.calls.length).toBe(2);
    for (const c of client.calls) expect(c).not.toContain('more facts like these');
    for (const [i, n] of ns.entries()) {
      const m = g.get(n.id) as Neuron;
      if (!m.archivedAt) continue;
      expect(
        client.calls.some((c) =>
          c.includes(`
- Run ${i} of the pipeline`)
        )
      ).toBe(true);
    }
    expect(out.members).toBe(55);
    expect(out.summaries.length).toBe(2);
  });

  test('minCluster 30 and 41 facts: no even split fits, so one chunk of 40 is summarised and 1 stays live', async () => {
    const g = graph();
    const ns = Array.from({ length: 41 }, (_, i) => fact(g, i));
    chain(g, ns);
    t += 10 * DAY;
    const client = fakeClient(() => SUMMARY);
    const out = await runConsolidation(deps(g, client, { minCluster: 30 }));
    expect(client.calls.length).toBe(1);
    expect(client.calls[0]).not.toContain('more facts like these');
    expect(out.summaries.length).toBe(1);
    expect(out.members).toBe(40);
    expect(out.skipped).toBe(0);
    const live = g.list().filter((n) => n.kind === 'fact' && !n.archivedAt);
    expect(live.length).toBe(1);
  });

  test('chunkCluster: every chunk between minCluster and 40, or full chunks of 40 when no split fits', () => {
    const g = graph();
    const cluster = (n: number) => ({
      members: Array.from({ length: n }, (_, i) => fact(g, i)),
      provenance: 'public' as const,
    });
    const sizes = (n: number, min: number) =>
      chunkCluster(cluster(n), min).map((c) => c.members.length);
    expect(sizes(55, 6)).toEqual([27, 28]);
    const s41 = sizes(41, 6);
    expect(s41.length).toBe(2);
    for (const k of s41) expect(k).toBeGreaterThanOrEqual(6);
    expect(s41.reduce((a, b) => a + b, 0)).toBe(41);
    expect(sizes(41, 30)).toEqual([40]);
    expect(sizes(40, 30)).toEqual([40]);
    expect(sizes(85, 30)).toEqual([40, 40]);
  });

  test('each chunk counts against maxClusters', async () => {
    const g = graph();
    chain(
      g,
      Array.from({ length: 55 }, (_, i) => fact(g, i))
    );
    t += 10 * DAY;
    const client = fakeClient(() => SUMMARY);
    const out = await runConsolidation(deps(g, client, { maxClusters: 1 }));
    expect(client.calls.length).toBe(1);
    expect(out.clusters).toBe(1);
    expect(out.members).toBeLessThanOrEqual(40);
    const live = g.list().filter((n) => n.kind === 'fact' && !n.archivedAt).length;
    expect(live).toBe(55 - out.members);
  });

  /** Members that become protected or important while the call is pending. */
  function changeDuringCall(g: Graph, ns: Neuron[], served: Set<string>) {
    return () => {
      g.patchMeta(ns[1].id, { signal: 'up' });
      const insight = g.addNeuron({
        kind: 'insight',
        text: 'Deploys fail on stale caches',
        support: { bots: ['b1'] },
        createdBy: 'watcher',
        meta: { supportNeurons: ns[2].id },
      } as never);
      served.add(insight.id);
      g.setActivation(ns[3].id, 10_000, new Date(t).toISOString());
      return SUMMARY;
    };
  }

  test('a member protected or made important during the call is not merged', async () => {
    const g = graph();
    const ns = Array.from({ length: 9 }, (_, i) => fact(g, i));
    chain(g, ns);
    t += 10 * DAY;
    const served = new Set<string>();
    const client = fakeClient(changeDuringCall(g, ns, served));
    const out = await runConsolidation(
      deps(g, client, {
        importance: () => ({ nowMs: t, graph: g, graceDays: 7, servedInsights: served }),
      })
    );
    expect(out.summaries.length).toBe(1);
    expect(out.members).toBe(6);
    const s = g.get(out.summaries[0].id) as Neuron;
    const kept = [ns[1], ns[2], ns[3]].map((n) => n.id);
    for (const id of kept) {
      expect(g.get(id)?.archivedAt).toBeUndefined();
      expect(s.meta?.members?.split(',')).not.toContain(id);
    }
    expect(s.meta?.members?.split(',').length).toBe(6);
  });

  test('when fewer than minCluster remain unchanged, the summary is skipped and logged', async () => {
    const g = graph();
    const ns = Array.from({ length: 7 }, (_, i) => fact(g, i));
    chain(g, ns);
    t += 10 * DAY;
    const served = new Set<string>();
    const client = fakeClient(changeDuringCall(g, ns, served));
    const d = deps(g, client, {
      importance: () => ({ nowMs: t, graph: g, graceDays: 7, servedInsights: served }),
    });
    const out = await runConsolidation(d);
    expect(out.summaries.length).toBe(0);
    expect(out.skipped).toBe(1);
    for (const n of ns) expect(g.get(n.id)?.archivedAt).toBeUndefined();
    expect(g.list().some((n) => n.kind === 'summary')).toBe(false);
    const row = d.log.recent(10).find((r) => r.op === 'consolidate:skipped');
    expect(row?.text).toBeDefined();
  });

  test('at maxNeurons, adding the summary never evicts a member: every member redirects to it', async () => {
    const g = new Graph(join(root, 'capped'), { now: () => t, maxNeurons: 7 });
    g.load();
    const ns = Array.from({ length: 6 }, (_, i) => fact(g, i));
    chain(g, ns);
    t += 10 * DAY;
    const topic = g.addNeuron({
      kind: 'topic',
      text: 'deploys',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
    });
    expect(g.liveCount()).toBe(7);
    const out = await runConsolidation(
      deps(
        g,
        fakeClient(() => SUMMARY)
      )
    );
    const s = g.get(out.summaries[0].id) as Neuron;
    for (const n of ns) expect(g.get(n.id)?.meta?.mergedInto).toBe(s.id);
    expect(g.activate(ns[0].id)?.id).toBe(s.id);
    expect(g.get(topic.id)?.archivedAt).toBeUndefined();
    expect(g.liveCount()).toBeLessThanOrEqual(7);
  });
});

describe('Watcher.consolidateNow', () => {
  const live: Watcher[] = [];
  afterEach(async () => {
    for (const w of live.splice(0)) await w.stop();
  });

  async function make(opts: { quiet: boolean; maxPerDay?: number; hour?: number }) {
    const config = {
      bots: [],
      paths: { data: join(root, 'data') },
      soul: {},
      operator: {},
      watcher: {
        ...WATCHER_DEFAULTS,
        enabled: true,
        notice: { ...WATCHER_DEFAULTS.notice, enabled: true, maxPerDay: opts.maxPerDay ?? 10 },
        consolidate: {
          enabled: true,
          hour: opts.hour ?? new Date(t + 10 * DAY).getHours(),
          minCluster: 6,
          maxClusters: 10,
        },
      },
    } as unknown as Config;
    let calls = 0;
    const client = {
      backend: 'claude-cli',
      generate: async () => ({ text: '' }),
      chat: async () => {
        calls++;
        return { text: SUMMARY, usage: { model: 'claude-haiku-5-5', totalTokens: 20 } };
      },
    } as unknown as LLMClient;
    const w = new Watcher({
      config: () => config,
      logger: noopLogger,
      activityStream: new EventEmitter(),
      hooks: new EventEmitter(),
      botManager: {
        getChannelState: () => undefined,
        getUserDirectory: () => ({ list: () => [], findByChannel: () => undefined }) as never,
      },
      now: () => t,
      llm: { notice: { client, model: 'claude-haiku-5-5', backend: 'claude-cli' } },
      fleetQuiet: () => opts.quiet,
    });
    live.push(w);
    await w.start();
    await w.idle();
    chain(
      w.graph,
      Array.from({ length: 6 }, (_, i) => fact(w.graph, i))
    );
    t += 10 * DAY;
    return { w, calls: () => calls };
  }

  test('runs on the notice tier and shares its budget', async () => {
    const { w, calls } = await make({ quiet: true });
    const out = await w.consolidateNow();
    expect(calls()).toBe(1);
    expect(out?.summaries.length).toBe(1);
    expect(w.budget.used('notice').calls).toBe(1);
  });

  test('a spent notice budget stops it before any call', async () => {
    const { w, calls } = await make({ quiet: true, maxPerDay: 0 });
    const out = await w.consolidateNow();
    expect(calls()).toBe(0);
    expect(out?.stopped).toBe('cap');
  });

  test('never while an agent-loop cycle runs', async () => {
    const { w, calls } = await make({ quiet: false });
    const out = await w.consolidateNow();
    expect(calls()).toBe(0);
    expect(out?.stopped).toBe('busy');
  });

  test('the nightly tick runs only at consolidate.hour, once a night', async () => {
    const other = (new Date(t + 10 * DAY).getHours() + 12) % 24;
    const off = await make({ quiet: true, hour: other });
    expect(off.w.consolidateTick()).toBe(false);
    expect(off.calls()).toBe(0);
  });

  test('the nightly tick at the hour runs once', async () => {
    const on = await make({ quiet: true });
    expect(on.w.consolidateTick()).toBe(true);
    await on.w.consolidationIdle();
    expect(on.calls()).toBe(1);
    expect(on.w.consolidateTick()).toBe(false);
  });
});

describe('fleetQuietFrom', () => {
  test('quiet only when no cycle runs and the loop is not draining', () => {
    expect(fleetQuietFrom({ running: false, sleeping: true })).toBe(true);
    expect(fleetQuietFrom({ running: false, sleeping: false })).toBe(true);
    expect(fleetQuietFrom({ running: true, sleeping: true })).toBe(false);
    expect(fleetQuietFrom({ running: false, sleeping: true, draining: true })).toBe(false);
    expect(fleetQuietFrom(undefined)).toBe(false);
  });
});
