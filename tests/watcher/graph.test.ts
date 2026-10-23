import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  test('compacts on its own every compactEvery appends', () => {
    const g = graph({ compactEvery: 3 });
    g.addNeuron(fact('a'));
    g.addNeuron(fact('b'));
    expect(existsSync(graphFiles(dir).graph)).toBe(false);
    g.addNeuron(fact('c'));
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
