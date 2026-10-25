/**
 * The watcher's graph: in-memory maps over append-only files
 * (`neurons.jsonl`, `edges.jsonl`, `embeddings.jsonl`; last line per id wins,
 * like `RelayStore`), compacted into `graph.json` on demand and every
 * `compactEvery` appends. Emits nothing itself: every change goes to the
 * optional `onChange` listener, which the watcher turns into socket events.
 * Loading never throws; a failed write is a warning.
 *
 * Built for the sensing hot path (every activity event touches it):
 * - `findSimilarText` scores only the neurons that share a word with the
 *   query, through an inverted index (word → live neuron ids) and cached
 *   word sets kept up to date on every write and archive; same answers as a
 *   full `textSimilarity` scan (`lastTextScan` says how many were scored).
 * - activations (`activate`, `setActivation`) change memory at once and reach
 *   `neurons.jsonl` in one batched append every `activationFlushMs`
 *   (`flushActivations`; `compact()` includes them).
 * - automatic compaction is scheduled off the append path and writes
 *   asynchronously: the append files are rotated to `*.old` first, so what is
 *   appended meanwhile is kept; `load()` replays `*.old` and finishes a
 *   compaction a crash cut short. `compact()` stays synchronous (stop, layout).
 */
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { normalizeTitle, textSimilarity } from '../hygiene/text-utils';
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
  | { type: 'activate'; activation: ActivationData }
  /** One batched change for a relayout (`setPositions`): neuron id → new position. */
  | { type: 'layout'; positions: Record<string, Vec3> };

export interface GraphOptions {
  now?: () => number;
  maxNeurons?: number;
  compactEvery?: number;
  /** How long activations wait in memory before one batched append (default 1 s). */
  activationFlushMs?: number;
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
const DEFAULT_ACTIVATION_FLUSH_MS = 1000;
/** The postings key of a neuron whose text has no words (`textSimilarity` of two such texts is 1). */
const NO_WORDS = '';

interface TextEntry {
  norm: string;
  words: Set<string>;
}

function textEntry(text: string): TextEntry {
  const norm = normalizeTitle(text);
  return { norm, words: new Set(norm.split(' ').filter(Boolean)) };
}

export class Graph {
  private neurons = new Map<string, Neuron>();
  private edges = new Map<string, Edge>();
  private embeddings = new Map<string, number[]>();
  private byKey = new Map<string, string>();
  private edgeByKey = new Map<string, string>();
  private adjacency = new Map<string, Set<string>>();
  /** Live neurons only: cached words and the inverted index over them. */
  private textOf = new Map<string, TextEntry>();
  private postings = new Map<string, Set<string>>();
  /** First-seen order of every neuron (ties in `findSimilarText` keep it, like a full scan). */
  private seq = new Map<string, number>();
  private nextSeq = 0;
  private live = 0;
  private pendingActivations = new Set<string>();
  private activationTimer: ReturnType<typeof setTimeout> | null = null;
  private compactPending: Promise<void> | null = null;
  private compactGen = 0;
  private rev = 0;
  private appends = 0;
  /** How many neurons the last `findSimilarText` scored (the candidates sharing a word). */
  lastTextScan = { scored: 0 };
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
    this.textOf.clear();
    this.postings.clear();
    this.seq.clear();
    this.nextSeq = 0;
    this.live = 0;
    this.pendingActivations.clear();
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
    // A compaction in flight (or cut short) left its rotated files: replay them first.
    const rotated = [this.files.neurons, this.files.edges, this.files.embeddings].map(oldFile);
    for (const path of [rotated[0], this.files.neurons]) {
      for (const n of readLines<Neuron>(path)) if (validNeuron(n)) this.putNeuron(n);
    }
    for (const path of [rotated[1], this.files.edges]) {
      for (const e of readLines<Edge>(path)) if (validEdge(e)) this.putEdge(e);
    }
    for (const path of [rotated[2], this.files.embeddings]) {
      for (const row of readLines<{ id: string; v: number[] }>(path)) {
        if (row && typeof row.id === 'string' && Array.isArray(row.v))
          this.embeddings.set(row.id, row.v);
      }
    }
    if (rotated.some((path) => existsSync(path))) this.compact();
  }

