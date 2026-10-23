/**
 * The watcher's graph: in-memory maps over append-only files
 * (`neurons.jsonl`, `edges.jsonl`, `embeddings.jsonl`; last line per id wins,
 * like `RelayStore`), compacted into `graph.json` on demand and every
 * `compactEvery` appends. Emits nothing itself: every change goes to the
 * optional `onChange` listener, which the watcher turns into socket events.
 * Loading never throws; a failed write is a warning.
 */
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { textSimilarity } from '../hygiene/text-utils';
import { cosineSimilarity } from '../memory/search';
import { type GraphFiles, graphFiles } from './paths';
import {
  type ActivationData,
  type Edge,
  type EdgeRel,
  type Neuron,
  type NeuronCreator,
  type NeuronKind,
  type Vec3,
  emptyCounts,
} from './types';

export type GraphChange =
  | { type: 'neuron'; neuron: Neuron }
  | { type: 'edge'; edge: Edge }
  | { type: 'activate'; activation: ActivationData };

export interface GraphOptions {
  now?: () => number;
  maxNeurons?: number;
  compactEvery?: number;
  onChange?: (change: GraphChange) => void;
  logger?: { warn: (obj: object, msg: string) => void };
}

export type NewNeuron = Pick<Neuron, 'kind' | 'text' | 'support' | 'createdBy'> &
  Partial<Pick<Neuron, 'confidence' | 'pos' | 'meta' | 'activations' | 'lastActivatedAt'>>;

export interface NewEdge {
  from: string;
  to: string;
  rel: EdgeRel;
  weight: number;
  createdBy: NeuronCreator;
}

export interface GraphSnapshot {
  neurons: Neuron[];
  edges: Edge[];
  rev: number;
}

const DEFAULT_MAX = 20_000;
const DEFAULT_COMPACT_EVERY = 1000;

export class Graph {
  private neurons = new Map<string, Neuron>();
  private edges = new Map<string, Edge>();
  private embeddings = new Map<string, number[]>();
  private byKey = new Map<string, string>();
  private edgeByKey = new Map<string, string>();
  private adjacency = new Map<string, Set<string>>();
  private rev = 0;
  private appends = 0;
  private readonly files: GraphFiles;
  private readonly now: () => number;
  onChange?: (change: GraphChange) => void;

  constructor(
    readonly dir: string,
    private readonly opts: GraphOptions = {}
  ) {
    this.files = graphFiles(dir);
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange;
  }

  /** Read `graph.json` and replay the append files on top. Never throws. */
  load(): void {
    this.neurons.clear();
    this.edges.clear();
    this.embeddings.clear();
    this.byKey.clear();
    this.edgeByKey.clear();
    this.adjacency.clear();
    try {
      if (existsSync(this.files.graph)) {
        const parsed = JSON.parse(
          readFileSync(this.files.graph, 'utf-8')
        ) as Partial<GraphSnapshot>;
        for (const n of parsed.neurons ?? []) if (validNeuron(n)) this.putNeuron(n);
        for (const e of parsed.edges ?? []) if (validEdge(e)) this.putEdge(e);
        this.rev = typeof parsed.rev === 'number' ? parsed.rev : 0;
      }
    } catch (err) {
      this.opts.logger?.warn(
        { err },
        'Watcher graph: graph.json unreadable, starting from the append files'
      );
    }
    for (const n of readLines<Neuron>(this.files.neurons)) if (validNeuron(n)) this.putNeuron(n);
    for (const e of readLines<Edge>(this.files.edges)) if (validEdge(e)) this.putEdge(e);
    for (const row of readLines<{ id: string; v: number[] }>(this.files.embeddings)) {
      if (row && typeof row.id === 'string' && Array.isArray(row.v))
        this.embeddings.set(row.id, row.v);
    }
  }

  get(id: string): Neuron | undefined {
    return this.neurons.get(id);
  }

  findByKey(key: string): Neuron | undefined {
    const id = this.byKey.get(key);
    return id ? this.neurons.get(id) : undefined;
  }

  list(): Neuron[] {
    return [...this.neurons.values()];
  }

  size(): number {
    return this.neurons.size;
  }

  liveCount(): number {
    let n = 0;
    for (const x of this.neurons.values()) if (!x.archivedAt) n++;
    return n;
  }

  edgeCount(): number {
    return this.edges.size;
  }

  counts(): Record<NeuronKind, number> {
    const out = emptyCounts();
    for (const n of this.neurons.values()) if (!n.archivedAt) out[n.kind]++;
    return out;
  }

  getRev(): number {
    return this.rev;
  }

