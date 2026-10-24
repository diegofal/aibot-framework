import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textSimilarity as textSimilarityOf } from '../../src/hygiene/text-utils';
import { cosineSimilarity } from '../../src/memory/search';
import { Graph, type GraphChange } from '../../src/watcher/graph';
import { graphFiles } from '../../src/watcher/paths';

let dir: string;
let t: number;
const now = () => t;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-graph-'));
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function graph(opts: Partial<ConstructorParameters<typeof Graph>[1]> = {}) {
  const g = new Graph(dir, { now, ...opts });
  g.load();
  return g;
}

const fact = (text: string, extra: Record<string, unknown> = {}) => ({
  kind: 'fact' as const,
  text,
  support: { bots: ['b1'] },
  createdBy: 'bot:b1' as const,
  ...extra,
});

describe('cosineSimilarity (exported from memory/search)', () => {
  test('1 for the same direction, 0 for orthogonal or zero vectors', () => {
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('Graph', () => {
  test('addNeuron assigns an id, timestamps and zero activations', () => {
    const g = graph();
    const n = g.addNeuron(fact('Invoices arrive on the 3rd'));
    expect(n.id).toMatch(/^n-[0-9a-f]{8}$/);
    expect(n.createdAt).toBe('2026-10-23T10:00:00.000Z');
    expect(n.lastActivatedAt).toBe(n.createdAt);
    expect(n.activations).toBe(0);
    expect(g.get(n.id)).toEqual(n);
  });

  test('findByKey finds a neuron by meta.key', () => {
    const g = graph();
    const n = g.addNeuron(fact('x', { meta: { key: 'fact:b1:f1' } }));
    expect(g.findByKey('fact:b1:f1')?.id).toBe(n.id);
    expect(g.findByKey('nope')).toBeUndefined();
  });

  test('addEdge dedupes the same from/to/rel and treats related as symmetric', () => {
    const g = graph();
    const a = g.addNeuron(fact('a'));
    const b = g.addNeuron(fact('b'));
    const e1 = g.addEdge({ from: a.id, to: b.id, rel: 'about', weight: 1, createdBy: 'watcher' });
    const e2 = g.addEdge({ from: a.id, to: b.id, rel: 'about', weight: 1, createdBy: 'watcher' });
    expect(e2.id).toBe(e1.id);
    const r1 = g.addEdge({
      from: a.id,
      to: b.id,
      rel: 'related',
      weight: 0.9,
      createdBy: 'watcher',
    });
    const r2 = g.addEdge({
      from: b.id,
      to: a.id,
      rel: 'related',
      weight: 0.9,
      createdBy: 'watcher',
    });
    expect(r2.id).toBe(r1.id);
    expect(r1.id).toMatch(/^e-[0-9a-f]{8}$/);
    expect(g.edgeCount()).toBe(2);
  });

  test('activate counts and stamps; an archived neuron comes back', () => {
    const g = graph();
    const n = g.addNeuron(fact('a'));
    g.archive(n.id);
    expect(g.get(n.id)?.archivedAt).toBe('2026-10-23T10:00:00.000Z');
    t += 60_000;
    const after = g.activate(n.id);
    expect(after?.activations).toBe(1);
    expect(after?.lastActivatedAt).toBe('2026-10-23T10:01:00.000Z');
    expect(after?.archivedAt).toBeUndefined();
    expect(g.activate('n-missing')).toBeUndefined();
  });

  test('setActivation sets the count and last activation', () => {
    const g = graph();
    const n = g.addNeuron(fact('a'));
    g.setActivation(n.id, 5, '2026-10-20T00:00:00.000Z');
    expect(g.get(n.id)?.activations).toBe(5);
    expect(g.get(n.id)?.lastActivatedAt).toBe('2026-10-20T00:00:00.000Z');
  });

  test('neighbours lists the other end of every edge', () => {
    const g = graph();
    const a = g.addNeuron(fact('a'));
    const b = g.addNeuron(fact('b'));
    const c = g.addNeuron(fact('c'));
    g.addEdge({ from: a.id, to: b.id, rel: 'about', weight: 1, createdBy: 'watcher' });
    g.addEdge({ from: c.id, to: a.id, rel: 'owned_by', weight: 1, createdBy: 'watcher' });
    expect(
      g
        .neighbours(a.id)
        .map((x) => x.neuron.id)
        .sort()
    ).toEqual([b.id, c.id].sort());
    expect(g.edgesOf(a.id)).toHaveLength(2);
    expect(g.neighbours(b.id).map((x) => x.neuron.id)).toEqual([a.id]);
  });

  test('reload from files equals in-memory', () => {
    const g = graph();
    const a = g.addNeuron(fact('a'));
    const b = g.addNeuron(fact('b', { meta: { key: 'k' } }));
    g.addEdge({ from: a.id, to: b.id, rel: 'about', weight: 1, createdBy: 'watcher' });
    g.activate(a.id);
    g.setEmbedding(a.id, [1, 0, 0]);
    // Activations reach disk in a batch (see "the sensing hot path" below).
    g.flushActivations();
    const reloaded = graph();
    expect(reloaded.snapshot().neurons).toEqual(g.snapshot().neurons);
    expect(reloaded.snapshot().edges).toEqual(g.snapshot().edges);
    expect(reloaded.getEmbedding(a.id)).toEqual([1, 0, 0]);
    expect(reloaded.findByKey('k')?.id).toBe(b.id);
  });

  test('compact preserves last-wins and empties the append files', () => {
    const g = graph();
    const a = g.addNeuron(fact('a'));
    g.activate(a.id);
    g.activate(a.id);
    g.setEmbedding(a.id, [0, 1]);
    g.setEmbedding(a.id, [1, 1]);
    g.compact();
    const files = graphFiles(dir);
    expect(existsSync(files.graph)).toBe(true);
    expect(readFileSync(files.neurons, 'utf-8')).toBe('');
    const reloaded = graph();
    expect(reloaded.get(a.id)?.activations).toBe(2);
    expect(reloaded.getEmbedding(a.id)).toEqual([1, 1]);
    expect(readFileSync(files.embeddings, 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  test('compacts on its own every compactEvery appends (off the append path)', async () => {
    const g = graph({ compactEvery: 3 });
    g.addNeuron(fact('a'));
    g.addNeuron(fact('b'));
    expect(existsSync(graphFiles(dir).graph)).toBe(false);
    g.addNeuron(fact('c'));
    await g.whenCompacted();
    expect(existsSync(graphFiles(dir).graph)).toBe(true);
  });

  test('a corrupt file never throws on load', () => {
    const files = graphFiles(dir);
    writeFileSync(files.graph, '{nope');
    writeFileSync(files.neurons, 'garbage\n');
    const g = new Graph(dir, { now });
    expect(() => g.load()).not.toThrow();
    expect(g.size()).toBe(0);
  });

  test('findSimilarText respects the threshold and skips archived', () => {
    const g = graph();
    const a = g.addNeuron(fact('invoices from acme arrive monthly'));
    const b = g.addNeuron(fact('the weather is nice'));
    expect(g.findSimilarText('invoices from acme arrive monthly', 0.8).map((n) => n.id)).toEqual([
      a.id,
    ]);
    expect(g.findSimilarText('invoices acme', 0.3).map((n) => n.id)).toEqual([a.id]);
    expect(g.findSimilarText('invoices acme', 0.9)).toEqual([]);
    g.archive(a.id);
    expect(g.findSimilarText('invoices from acme arrive monthly', 0.8)).toEqual([]);
    expect(b).toBeDefined();
  });

  test('findSimilarEmbedding ranks by cosine above the threshold', () => {
    const g = graph();
    const a = g.addNeuron(fact('a'));
    const b = g.addNeuron(fact('b'));
    g.setEmbedding(a.id, [1, 0]);
    g.setEmbedding(b.id, [0.8, 0.6]);
    const hits = g.findSimilarEmbedding([1, 0], 0.5);
    expect(hits.map((h) => h.neuron.id)).toEqual([a.id, b.id]);
    expect(hits[0].score).toBeCloseTo(1);
    expect(g.findSimilarEmbedding([1, 0], 0.9).map((h) => h.neuron.id)).toEqual([a.id]);
  });

  test('maxNeurons cap archives the oldest inactive neuron', () => {
    const g = graph({ maxNeurons: 2 });
    const a = g.addNeuron(fact('a'));
    t += 1000;
    const b = g.addNeuron(fact('b'));
    t += 1000;
    g.activate(a.id);
    t += 1000;
    g.addNeuron(fact('c'));
    expect(g.get(b.id)?.archivedAt).toBeDefined();
    expect(g.get(a.id)?.archivedAt).toBeUndefined();
    expect(g.liveCount()).toBe(2);
  });

  test('archiveInactive archives what has not fired in the window', () => {
    const g = graph();
    const a = g.addNeuron(fact('a'));
    t += 10 * 86_400_000;
    const b = g.addNeuron(fact('b'));
    const archived = g.archiveInactive(5 * 86_400_000);
    expect(archived.map((n) => n.id)).toEqual([a.id]);
    expect(g.get(b.id)?.archivedAt).toBeUndefined();
  });

  test('counts live neurons per kind', () => {
    const g = graph();
    g.addNeuron(fact('a'));
    const p = g.addNeuron({ ...fact('Ana'), kind: 'person' });
    g.archive(p.id);
    expect(g.counts().fact).toBe(1);
    expect(g.counts().person).toBe(0);
  });

  test('snapshot carries no embeddings and a rev that moves', () => {
    const g = graph();
    const a = g.addNeuron(fact('a'));
    g.setEmbedding(a.id, [1, 2, 3]);
    const s1 = g.snapshot();
    expect(JSON.stringify(s1)).not.toContain('embedding');
    g.activate(a.id);
    expect(g.snapshot().rev).toBeGreaterThan(s1.rev);
  });

  test('setPositions stores pos without a change per neuron in the files', () => {
    const g = graph();
    const a = g.addNeuron(fact('a'));
    g.setPositions(new Map([[a.id, [0.1, 0.2, 0.3]]]));
    expect(graph().get(a.id)?.pos).toEqual([0.1, 0.2, 0.3]);
  });

  // A page connected during birth got the neurons at their fallback shell
  // positions; the relayout must reach it.
  test('setPositions emits one layout change with the positions it applied', () => {
    const changes: GraphChange[] = [];
    const g = graph({ onChange: (c) => changes.push(c) });
    const a = g.addNeuron(fact('a'));
    const b = g.addNeuron(fact('b'));
    changes.length = 0;
    g.setPositions(
      new Map([
        [a.id, [0.1, 0.2, 0.3]],
        [b.id, [-0.1, 0, 0.5]],
        ['n-ghost', [0, 0, 0]],
      ])
    );
    expect(changes).toEqual([
      {
        type: 'layout',
        positions: { [a.id]: [0.1, 0.2, 0.3], [b.id]: [-0.1, 0, 0.5] },
      },
    ]);
  });

  test('setPositions with nothing to move emits nothing', () => {
    const changes: GraphChange[] = [];
    const g = graph({ onChange: (c) => changes.push(c) });
    g.setPositions(new Map([['n-ghost', [0, 0, 0]]]));
    expect(changes).toEqual([]);
  });

  test('every change goes to the listener', () => {
    const changes: GraphChange[] = [];
    const g = graph({ onChange: (c) => changes.push(c) });
    const a = g.addNeuron(fact('a'));
    const b = g.addNeuron(fact('b'));
    g.addEdge({ from: a.id, to: b.id, rel: 'about', weight: 1, createdBy: 'watcher' });
    g.activate(a.id);
    g.archive(b.id);
    expect(changes.map((c) => c.type)).toEqual(['neuron', 'neuron', 'edge', 'activate', 'neuron']);
    const last = changes[4];
    expect(last.type === 'neuron' && last.neuron.archivedAt).toBeTruthy();
  });
});

describe('Graph.patchMeta (phase 3)', () => {
  test('merges meta, persists, and emits the neuron', () => {
    const changes: GraphChange[] = [];
    const g = graph({ onChange: (c) => changes.push(c) });
    const n = g.addNeuron(fact('A prediction', { meta: { dueAt: 'x' } }));
    changes.length = 0;
    const next = g.patchMeta(n.id, { resolvedAt: 'y', happened: 'true' });
    expect(next?.meta).toEqual({ dueAt: 'x', resolvedAt: 'y', happened: 'true' });
    expect(changes.map((c) => c.type)).toEqual(['neuron']);
    expect(next?.activations).toBe(n.activations);
    const again = graph();
    expect(again.get(n.id)?.meta).toEqual({ dueAt: 'x', resolvedAt: 'y', happened: 'true' });
  });

  test('unknown id is undefined', () => {
    expect(graph().patchMeta('n-nope', { a: 'b' })).toBeUndefined();
  });
});

describe('Graph.addSupport (review 2026-10-24)', () => {
  test('unions bots and cycles, persists, emits once; nothing new is a no-op', () => {
    const changes: GraphChange[] = [];
    const g = graph({ onChange: (c) => changes.push(c) });
    const n = g.addNeuron(
      fact('web_fetch is blocked', { support: { bots: ['b1'], cycles: ['c1'] } })
    );
    changes.length = 0;
    const next = g.addSupport(n.id, { bots: ['b2', 'b1'], cycles: ['c2'] });
    expect(next?.support).toEqual({ bots: ['b1', 'b2'], cycles: ['c1', 'c2'] });
    expect(next?.activations).toBe(n.activations);
    expect(changes.map((c) => c.type)).toEqual(['neuron']);
    expect(graph().get(n.id)?.support).toEqual({ bots: ['b1', 'b2'], cycles: ['c1', 'c2'] });
    changes.length = 0;
    expect(g.addSupport(n.id, { bots: ['b2'], cycles: [] })?.support.bots).toEqual(['b1', 'b2']);
    expect(changes).toEqual([]);
  });

  test('unknown id is undefined', () => {
    expect(graph().addSupport('n-nope', { bots: ['b1'] })).toBeUndefined();
  });
});

describe('Graph: the sensing hot path', () => {
  /** A graph.json with `count` neurons, each with words no other shares, loaded. */
  function bigGraph(count: number, extra: Array<{ id: string; text: string }> = []) {
    const at = new Date(t).toISOString();
    const neurons = [
      ...Array.from({ length: count }, (_, i) => ({
        id: `n-${i}`,
        text: `zz${i}a zz${i}b zz${i}c`,
      })),
      ...extra,
    ].map((n) => ({
      ...n,
      kind: 'fact',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
      createdAt: at,
      lastActivatedAt: at,
      activations: 0,
    }));
    writeFileSync(
      graphFiles(dir).graph,
      JSON.stringify({ version: 1, rev: 1, neurons, edges: [] })
    );
    return graph({ maxNeurons: count + extra.length + 10 });
  }

  test('findSimilarText on a 20k-neuron graph scores only the neurons that share a word', () => {
    const g = bigGraph(20_000, [
      { id: 'n-heron', text: 'the blue heron nests behind the tower' },
      { id: 'n-heron2', text: 'blue heron sighting' },
    ]);
    const found = g.findSimilarText('the blue heron nests behind the tower', 0.5);
    expect(found.map((n) => n.id)).toEqual(['n-heron']);
    expect(g.lastTextScan.scored).toBeLessThanOrEqual(2);
    g.findSimilarText('nothing matches these words', 0.5);
    expect(g.lastTextScan.scored).toBe(0);
  });

  test('findSimilarText answers exactly what a full scan answers', () => {
    const texts = [
      'Invoices from Acme arrive monthly',
      'invoices from acme arrive monthly!',
      'Acme ships on Mondays',
      'The weather is nice',
      'acme',
      'Ácme invoices',
      '...',
      '',
      'monthly invoices arrive',
    ];
    const g = graph();
    const ids = texts.map((text) => g.addNeuron(fact(text)).id);
    g.archive(ids[2]);
    g.activate(ids[2]);
    g.archive(ids[3]);
    const queries = [
      'invoices from acme',
      'Acme',
      '!!!',
      'weather nice',
      'monthly',
      'ships mondays',
    ];
    for (const q of queries) {
      for (const threshold of [0.2, 0.5, 0.8]) {
        const brute = g
          .list()
          .filter((n) => !n.archivedAt)
          .map((n) => ({ n, s: textSimilarityOf(q, n.text) }))
          .filter((x) => x.s >= threshold)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.n.id);
        expect(g.findSimilarText(q, threshold).map((n) => n.id)).toEqual(brute);
      }
    }
  });

  test('activations are written in one batch, not one append per call', () => {
    const g = graph({ activationFlushMs: 60_000 });
    const a = g.addNeuron(fact('a'));
    const b = g.addNeuron(fact('b'));
    const lines = () => readFileSync(graphFiles(dir).neurons, 'utf-8').split('\n').filter(Boolean);
    const before = lines().length;
    for (let i = 0; i < 5; i++) {
      g.activate(a.id);
      g.activate(b.id);
    }
    expect(g.get(a.id)?.activations).toBe(5);
    expect(lines().length).toBe(before);
    g.flushActivations();
    expect(lines().length).toBe(before + 2);
    const reloaded = graph();
    expect(reloaded.get(a.id)?.activations).toBe(5);
    expect(reloaded.get(b.id)?.activations).toBe(5);
  });

  test('pending activations flush on their own after a short timer', async () => {
    const g = graph({ activationFlushMs: 10 });
    const a = g.addNeuron(fact('a'));
    g.activate(a.id);
    await new Promise((r) => setTimeout(r, 40));
    expect(graph().get(a.id)?.activations).toBe(1);
  });

  test('compact() includes the pending activations', () => {
    const g = graph({ activationFlushMs: 60_000 });
    const a = g.addNeuron(fact('a'));
    g.activate(a.id);
    g.compact();
    expect(graph().get(a.id)?.activations).toBe(1);
  });

  test('automatic compaction runs off the append path and loses nothing written meanwhile', async () => {
    const g = graph({ compactEvery: 3 });
    g.addNeuron(fact('a'));
    g.addNeuron(fact('b'));
    g.addNeuron(fact('c'));
    // The third append only schedules it.
    expect(existsSync(graphFiles(dir).graph)).toBe(false);
    const late = g.addNeuron(fact('d'));
    g.setEmbedding(late.id, [1, 2]);
    await g.whenCompacted();
    expect(existsSync(graphFiles(dir).graph)).toBe(true);
    const e = g.addNeuron(fact('e'));
    const reloaded = graph();
    expect(reloaded.snapshot().neurons).toEqual(g.snapshot().neurons);
    expect(reloaded.get(e.id)?.text).toBe('e');
    expect(reloaded.getEmbedding(late.id)).toEqual([1, 2]);
  });

  test('a compaction cut short (rotated files left behind) is recovered on load', async () => {
    const g = graph({ compactEvery: 1_000_000 });
    const a = g.addNeuron(fact('a'));
    g.setEmbedding(a.id, [3, 4]);
    const files = graphFiles(dir);
    // What a crash between rotation and the snapshot rename leaves.
    writeFileSync(`${files.neurons}.old`, readFileSync(files.neurons, 'utf-8'));
    writeFileSync(`${files.embeddings}.old`, readFileSync(files.embeddings, 'utf-8'));
    writeFileSync(files.neurons, '');
    writeFileSync(files.embeddings, '');
    const reloaded = graph();
    expect(reloaded.get(a.id)?.text).toBe('a');
    expect(reloaded.getEmbedding(a.id)).toEqual([3, 4]);
    expect(existsSync(`${files.neurons}.old`)).toBe(false);
  });
});

describe('Graph.mergeInto (hygiene watcher-graph)', () => {
  test('sums activations, unions support, re-points edges and archives the rest', () => {
    const g = graph();
    const keep = g.addNeuron(
      fact('the api rate limit is 60 per minute', {
        activations: 3,
        support: { bots: ['b1'], paths: ['MEMORY.md'] },
      })
    );
    t += 1000;
    const dup = g.addNeuron(
      fact('the api rate limit is 60 per minute.', {
        activations: 2,
        support: { bots: ['b1'], paths: ['memory/2026-10-16.md'], cycles: ['c1'] },
      })
    );
    const topic = g.addNeuron({ ...fact('api'), kind: 'topic' });
    const other = g.addNeuron(fact('something else entirely'));
    g.addEdge({ from: dup.id, to: topic.id, rel: 'about', weight: 1, createdBy: 'bot:b1' });
    g.addEdge({ from: other.id, to: dup.id, rel: 'related', weight: 0.8, createdBy: 'watcher' });
    g.addEdge({ from: keep.id, to: dup.id, rel: 'related', weight: 0.95, createdBy: 'watcher' });

    const res = g.mergeInto(keep.id, [dup.id]);
    expect(res?.keeper.activations).toBe(5);
    expect(res?.keeper.support.paths?.sort()).toEqual(['MEMORY.md', 'memory/2026-10-16.md']);
    expect(res?.keeper.support.cycles).toEqual(['c1']);
    expect(res?.archived.map((n) => n.id)).toEqual([dup.id]);
    expect(g.get(dup.id)?.archivedAt).toBeDefined();
    expect(g.get(dup.id)?.meta?.mergedInto).toBe(keep.id);
    const keeperEdges = g.edgesOf(keep.id).map((e) => `${e.from}>${e.to}:${e.rel}`);
    expect(keeperEdges).toContain(`${keep.id}>${topic.id}:about`);
    expect(keeperEdges).toContain(`${other.id}>${keep.id}:related`);
    // the edge between the two merged neurons is not re-pointed onto itself
    expect(keeperEdges.filter((e) => e.startsWith(`${keep.id}>${keep.id}`))).toEqual([]);
    expect(res?.edges).toBe(2);

    // durable: a reload sees the same
    const g2 = graph();
    expect(g2.get(keep.id)?.activations).toBe(5);
    expect(g2.get(dup.id)?.archivedAt).toBeDefined();
  });

  test('undefined when the keeper is missing or archived; archived drops are skipped', () => {
    const g = graph();
    const a = g.addNeuron(fact('alpha beta'));
    const b = g.addNeuron(fact('alpha beta gamma', { activations: 4 }));
    expect(g.mergeInto('n-missing', [a.id])).toBeUndefined();
    g.archive(b.id);
    expect(g.mergeInto(a.id, [b.id])?.archived).toEqual([]);
    expect(g.get(a.id)?.activations).toBe(0);
    g.archive(a.id);
    expect(g.mergeInto(a.id, [b.id])).toBeUndefined();
  });
});
