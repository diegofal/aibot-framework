import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph } from '../../src/watcher/graph';
import {
  IMPORTANCE_WEIGHTS,
  USE_HALF_LIFE_MS,
  importanceOf,
  planForgetting,
  protectionOf,
} from '../../src/watcher/importance';
import type { Neuron } from '../../src/watcher/types';

const DAY = 86_400_000;
let dir: string;
let t: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-importance-'));
  t = Date.parse('2026-10-01T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function graph(): Graph {
  const g = new Graph(dir, { now: () => t });
  g.load();
  return g;
}

const fact = (g: Graph, text: string, extra: Partial<Neuron> = {}) =>
  g.addNeuron({
    kind: 'fact',
    text,
    support: { bots: ['b1'] },
    createdBy: 'bot:b1',
    activations: 1,
    ...extra,
  } as never);

const ctx = (extra: Partial<Parameters<typeof importanceOf>[1]> = {}) => ({
  nowMs: t,
  graceDays: 7,
  servedInsights: new Set<string>(),
  ...extra,
});

describe('importance', () => {
  test('the weights add up to 1', () => {
    const sum = Object.values(IMPORTANCE_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1);
  });

  test('a fact never used, of one bot, with no consequence scores 0 and says why', () => {
    const g = graph();
    const n = fact(g, 'the sky is blue');
    t += 30 * DAY;
    const s = importanceOf(g.get(n.id) as Neuron, ctx({ nowMs: t, graph: g }));
    expect(s.score).toBe(0);
    expect(s.components).toEqual({
      use: 0,
      consequence: 0,
      breadth: 0,
      surprise: 0,
      operator: 0,
    });
    expect(s.reason).toBe('importance 0.00: never used, one bot, no consequence');
  });

  test('use grows with activations and halves every 14 days without one', () => {
    const g = graph();
    const n = fact(g, 'used often', { activations: 32 } as never);
    const fresh = importanceOf(g.get(n.id) as Neuron, ctx({ graph: g }));
    expect(fresh.components.use).toBeCloseTo(1);
    const later = importanceOf(
      g.get(n.id) as Neuron,
      ctx({ nowMs: t + USE_HALF_LIFE_MS, graph: g })
    );
    expect(later.components.use).toBeCloseTo(0.5);
    expect(later.score).toBeCloseTo(0.5 * IMPORTANCE_WEIGHTS.use);
    expect(later.reason).toContain('used 32 times');
  });

  test('consequence: supporting an insight, a resolved prediction, or a served broadcast', () => {
    const g = graph();
    const a = fact(g, 'supports an insight');
    const b = fact(g, 'behind a prediction');
    const c = fact(g, 'nothing follows from it');
    const insight = g.addNeuron({
      kind: 'insight',
      text: 'an insight',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
    });
    g.addEdge({ from: a.id, to: insight.id, rel: 'caused', weight: 0.8, createdBy: 'watcher' });
    const p = g.addNeuron({
      kind: 'prediction',
      text: 'it will rain',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
      meta: { resolvedAt: '2026-10-02T00:00:00Z' },
    });
    g.addEdge({ from: p.id, to: b.id, rel: 'predicts', weight: 0.6, createdBy: 'watcher' });
    const c1 = ctx({ graph: g });
    expect(importanceOf(g.get(a.id) as Neuron, c1).components.consequence).toBe(1);
    expect(importanceOf(g.get(a.id) as Neuron, c1).reason).toContain('supports an insight');
    expect(importanceOf(g.get(b.id) as Neuron, c1).components.consequence).toBe(1);
    expect(importanceOf(g.get(b.id) as Neuron, c1).reason).toContain('resolved prediction');
    expect(importanceOf(g.get(c.id) as Neuron, c1).components.consequence).toBe(0);
    // an unresolved prediction is no consequence yet
    g.patchMeta(p.id, { resolvedAt: '' });
    expect(importanceOf(g.get(b.id) as Neuron, c1).components.consequence).toBe(0);
    const served = ctx({ graph: g, servedInsights: new Set([insight.id]) });
    expect(importanceOf(g.get(a.id) as Neuron, served).reason).toContain('served broadcast');
  });

  test('consequence: a fact named in meta.supportNeurons of an insight nobody served yet still supports it', () => {
    const g = graph();
    const old = fact(g, 'the deploy cache was stale on Tuesday');
    g.addNeuron({
      kind: 'insight',
      text: 'stale caches keep breaking deploys',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
      meta: { supportNeurons: `n-unknown,${old.id}` },
    } as never);
    t += 60 * DAY;
    const c1 = ctx({ nowMs: t, graph: g });
    const s = importanceOf(g.get(old.id) as Neuron, c1);
    expect(s.components.consequence).toBe(1);
    expect(s.score).toBeCloseTo(IMPORTANCE_WEIGHTS.consequence);
    expect(s.reason).toContain('supports an insight');
    expect(s.protected).toBeNull();
    const plan = planForgetting(g.list(), c1, { threshold: 0.15, target: 0 });
    expect(plan.archive.map((x) => x.neuron.id)).not.toContain(old.id);
  });

  test('breadth counts distinct bots and related links, log-scaled', () => {
    const g = graph();
    const one = fact(g, 'one bot alone');
    const many = fact(g, 'many bots', { support: { bots: ['b1', 'b2', 'b3', 'b3'] } } as never);
    const linked = fact(g, 'linked a lot');
    for (let i = 0; i < 15; i++) {
      const o = fact(g, `other ${i}`);
      g.addEdge({ from: linked.id, to: o.id, rel: 'related', weight: 0.9, createdBy: 'watcher' });
    }
    const c1 = ctx({ graph: g });
    expect(importanceOf(g.get(one.id) as Neuron, c1).components.breadth).toBe(0);
    const m = importanceOf(g.get(many.id) as Neuron, c1);
    expect(m.components.breadth).toBeGreaterThan(0);
    expect(m.reason).toContain('3 bots');
    const l = importanceOf(g.get(linked.id) as Neuron, c1);
    expect(l.components.breadth).toBeCloseTo(1);
    expect(l.reason).toContain('15 links');
  });

  test('surprise: kind surprise or contradiction, or meta.novel', () => {
    const g = graph();
    const s = g.addNeuron({
      kind: 'surprise',
      text: 'unexpected',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
    });
    const novel = fact(g, 'novel fact', { meta: { novel: 'true' } } as never);
    const c1 = ctx({ graph: g });
    expect(importanceOf(g.get(s.id) as Neuron, c1).components.surprise).toBe(1);
    expect(importanceOf(g.get(novel.id) as Neuron, c1).components.surprise).toBe(1);
    expect(importanceOf(g.get(s.id) as Neuron, c1).reason).toContain('a surprise');
  });

  test('operator signal: 👍 adds, 👎 subtracts (the score never goes below 0)', () => {
    const g = graph();
    const up = fact(g, 'liked', { meta: { signal: 'up' } } as never);
    const down = fact(g, 'disliked', {
      meta: { signal: 'down' },
      support: { bots: ['b1', 'b2', 'b3'] },
    } as never);
    const c1 = ctx({ graph: g });
    expect(importanceOf(g.get(up.id) as Neuron, c1).components.operator).toBe(1);
    const d = importanceOf(g.get(down.id) as Neuron, c1);
    expect(d.components.operator).toBe(-1);
    expect(d.score).toBeGreaterThanOrEqual(0);
    expect(d.reason).toContain('👎');
  });

  test('protection: entity, person, goal; 👍; support of a served broadcast; the grace period', () => {
    const g = graph();
    const kinds = (['entity', 'person', 'goal'] as const).map((kind) =>
      g.addNeuron({ kind, text: kind, support: { bots: ['b1'] }, createdBy: 'watcher' })
    );
    const liked = fact(g, 'liked', { meta: { signal: 'up' } } as never);
    const behind = fact(g, 'behind a served broadcast');
    const insight = g.addNeuron({
      kind: 'insight',
      text: 'served insight',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
    });
    g.addEdge({
      from: behind.id,
      to: insight.id,
      rel: 'caused',
      weight: 0.8,
      createdBy: 'watcher',
    });
    const plain = fact(g, 'plain');
    const old = ctx({ nowMs: t + 8 * DAY, graph: g, servedInsights: new Set([insight.id]) });
    for (const k of kinds) expect(protectionOf(g.get(k.id) as Neuron, old)).toBe('kind');
    expect(protectionOf(g.get(liked.id) as Neuron, old)).toBe('operator');
    expect(protectionOf(g.get(behind.id) as Neuron, old)).toBe('served');
    expect(protectionOf(g.get(insight.id) as Neuron, old)).toBe('served');
    expect(protectionOf(g.get(plain.id) as Neuron, old)).toBeNull();
    // younger than the grace
    expect(protectionOf(g.get(plain.id) as Neuron, ctx({ nowMs: t + 6 * DAY, graph: g }))).toBe(
      'grace'
    );
    const s = importanceOf(g.get(liked.id) as Neuron, old);
    expect(s.protected).toBe('operator');
    expect(s.reason).toContain('protected');
  });
});