  get(id: string): Neuron | undefined {
    return this.neurons.get(id);
  }

  findByKey(key: string): Neuron | undefined {
    const id = this.byKey.get(key);
    return id ? this.resolveMerged(id) : undefined;
  }

  /** The neuron, or the keeper a merge folded it into (following a chain of merges). */
  private resolveMerged(id: string): Neuron | undefined {
    let n = this.neurons.get(id);
    for (let hops = 0; n?.archivedAt && n.meta?.mergedInto && hops < 10; hops++) {
      const next = this.neurons.get(n.meta.mergedInto);
      if (!next) break;
      n = next;
    }
    return n;
  }

  list(): Neuron[] {
    return [...this.neurons.values()];
  }

  size(): number {
    return this.neurons.size;
  }

  liveCount(): number {
    return this.live;
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

  /**
   * One activation now. An archived neuron that fires again is live again; a
   * merged drop never is: its keeper fires instead. Written in a batch.
   */
  activate(id: string): Neuron | undefined {
    const n = this.resolveMerged(id);
    if (!n) return undefined;
    const { archivedAt: _gone, ...rest } = n;
    const at = this.iso();
    // O10: a neuron forgetting archived (`archivedReason`) that fires again
    // came back: `returnedAt` is what metric 5 counts.
    const returned = !!n.archivedAt && !!n.meta?.archivedReason;
    const next: Neuron = {
      ...rest,
      activations: n.activations + 1,
      lastActivatedAt: at,
      ...(returned ? { meta: { ...(n.meta ?? {}), returnedAt: at } } : {}),
    };
    this.queueActivation(next);
    if (n.archivedAt) this.emit({ type: 'neuron', neuron: next });
    this.emitActivation(next);
    return next;
  }

  /** Set activations from history (birth), not a new firing. Written in a batch. */
  setActivation(id: string, activations: number, lastActivatedAt: string): Neuron | undefined {
    const n = this.neurons.get(id);
    if (!n) return undefined;
    const next: Neuron = { ...n, activations, lastActivatedAt };
    this.queueActivation(next);
    this.emitActivation(next);
    return next;
  }

  /** Append every pending activation in one write. Never throws. */
  flushActivations(): void {
    if (this.activationTimer) clearTimeout(this.activationTimer);
    this.activationTimer = null;
    if (this.pendingActivations.size === 0) return;
    const rows = [...this.pendingActivations]
      .map((id) => this.neurons.get(id))
      .filter((n): n is Neuron => !!n);
    this.pendingActivations.clear();
    this.appendRows(this.files.neurons, rows);
  }

  /** Resolves when the scheduled automatic compaction (if any) has finished. */
  whenCompacted(): Promise<void> {
    return this.compactPending ?? Promise.resolve();
  }

  /** Merge attributes into a neuron's `meta` (signals, prediction resolutions). Not a firing. */
  patchMeta(id: string, patch: Record<string, string>): Neuron | undefined {
    const n = this.neurons.get(id);
    if (!n) return undefined;
    const next: Neuron = { ...n, meta: { ...(n.meta ?? {}), ...patch } };
    this.writeNeuron(next);
    return next;
  }

  /**
   * Union `bots` and `cycles` into a neuron's support (a later notice pass
   * recognised it from other bots). Not a firing; a no-op when nothing is new.
   */
  addSupport(id: string, add: { bots?: string[]; cycles?: string[] }): Neuron | undefined {
    const n = this.neurons.get(id);
    if (!n) return undefined;
    const bots = [...new Set([...n.support.bots, ...(add.bots ?? [])])];
    const cycles = [...new Set([...(n.support.cycles ?? []), ...(add.cycles ?? [])])];
    if (
      bots.length === n.support.bots.length &&
      cycles.length === (n.support.cycles ?? []).length
    ) {
      return n;
    }
    const next: Neuron = {
      ...n,
      support: { ...n.support, bots, ...(cycles.length ? { cycles } : {}) },
    };
    this.writeNeuron(next);
    return next;
  }

  /** Remove attributes from a neuron's `meta`. Not a firing; a no-op when none is set. */
  dropMeta(id: string, keys: string[]): Neuron | undefined {
    const n = this.neurons.get(id);
    if (!n) return undefined;
    if (!n.meta || !keys.some((k) => k in (n.meta ?? {}))) return n;
    const meta = { ...n.meta };
    for (const k of keys) delete meta[k];
    const next: Neuron = { ...n, meta };
    this.writeNeuron(next);
    return next;
  }

  /** Archive a live neuron; `meta` is merged in the same write (O10: `archivedReason`). */
  archive(id: string, meta?: Record<string, string>): Neuron | undefined {
    const n = this.neurons.get(id);
    if (!n || n.archivedAt) return n;
    const next: Neuron = {
      ...n,
      archivedAt: this.iso(),
      ...(meta ? { meta: { ...(n.meta ?? {}), ...meta } } : {}),
    };
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

  /**
   * Fold near-duplicates into `keepId` (hygiene `watcher-graph`): the keeper's
   * activations become the sum, its support the union, every edge of a
   * dropped neuron is re-created on the keeper (`addEdge` dedupes; edges
   * between the merged neurons are not re-pointed onto the keeper), and each
   * dropped neuron is archived with `meta.mergedInto`. A keeper without a
   * `meta.key` takes a drop's; any other drop key resolves to the keeper
   * (`findByKey`), and activating a drop fires the keeper. Archived or unknown
   * drops are skipped. Undefined when the keeper is missing or archived. Not a firing.
   */
  mergeInto(
    keepId: string,
    dropIds: string[]
  ): { keeper: Neuron; archived: Neuron[]; edges: number } | undefined {
    const keep = this.neurons.get(keepId);
    if (!keep || keep.archivedAt) return undefined;
    const drops = [...new Set(dropIds)]
      .filter((id) => id !== keepId)
      .map((id) => this.neurons.get(id))
      .filter((n): n is Neuron => !!n && !n.archivedAt);
    if (drops.length === 0) return { keeper: keep, archived: [], edges: 0 };
    const merged = new Set([keepId, ...drops.map((d) => d.id)]);
    const union = (pick: (s: Neuron['support']) => string[] | undefined) => {
      const all = [keep, ...drops].flatMap((n) => pick(n.support) ?? []);
      return all.length ? [...new Set(all)] : undefined;
    };
    const support: Neuron['support'] = { bots: union((s) => s.bots) ?? [] };
    const cycles = union((s) => s.cycles);
    const conversations = union((s) => s.conversations);
    const paths = union((s) => s.paths);
    if (cycles) support.cycles = cycles;
    if (conversations) support.conversations = conversations;
    if (paths) support.paths = paths;
    const lastActivatedAt = [keep, ...drops]
      .map((n) => n.lastActivatedAt)
      .reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
    // A keeper without a key takes the first drop's: the key then answers
    // for the keeper (a drop's other key does too, through `mergedInto`).
    const movedKey = keep.meta?.key ? undefined : drops.find((d) => d.meta?.key)?.meta?.key;
    const keeper: Neuron = {
      ...keep,
      support,
      activations: keep.activations + drops.reduce((sum, d) => sum + d.activations, 0),
      lastActivatedAt,
      ...(movedKey ? { meta: { ...(keep.meta ?? {}), key: movedKey } } : {}),
    };
    this.writeNeuron(keeper);
    let edges = 0;
    for (const drop of drops) {
      for (const e of this.edgesOf(drop.id)) {
        const other = e.from === drop.id ? e.to : e.from;
        if (merged.has(other)) continue;
        const before = this.edges.size;
        this.addEdge({
          from: e.from === drop.id ? keepId : e.from,
          to: e.to === drop.id ? keepId : e.to,
          rel: e.rel,
          weight: e.weight,
          createdBy: e.createdBy,
        });
        if (this.edges.size > before) edges++;
      }
    }
    const archived: Neuron[] = [];
    const at = this.iso();
    for (const drop of drops) {
      const { key, ...rest } = drop.meta ?? {};
      const meta = {
        ...rest,
        ...(key && key !== movedKey ? { key } : {}),
        mergedInto: keepId,
      };
      const next: Neuron = { ...drop, archivedAt: at, meta };
      this.writeNeuron(next);
      archived.push(next);
    }
    return { keeper: this.neurons.get(keepId) ?? keeper, archived, edges };
  }

  /**
   * Positions for many neurons at once, then one compaction instead of a line
   * per neuron, and one `layout` change (not one per neuron: a relayout moves
   * up to `maxNeurons`) with the positions applied to known neurons.
   */
  setPositions(positions: Map<string, Vec3>): void {
    const applied: Record<string, Vec3> = {};
    let moved = 0;
    for (const [id, pos] of positions) {
      const n = this.neurons.get(id);
      if (!n) continue;
      this.neurons.set(id, { ...n, pos });
      applied[id] = pos;
      moved++;
    }
    this.rev++;
    this.compact();
    if (moved > 0) this.emit({ type: 'layout', positions: applied });
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

  /**
   * Live neurons whose text is at least `threshold` similar (`textSimilarity`),
   * best first. Only the neurons sharing a word with `text` are scored.
   */
  findSimilarText(text: string, threshold: number): Neuron[] {
    if (threshold <= 0) return this.scanSimilarText(text, threshold);
    const q = textEntry(text);
    const counts = new Map<string, number>();
    if (q.words.size === 0) {
      for (const id of this.postings.get(NO_WORDS) ?? []) counts.set(id, 0);
    } else {
      for (const w of q.words) {
        for (const id of this.postings.get(w) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    this.lastTextScan = { scored: counts.size };
    const scored: Array<{ n: Neuron; s: number; seq: number }> = [];
    for (const [id, shared] of counts) {
      const entry = this.textOf.get(id);
      const n = this.neurons.get(id);
      if (!entry || !n) continue;
      const union = q.words.size + entry.words.size - shared;
      const s = entry.norm === q.norm ? 1 : union === 0 ? 0 : shared / union;
      if (s >= threshold) scored.push({ n, s, seq: this.seq.get(id) ?? 0 });
    }
    return scored.sort((a, b) => b.s - a.s || a.seq - b.seq).map((x) => x.n);
  }

  /** The full scan (`threshold <= 0` matches every live neuron). */
  private scanSimilarText(text: string, threshold: number): Neuron[] {
    const scored: Array<{ n: Neuron; s: number }> = [];
    for (const n of this.neurons.values()) {
      if (n.archivedAt) continue;
      const s = textSimilarity(text, n.text);
      if (s >= threshold) scored.push({ n, s });
    }
    this.lastTextScan = { scored: scored.length };
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

  /** Write `graph.json` and the embeddings, then empty the append files. Synchronous. */
  compact(): void {
    // Everything pending is in memory, so in the snapshot; an async compaction
    // in flight sees the bumped generation and discards its result.
    this.compactGen++;
    this.pendingActivations.clear();
    if (this.activationTimer) clearTimeout(this.activationTimer);
    this.activationTimer = null;
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
      for (const f of [this.files.neurons, this.files.edges, this.files.embeddings]) {
        removeIfExists(oldFile(f));
      }
      this.appends = 0;
    } catch (err) {
      this.opts.logger?.warn({ err }, 'Watcher graph: compaction failed');
    }
  }

  /** The automatic compaction, off the append path (next macrotask), one at a time. */
  private scheduleCompact(): void {
    if (this.compactPending) return;
    this.compactPending = new Promise<void>((resolve) => {
      setImmediate(() => {
        this.compactAsync()
          .catch((err) => this.opts.logger?.warn({ err }, 'Watcher graph: compaction failed'))
          .finally(() => {
            this.compactPending = null;
            resolve();
          });
      });
    });
  }

  /**
   * Rotate the append files to `*.old` (new appends go to fresh files),
   * snapshot memory, write it asynchronously, then (synchronously) put the
   * snapshot in place, keep the embeddings appended meanwhile and drop the
   * rotated files. A synchronous `compact()` in between wins.
   */
  private async compactAsync(): Promise<void> {
    this.flushActivations();
    const files = [this.files.neurons, this.files.edges, this.files.embeddings];
    if (files.some((f) => existsSync(oldFile(f)))) {
      this.compact();
      return;
    }
    const gen = ++this.compactGen;
    mkdirSync(this.dir, { recursive: true });
    for (const f of files) if (existsSync(f)) renameSync(f, oldFile(f));
    this.appends = 0;
    const { neurons, edges, rev } = this.snapshot();
    const graphJson = JSON.stringify({ version: 1, rev, neurons, edges });
    const emb = [...this.embeddings]
      .filter(([id]) => this.neurons.has(id))
      .map(([id, v]) => JSON.stringify({ id, v }))
      .join('\n');
    const graphTmp = `${this.files.graph}.tmp-${process.pid}-${gen}`;
    const embTmp = `${this.files.embeddings}.tmp-${process.pid}-${gen}`;
    try {
      await writeFile(graphTmp, graphJson, 'utf-8');
      await writeFile(embTmp, emb ? `${emb}\n` : '', 'utf-8');
      if (gen !== this.compactGen) return;
      if (existsSync(this.files.embeddings)) {
        appendFileSync(embTmp, readFileSync(this.files.embeddings, 'utf-8'), 'utf-8');
      }
      renameSync(graphTmp, this.files.graph);
      renameSync(embTmp, this.files.embeddings);
      for (const f of files) removeIfExists(oldFile(f));
    } finally {
      removeIfExists(graphTmp);
      removeIfExists(embTmp);
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
    this.pendingActivations.delete(n.id);
    this.append(this.files.neurons, n);
    this.rev++;
    if (notify) this.emit({ type: 'neuron', neuron: n });
  }

  private queueActivation(n: Neuron): void {
    this.putNeuron(n);
    this.rev++;
    this.pendingActivations.add(n.id);
    if (this.activationTimer) return;
    const timer = setTimeout(
      () => this.flushActivations(),
      this.opts.activationFlushMs ?? DEFAULT_ACTIVATION_FLUSH_MS
    );
    (timer as { unref?: () => void }).unref?.();
    this.activationTimer = timer;
  }

  private putNeuron(n: Neuron): void {
    const prev = this.neurons.get(n.id);
    this.neurons.set(n.id, n);
    if (!this.seq.has(n.id)) this.seq.set(n.id, this.nextSeq++);
    const key = n.meta?.key;
    // A merged drop's key answers for its keeper (`findByKey` follows the chain).
    if (key) this.byKey.set(key, (n.archivedAt && n.meta?.mergedInto) || n.id);
    const wasLive = !!prev && !prev.archivedAt;
    const isLive = !n.archivedAt;
    this.live += (isLive ? 1 : 0) - (wasLive ? 1 : 0);
    if (wasLive && isLive && prev?.text === n.text) return;
    if (wasLive) this.unindexText(n.id);
    if (isLive) this.indexText(n.id, n.text);
  }

  private indexText(id: string, text: string): void {
    const entry = textEntry(text);
    this.textOf.set(id, entry);
    const keys = entry.words.size > 0 ? entry.words : [NO_WORDS];
    for (const w of keys) {
      const set = this.postings.get(w) ?? new Set<string>();
      set.add(id);
      this.postings.set(w, set);
    }
  }

  private unindexText(id: string): void {
    const entry = this.textOf.get(id);
    if (!entry) return;
    this.textOf.delete(id);
    const keys = entry.words.size > 0 ? entry.words : [NO_WORDS];
    for (const w of keys) {
      const set = this.postings.get(w);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.postings.delete(w);
    }
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
    this.appendRows(path, [row]);
  }

  private appendRows(path: string, rows: unknown[]): void {
    if (rows.length === 0) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf-8');
    } catch (err) {
      this.opts.logger?.warn({ err, path }, 'Watcher graph: append failed');
      return;
    }
    this.appends += rows.length;
    if (this.appends >= (this.opts.compactEvery ?? DEFAULT_COMPACT_EVERY)) this.scheduleCompact();
  }
}

/** Where an append file goes while a compaction runs. */
function oldFile(path: string): string {
  return `${path}.old`;
}

function removeIfExists(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort cleanup
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
