/**
 * The fleet watcher's shared contract (docs/plans/watcher-implementation-plan.md,
 * phase 1). The dashboard page builds against these shapes: add fields, never
 * rename or remove them.
 */
import type { ActivityEvent } from '../bot/activity-stream';
import type { HumanInboundEvent } from '../bot/agent-loop-utils';

export const NEURON_KINDS = [
  'entity',
  'person',
  'goal',
  'topic',
  'fact',
  'surprise',
  'question',
  'pattern',
  'insight',
  'contradiction',
  'prediction',
] as const;
export type NeuronKind = (typeof NEURON_KINDS)[number];

export const EDGE_RELS = [
  'knows',
  'owned_by',
  'about',
  'related',
  'contradicts',
  'caused',
  'serves',
  'predicts',
] as const;
export type EdgeRel = (typeof EDGE_RELS)[number];

export type Confidence = 'low' | 'medium' | 'high';
export type Vec3 = [number, number, number];
/** `watcher`, or the bot that brought the knowledge (`bot:<id>`). */
export type NeuronCreator = 'watcher' | `bot:${string}`;

export interface NeuronSupport {
  bots: string[];
  cycles?: string[];
  conversations?: string[];
  paths?: string[];
}

/** A unit of information the watcher decided to keep (never a raw event). Embeddings live apart. */
export interface Neuron {
  /** `n-` + 8 hex. */
  id: string;
  kind: NeuronKind;
  text: string;
  support: NeuronSupport;
  createdBy: NeuronCreator;
  createdAt: string;
  lastActivatedAt: string;
  activations: number;
  confidence?: Confidence;
  /** Position inside the unit ball, computed server-side (`layout.ts`). */
  pos?: Vec3;
  archivedAt?: string;
  /** Free attributes. `key` is the stable identity birth and resync dedupe on. */
  meta?: Record<string, string>;
}

export interface Edge {
  /** `e-` + 8 hex. */
  id: string;
  from: string;
  to: string;
  rel: EdgeRel;
  weight: number;
  createdAt: string;
  createdBy: NeuronCreator;
}

export const WATCHER_PHASES = [
  'birth',
  'sense',
  'notice',
  'integrate',
  'broadcast',
  'sleep',
] as const;
export type WatcherPhase = (typeof WATCHER_PHASES)[number];

export interface WatcherLogRow {
  ts: string;
  /** Monotonic across days and restarts. */
  seq: number;
  phase: WatcherPhase;
  op: string;
  /** First-person English written by code, never by an LLM. */
  text: string;
  neuronIds?: string[];
  edgeIds?: string[];
  salience?: number;
  source?: string;
  model?: string;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
  /** Phase 4, `integrate:pass` only: the "How I am" variables the model named (known keys only). */
  drivenBy?: string[];
}

/** What tier 0 senses: an activity-stream event or a `human_inbound` hook event. */
export type SensedEvent = ActivityEvent | HumanInboundEvent;

export interface BufferItem {
  id: string;
  event: SensedEvent;
  salience: number;
  reasons: string[];
  /** ISO time tier 0 saw the event (metric 2 compares it with the event's own time). */
  noticedAt: string;
  touched: string[];
  /** The operator wrote it (only then may notice keep its words as a fact). */
  fromOperator?: true;
}

/** `partial`: some neurons embedded, then an embedding error stopped the run; start/maintenance continue it. */
export type LinkStatus = 'ok' | 'partial' | 'no-embeddings' | 'pending';

export interface WatcherState {
  running: boolean;
  bornAt?: string;
  phase: WatcherPhase;
  lastTickAt?: string;
  counts: Record<NeuronKind, number>;
  edges: number;
  linkStatus: LinkStatus;
  lastError?: string;
  /** Phase 3: neuron ids the last integrate pass said it attends to (`Integrator.attending`). */
  attending?: string[];
  /** When the last integrate pass set `attending`. */
  attendingAt?: string;
  /** Whether the notice and integrate timers are running now (`Watcher.applyConfig`). */
  timers?: { notice: boolean; integrate: boolean };
  /**
   * The live tier switches and daily caps (`tierSwitches`): every state
   * publish carries them, so a change made in one dashboard tab
   * (`POST /api/watcher/config` → `applyConfig`) reaches the others.
   */
  tiers?: Record<'notice' | 'integrate', { enabled: boolean; maxPerDay: number }>;
}