describe('importance after consolidation', () => {
  test('an insight citing consolidated facts gives the summary that replaced them its consequence and protection', () => {
    const g = graph();
    const a = fact(g, 'the deploy cache was stale on Tuesday');
    const b = fact(g, 'the deploy cache was stale again on Wednesday');
    const insight = g.addNeuron({
      kind: 'insight',
      text: 'stale caches keep breaking deploys',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
      meta: { supportNeurons: `${a.id},${b.id}` },
    } as never);
    const summary = g.addNeuron({
      kind: 'summary',
      text: 'the deploy cache kept going stale',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
      activations: 1,
    } as never);
    g.mergeInto(summary.id, [a.id, b.id]);
    expect(g.get(a.id)?.archivedAt).toBeDefined();
    t += 60 * DAY;
    const s = importanceOf(g.get(summary.id) as Neuron, ctx({ nowMs: t, graph: g }));
    expect(s.components.consequence).toBe(1);
    expect(s.reason).toContain('supports an insight');
    expect(s.protected).toBeNull();
    const served = importanceOf(
      g.get(summary.id) as Neuron,
      ctx({ nowMs: t, graph: g, servedInsights: new Set([insight.id]) })
    );
    expect(served.protected).toBe('served');
  });
});

describe('planForgetting (review 2026-10-25: below the target too)', () => {
  test('below the target: every unprotected neuron under the threshold, capped at maxPerRun, lowest first', () => {
    const g = graph();
    const lows = [1, 2, 3, 4].map((i) => fact(g, `forgettable ${i}`));
    fact(g, 'used', { activations: 40 } as never);
    t += 10 * DAY;
    const c = ctx({ nowMs: t, graph: g });
    const all = planForgetting(g.list(), c, { threshold: 0.15, target: 1000 });
    expect(all.archive.map((x) => x.neuron.id).sort()).toEqual(lows.map((n) => n.id).sort());
    const capped = planForgetting(g.list(), c, { threshold: 0.15, target: 1000, maxPerRun: 2 });
    expect(capped.archive).toHaveLength(2);
    expect(capped.under).toBe(4);
  });

  test('above the target the excess wins over maxPerRun; never past the threshold', () => {
    const g = graph();
    for (let i = 0; i < 4; i++) fact(g, `forgettable ${i}`);
    for (let i = 0; i < 3; i++) fact(g, `kept ${i}`, { activations: 40 } as never);
    t += 10 * DAY;
    const c = ctx({ nowMs: t, graph: g });
    expect(
      planForgetting(g.list(), c, { threshold: 0.15, target: 4, maxPerRun: 1 }).archive
    ).toHaveLength(3);
    // a target of 0 cannot reach past the threshold: only the 4 low ones go
    expect(
      planForgetting(g.list(), c, { threshold: 0.15, target: 0, maxPerRun: 1 }).archive
    ).toHaveLength(4);
  });
});

