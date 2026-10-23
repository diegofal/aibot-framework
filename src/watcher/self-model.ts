/**
 * The watcher's self-model (docs/plans/watcher-implementation-plan.md, phase
 * 4): what it feels (`interoception`) and what it attends to (`attention`).
 * Pure over injected readers: every reader may be absent or throw, and the
 * answer is then a null or an empty list, never an exception. The integrate
 * prompt shows both ("## How I am", "## What I am attending to"); the
 * introspection harness scores the watcher's self-report against
 * `attention()`; bots see `fleetFocusTexts` in "## Your current state".
 */
import type { CliSemaphoreStats } from '../core/cli-semaphore';
import type { TierUsage } from './budget';
import { describeEvent } from './narration';
import {
  type BufferItem,
  type Neuron,
  type NeuronKind,
  type WatcherPhase,
  isOperatorSourced,
} from './types';

const HOUR_MS = 3_600_000;
/** Buffer items `attention()` keeps. */
export const ATTENTION_MAX_ITEMS = 5;
/** Focus texts a bot sees in "## Your current state". */
export const FLEET_FOCUS_MAX = 3;
export const FLEET_FOCUS_MAX_CHARS = 120;

export interface Interoception {
  /** Mean current karma of the fleet's bots; null without a karma reader. */
  fleetKarmaAvg: number | null;
  /** Backends whose fleet circuit breaker is open now. */
  breakerOpen: string[];
  semaphore: {
    limit: number;
    active: number;
    queued: number;
    queuedInteractive: number;
    activeWatcher: number;
  } | null;
  /** Calls per tier today and the day's tokens and dollars across both tiers. */
  budgetUsedToday: { notice: number; integrate: number; tokens: number; usd: number };
  /** Hours since the operator last wrote (any verified operator surface); null = not seen. */
  operatorSilenceHours: number | null;
  /** Sum of the salience of what the working buffer holds now. */
  bufferSalience: number;
  lastIntegrateAgoMs: number | null;
}

export interface InteroceptionReaders {
  nowMs: number;
  /** Current karma of every enabled bot. */
  karmaScores?: () => number[];
  /** Backends the watcher's tiers use (what the breaker is asked about). */
  backends?: string[];
  isCircuitOpen?: (backend: string) => boolean;
  semaphore?: () => CliSemaphoreStats;
  budget: { notice: TierUsage; integrate: TierUsage };
  lastOperatorAt?: number | null;
  bufferItems: Array<Pick<BufferItem, 'salience'>>;
  lastIntegrateAt?: string;
}