  addNeuron(input: NewNeuron): Neuron {
    const at = this.iso();
    const neuron: Neuron = {
      id: this.newId('n-', this.neurons),
      kind: input.kind,
      text: input.text,
      support: input.support,
      createdBy: input.createdBy,
      createdAt: at,
      lastActivatedAt: input.lastActivatedAt ?? at,
      activations: input.activations ?? 0,
      ...(input.confidence ? { confidence: input.confidence } : {}),
      ...(input.pos ? { pos: input.pos } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    this.writeNeuron(neuron);
    this.enforceCap(neuron.id);
    return neuron;
  }

  /** The existing edge for the same from/to/rel (`related` either way), or a new one. */
  addEdge(input: NewEdge): Edge {
    const key = edgeKey(input.from, input.to, input.rel);
    const existing = this.edgeByKey.get(key);
    if (existing) return this.edges.get(existing) as Edge;
    const edge: Edge = {
      id: this.newId('e-', this.edges),
      from: input.from,
      to: input.to,
      rel: input.rel,
      weight: input.weight,
      createdAt: this.iso(),
      createdBy: input.createdBy,
    };
    this.putEdge(edge);
    this.append(this.files.edges, edge);
    this.rev++;
    this.emit({ type: 'edge', edge });
    return edge;
  }

  /** One activation now. An archived neuron that fires again is live again. */
  activate(id: string): Neuron | undefined {
    const n = this.neurons.get(id);
    if (!n) return undefined;
    const { archivedAt: _gone, ...rest } = n;
    const next: Neuron = { ...rest, activations: n.activations + 1, lastActivatedAt: this.iso() };
    this.writeNeuron(next, false);
    if (n.archivedAt) this.emit({ type: 'neuron', neuron: next });
    this.emitActivation(next);
    return next;
  }

  /** Set activations from history (birth), not a new firing. */
  setActivation(id: string, activations: number, lastActivatedAt: string): Neuron | undefined {
    const n = this.neurons.get(id);
    if (!n) return undefined;
    const next: Neuron = { ...n, activations, lastActivatedAt };
    this.writeNeuron(next, false);
    this.emitActivation(next);
    return next;
  }

  archive(id: string): Neuron | undefined {
    const n = this.neurons.get(id);
    if (!n || n.archivedAt) return n;
    const next: Neuron = { ...n, archivedAt: this.iso() };
    this.writeNeuron(next);
    return next;
  }

  /** Archive every live neuron that has not fired within `olderThanMs`. */
  archiveInactive(olderThanMs: number): Neuron[] {
    const cutoff = this.now() - olderThanMs;
    const out: Neuron[] = [];
    for (const n of [...this.neurons.values()]) {
      if (n.archivedAt) continue;
      if (Date.parse(n.lastActivatedAt) < cutoff) {
        const archived = this.archive(n.id);
        if (archived) out.push(archived);
      }
    }
    return out;
  }

  /** Positions for many neurons at once, then one compaction instead of a line per neuron. */
  setPositions(positions: Map<string, Vec3>): void {
    for (const [id, pos] of positions) {
      const n = this.neurons.get(id);
      if (n) this.neurons.set(id, { ...n, pos });
    }
    this.rev++;
    this.compact();
  }

  edgesOf(id: string): Edge[] {
    return [...(this.adjacency.get(id) ?? [])]
      .map((eid) => this.edges.get(eid))
      .filter((e): e is Edge => !!e);
  }

  neighbours(id: string): Array<{ neuron: Neuron; edge: Edge }> {
    const out: Array<{ neuron: Neuron; edge: Edge }> = [];
    for (const edge of this.edgesOf(id)) {
      const other = this.neurons.get(edge.from === id ? edge.to : edge.from);
      if (other) out.push({ neuron: other, edge });
    }
    return out;
  }

  findSimilarText(text: string, threshold: number): Neuron[] {
    const scored: Array<{ n: Neuron; s: number }> = [];
    for (const n of this.neurons.values()) {
      if (n.archivedAt) continue;
      const s = textSimilarity(text, n.text);
      if (s >= threshold) scored.push({ n, s });
    }
    return scored.sort((a, b) => b.s - a.s).map((x) => x.n);
  }

  findSimilarEmbedding(vec: number[], threshold: number): Array<{ neuron: Neuron; score: number }> {
    const out: Array<{ neuron: Neuron; score: number }> = [];
    for (const [id, v] of this.embeddings) {
      const n = this.neurons.get(id);
      if (!n || n.archivedAt || v.length !== vec.length) continue;
      const score = cosineSimilarity(vec, v);
      if (score >= threshold) out.push({ neuron: n, score });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  setEmbedding(id: string, vec: number[]): void {
    if (!this.neurons.has(id)) return;
    this.embeddings.set(id, vec);
    this.append(this.files.embeddings, { id, v: vec });
  }

  getEmbedding(id: string): number[] | undefined {
    return this.embeddings.get(id);
  }

  embeddedIds(): string[] {
    return [...this.embeddings.keys()].filter((id) => this.neurons.has(id));
  }

  /** Neurons and edges without embeddings (the socket and route shape). */
  snapshot(): GraphSnapshot {
    return {
      neurons: [...this.neurons.values()].map((n) => ({ ...n })),
      edges: [...this.edges.values()].map((e) => ({ ...e })),
      rev: this.rev,
    };
  }

  /** Write `graph.json` and the embeddings, then empty the append files. */
  compact(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const { neurons, edges, rev } = this.snapshot();
      atomicWrite(this.files.graph, JSON.stringify({ version: 1, rev, neurons, edges }));
      const emb = [...this.embeddings]
        .filter(([id]) => this.neurons.has(id))
        .map(([id, v]) => JSON.stringify({ id, v }))
        .join('\n');
      atomicWrite(this.files.embeddings, emb ? `${emb}\n` : '');
      writeFileSync(this.files.neurons, '');
      writeFileSync(this.files.edges, '');
      this.appends = 0;
    } catch (err) {
      this.opts.logger?.warn({ err }, 'Watcher graph: compaction failed');
    }
  }

  // ── internals ──

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private newId(prefix: string, taken: Map<string, unknown>): string {
    for (;;) {
      const id = `${prefix}${randomBytes(4).toString('hex')}`;
      if (!taken.has(id)) return id;
    }
  }

  private writeNeuron(n: Neuron, notify = true): void {
    this.putNeuron(n);
    this.append(this.files.neurons, n);
    this.rev++;
    if (notify) this.emit({ type: 'neuron', neuron: n });
  }

  private putNeuron(n: Neuron): void {
    this.neurons.set(n.id, n);
    const key = n.meta?.key;
    if (key) this.byKey.set(key, n.id);
  }

  private putEdge(e: Edge): void {
    this.edges.set(e.id, e);
    this.edgeByKey.set(edgeKey(e.from, e.to, e.rel), e.id);
    for (const end of [e.from, e.to]) {
      const set = this.adjacency.get(end) ?? new Set<string>();
      set.add(e.id);
      this.adjacency.set(end, set);
    }
  }

  private emitActivation(n: Neuron): void {
    this.emit({
      type: 'activate',
      activation: { id: n.id, activations: n.activations, lastActivatedAt: n.lastActivatedAt },
    });
  }

  private emit(change: GraphChange): void {
    try {
      this.onChange?.(change);
    } catch (err) {
      this.opts.logger?.warn({ err }, 'Watcher graph: change listener threw');
    }
  }

  private enforceCap(keep: string): void {
    const max = this.opts.maxNeurons ?? DEFAULT_MAX;
    let live = this.liveCount();
    while (live > max) {
      let oldest: Neuron | undefined;
      for (const n of this.neurons.values()) {
        if (n.archivedAt || n.id === keep) continue;
        if (!oldest || n.lastActivatedAt < oldest.lastActivatedAt) oldest = n;
      }
      if (!oldest) return;
      this.archive(oldest.id);
      live--;
    }
  }

  private append(path: string, row: unknown): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf-8');
    } catch (err) {
      this.opts.logger?.warn({ err, path }, 'Watcher graph: append failed');
      return;
    }
    this.appends++;
    if (this.appends >= (this.opts.compactEvery ?? DEFAULT_COMPACT_EVERY)) this.compact();
  }
}

function edgeKey(from: string, to: string, rel: EdgeRel): string {
  if (rel === 'related' && to < from) return `${to}|${from}|${rel}`;
  return `${from}|${to}|${rel}`;
}

function readLines<T>(path: string): T[] {
  try {
    if (!existsSync(path)) return [];
    const out: T[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // skip
      }
    }
    return out;
  } catch {
    return [];
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

function validNeuron(n: unknown): n is Neuron {
  const x = n as Neuron;
  return (
    !!x && typeof x.id === 'string' && typeof x.kind === 'string' && typeof x.text === 'string'
  );
}

function validEdge(e: unknown): e is Edge {
  const x = e as Edge;
  return !!x && typeof x.id === 'string' && typeof x.from === 'string' && typeof x.to === 'string';
}