describe('forgetting never takes an open prediction (review 2026-10-25)', () => {
  test('an unresolved prediction and what it predicts about are protected until it resolves', () => {
    const g = graph();
    const about = fact(g, 'the bot retries the import');
    const unrelated = fact(g, 'unrelated low fact');
    const p = g.addNeuron({
      kind: 'prediction',
      text: 'b1 retries the import tomorrow',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
      activations: 1,
      meta: { dueAt: new Date(t + 30 * DAY).toISOString(), probability: '0.6' },
    } as never);
    g.addEdge({ from: p.id, to: about.id, rel: 'predicts', weight: 0.6, createdBy: 'watcher' });
    t += 10 * DAY;
    const c = ctx({ nowMs: t, graph: g });
    expect(protectionOf(g.get(p.id) as Neuron, c)).toBe('pending');
    expect(protectionOf(g.get(about.id) as Neuron, c)).toBe('pending');
    expect(importanceOf(g.get(p.id) as Neuron, c).reason).toContain('open prediction');
    const plan = planForgetting(g.list(), c, { threshold: 0.15, target: 0 });
    const ids = plan.archive.map((x) => x.neuron.id);
    expect(ids).not.toContain(p.id);
    expect(ids).not.toContain(about.id);
    expect(ids).toContain(unrelated.id);
    // once resolved, the open-prediction protection ends
    g.patchMeta(p.id, { resolvedAt: new Date(t).toISOString(), outcome: 'unknown' }, []);
    expect(protectionOf(g.get(p.id) as Neuron, c)).not.toBe('pending');
    expect(protectionOf(g.get(about.id) as Neuron, c)).not.toBe('pending');
  });
});