function attempt<T>(fn: (() => T) | undefined, fallback: T): T {
  if (!fn) return fallback;
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const round = (n: number, places = 2) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

export function interoception(r: InteroceptionReaders): Interoception {
  const scores = attempt(r.karmaScores, [] as number[]).filter((n) => Number.isFinite(n));
  const breakerOpen = (r.backends ?? []).filter((b) =>
    attempt(() => !!r.isCircuitOpen?.(b), false)
  );
  const sem = attempt(r.semaphore, null as CliSemaphoreStats | null);
  const lastIntegrate = r.lastIntegrateAt ? Date.parse(r.lastIntegrateAt) : Number.NaN;
  const salience = r.bufferItems.reduce(
    (sum, i) => sum + (Number.isFinite(i.salience) ? i.salience : 0),
    0
  );
  return {
    fleetKarmaAvg: scores.length
      ? round(scores.reduce((a, b) => a + b, 0) / scores.length, 1)
      : null,
    breakerOpen,
    semaphore: sem
      ? {
          limit: sem.limit,
          active: sem.active,
          queued: sem.queued,
          queuedInteractive: sem.queuedByPriority?.interactive ?? 0,
          activeWatcher: sem.activeByPriority?.watcher ?? 0,
        }
      : null,
    budgetUsedToday: {
      notice: r.budget.notice.calls,
      integrate: r.budget.integrate.calls,
      tokens: r.budget.notice.tokens + r.budget.integrate.tokens,
      usd: round(r.budget.notice.costUsd + r.budget.integrate.costUsd, 4),
    },
    operatorSilenceHours:
      typeof r.lastOperatorAt === 'number' && Number.isFinite(r.lastOperatorAt)
        ? round(Math.max(0, r.nowMs - r.lastOperatorAt) / HOUR_MS, 1)
        : null,
    bufferSalience: round(salience),
    lastIntegrateAgoMs: Number.isFinite(lastIntegrate)
      ? Math.max(0, r.nowMs - lastIntegrate)
      : null,
  };
}

/** The newest instant the operator wrote among `items`, or `previous` when that is newer. */
export function lastOperatorMs(
  items: Array<Pick<BufferItem, 'noticedAt' | 'fromOperator'>>,
  previous: number | null = null
): number | null {
  let best = previous;
  for (const i of items) {
    if (i.fromOperator !== true) continue;
    const t = Date.parse(i.noticedAt);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

export interface AttentionNeuron {
  id: string;
  kind: NeuronKind;
  text: string;
  /** An operator message supports it: never shown to a bot. */
  operatorSourced?: true;
}

export interface AttentionItem {
  id: string;
  botId: string;
  /** One line written by code (`describeEvent`), privacy already applied by tier 0. */
  what: string;
  salience: number;
  reasons: string[];
  touched: AttentionNeuron[];
}

export interface Attention {
  phase: WatcherPhase;
  items: AttentionItem[];
  /** What the last integrate pass said it attends to (live neurons only). */
  focusNeuronIds: string[];
  focus: AttentionNeuron[];
  attendingAt?: string;
}

export interface AttentionInput {
  phase: WatcherPhase;
  /** The working buffer and what integrate has pending (both, deduped by id). */
  items: BufferItem[];
  graph: { get(id: string): Neuron | undefined };
  attending: string[];
  attendingAt?: string;
  botName?: (botId: string) => string;
}

function attentionNeuron(graph: AttentionInput['graph'], id: string): AttentionNeuron | undefined {
  const n = attempt(() => graph.get(id), undefined);
  if (!n || n.archivedAt) return undefined;
  return {
    id: n.id,
    kind: n.kind,
    text: n.text,
    ...(isOperatorSourced(n) ? { operatorSourced: true as const } : {}),
  };
}

export function attention(input: AttentionInput): Attention {
  const botName = input.botName ?? ((id: string) => id);
  const byId = new Map<string, BufferItem>();
  for (const i of input.items) if (i && typeof i.id === 'string') byId.set(i.id, i);
  const top = [...byId.values()]
    .sort((a, b) => b.salience - a.salience)
    .slice(0, ATTENTION_MAX_ITEMS);
  const items = top.map((i) => ({
    id: i.id,
    botId: i.event.botId,
    what: attempt(
      () =>
        describeEvent(i.event, {
          botName,
          ...(i.fromOperator ? { sender: 'the operator' } : {}),
        }),
      `an event in ${i.event.botId}`
    ),
    salience: i.salience,
    reasons: [...(i.reasons ?? [])],
    touched: [...new Set(i.touched ?? [])]
      .map((id) => attentionNeuron(input.graph, id))
      .filter((n): n is AttentionNeuron => !!n),
  }));
  const focus = [...new Set(input.attending)]
    .map((id) => attentionNeuron(input.graph, id))
    .filter((n): n is AttentionNeuron => !!n);
  return {
    phase: input.phase,
    items,
    focusNeuronIds: focus.map((n) => n.id),
    focus,
    ...(input.attendingAt ? { attendingAt: input.attendingAt } : {}),
  };
}

/** What a bot may see of the fleet's focus: never operator-sourced, clipped, at most three. */
export function fleetFocusTexts(att: Pick<Attention, 'focus'>): string[] {
  return att.focus
    .filter((n) => !n.operatorSourced)
    .slice(0, FLEET_FOCUS_MAX)
    .map((n) => {
      const flat = n.text.replace(/\s+/g, ' ').trim();
      return flat.length > FLEET_FOCUS_MAX_CHARS
        ? `${flat.slice(0, FLEET_FOCUS_MAX_CHARS - 1)}…`
        : flat;
    });
}