export type WatcherEventType =
  | 'watcher:log'
  | 'watcher:neuron'
  | 'watcher:edge'
  | 'watcher:activate'
  | 'watcher:layout'
  | 'watcher:state';

/**
 * What `/ws/watcher` carries: `data` is the row, neuron, edge, activation,
 * state, or for `watcher:layout` `{ positions: { [neuronId]: [x, y, z] } }`.
 */
export interface WatcherEvent {
  type: WatcherEventType;
  ts: string;
  data: unknown;
}

export interface ActivationData {
  id: string;
  activations: number;
  lastActivatedAt: string;
}

export const BIRTH_STAGES = [
  'wake',
  'fleet',
  'people',
  'goals',
  'knowledge',
  'memory',
  'history',
  'link',
  'done',
] as const;
export type BirthStage = (typeof BIRTH_STAGES)[number];

/** `<data>/watcher/birth.json`, written after every stage so a restart resumes. */
export interface BirthRecord {
  stage: BirthStage;
  done: BirthStage[];
  startedAt: string;
  finishedAt?: string;
  counts: Partial<Record<NeuronKind, number>> & { edges?: number };
  unreadable: string[];
  linkStatus?: LinkStatus;
}

export interface WatcherConfig {
  enabled: boolean;
  notice: {
    enabled: boolean;
    backend: 'claude-cli' | 'ollama';
    model: string;
    everyMs: number;
    salienceBar: number;
    maxPerDay: number;
  };
  integrate: {
    enabled: boolean;
    model: string;
    salienceBar: number;
    heartbeatMs: number;
    maxPerDay: number;
    maxTokensPerDay: number;
  };
  graph: { archiveAfterDays: number; relatedThreshold: number; maxNeurons: number };
  birth: { historyDays: number };
  log: { senseSummaryEveryMs: number };
}

/** Mirrors `WatcherConfigSchema` in `src/config.ts` (tests/watcher/types.test.ts keeps them equal). */
export const WATCHER_DEFAULTS: WatcherConfig = {
  enabled: false,
  notice: {
    enabled: false,
    backend: 'claude-cli',
    model: 'claude-haiku-5-5',
    everyMs: 300_000,
    salienceBar: 0.4,
    maxPerDay: 288,
  },
  integrate: {
    enabled: false,
    model: 'claude-opus-5-5',
    salienceBar: 2.0,
    heartbeatMs: 3_600_000,
    maxPerDay: 24,
    maxTokensPerDay: 600_000,
  },
  graph: { archiveAfterDays: 30, relatedThreshold: 0.82, maxNeurons: 20_000 },
  birth: { historyDays: 30 },
  log: { senseSummaryEveryMs: 60_000 },
};

export function emptyCounts(): Record<NeuronKind, number> {
  return Object.fromEntries(NEURON_KINDS.map((k) => [k, 0])) as Record<NeuronKind, number>;
}

export function isHumanInbound(event: SensedEvent): event is HumanInboundEvent {
  return typeof (event as HumanInboundEvent).channelKind === 'string' && !('type' in event);
}

/**
 * `Neuron.meta` key set to `'true'` when operator material is part of what
 * supports the neuron, directly (notice) or through what an insight stands on
 * (integrate). Operator material is an operator message AND every bot-activity
 * event (cycles, tools, surprises, workers, goals, tasks): what the operator's
 * bots work on is the operator's. `fleet_memory_search` shows such neurons only
 * to the operator.
 */
export const OPERATOR_SOURCED = 'operatorSourced';

/** A buffer item that is a non-operator human message (already reduced to topic words by tier 0). */
export function isPublicHumanItem(item: Pick<BufferItem, 'event' | 'fromOperator'>): boolean {
  return isHumanInbound(item.event) && item.fromOperator !== true;
}

/**
 * Operator-sourced unless every item is a non-operator human message (public
 * content is only topic words, and it is the caller's own channel). No items
 * at all is operator-sourced too: conservative.
 */
export function restsOnOperatorMaterial(
  items: ReadonlyArray<Pick<BufferItem, 'event' | 'fromOperator'>>
): boolean {
  return items.length === 0 || items.some((i) => !isPublicHumanItem(i));
}

export function isOperatorSourced(n: Pick<Neuron, 'meta'>): boolean {
  return n.meta?.[OPERATOR_SOURCED] === 'true';
}
