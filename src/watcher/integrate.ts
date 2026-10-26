/**
 * Tier 2: integration (phase 3). Notice drains the working buffer, so the
 * integrator keeps its own "since my last thought" accumulation: every buffer
 * item tier 0 pushed (`observe`) and every neuron notice created or recognised
 * (`observeNotice`). A pass wakes (O2, `wake`) when that salience reaches
 * `integrate.wakeSalience` (the stakes may raise it), when the standing agenda
 * holds news (`agenda-changed`: a pair or an insight created after the last
 * agenda pass's scan, or an insight whose broadcast failed after it settled;
 * never within `integrate.agendaFloorMs` of it), or on the heartbeat
 * (`integrate.heartbeatMs`) with `integrate.minItems` items pending; never
 * closer than `INTEGRATE_MIN_GAP_MS` to the previous attempt, and only while
 * `integrate.enabled`. O3: a pass told to defer questions (the operator is
 * silent) keeps them (`deferredQuestions`) instead of sending them; the insight
 * stays on the agenda, and `releaseQuestions` sends them when the operator
 * writes.
 *
 * The model (Opus, through the instrumented client: budget reservation and
 * fleet breaker before the call, query log under `__watcher__`) sees the
 * pending events, the fresh neurons and their 2-hop neighbourhood (capped),
 * open goals per bot, the last insights and predictions, and the bots it may
 * broadcast to. Code decides what its answer becomes: an insight must cite
 * neurons it was shown (its support is built from them), a contradiction two
 * of them, a prediction gets a `dueAt` from its horizon, a broadcast must name
 * a known bot and a usable insight, and `attending` keeps only known ids.
 * Everything a pass creates is `operatorSourced` when anything the model saw
 * was (an event other than a non-operator human message — bot activity counts —,
 * or a neuron already marked): `fleet_memory_search` then shows it only to the
 * operator.
 *
 * One pass at a time (`run` shares the one in flight); pending is cleared only
 * for what the pass read, and only after a readable answer. Rows are
 * code-written; model text appears only quoted. Never throws.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLLMJson } from '../bot/llm-json-parser';
import { mentionsWord } from '../hygiene/text-utils';
import { type BroadcastResult, type Broadcaster, isStaleOpen } from './broadcast';
import type { DailyBudget } from './budget';
import type { Graph } from './graph';
import { placeWithoutEmbedding } from './layout';
import type { InstrumentedClient, WatcherCallResult } from './llm';
import type { WatcherLog } from './log';
import {
  narrateIntegrateCapped,
  narrateIntegrateContradiction,
  narrateIntegrateFailed,
  narrateIntegrateInsight,
  narrateIntegrateNoBroadcast,
  narrateIntegratePass,
  narrateIntegratePaused,
  narrateIntegratePrediction,
  narrateIntegrateUnparsable,
  narrateNoticeRecognised,
} from './narration';
import { type NoticeOutcome, type PassOptions, earliestEventAt, noticeItems } from './notice';
import {
  BROADCAST_KINDS,
  type IntegrateAgenda,
  type IntegrateAgendaPair,
  type IntegrateInsightBroadcast,
  type IntegratePredictionRow,
  type IntegratePromptInput,
  buildIntegratePrompt,
} from './prompts';
import type { Attention } from './self-model';
import {
  type BufferItem,
  type Confidence,
  type Neuron,
  type NeuronKind,
  OPERATOR_SOURCED,
  type PassTrigger,
  type Vec3,
  type WatcherConfig,
  isOperatorSourced,
  isPublicHumanItem,
} from './types';

/** Never two attempts closer than this, whatever triggers them. */
export const INTEGRATE_MIN_GAP_MS = 10 * 60_000;
export const INTEGRATE_MAX_EVENTS = 30;
export const INTEGRATE_NEIGHBOURHOOD_MAX = 80;
export const INTEGRATE_LAST_INSIGHTS = 10;
export const INTEGRATE_LAST_PREDICTIONS = 10;
const INTEGRATE_MAX_GOALS = 40;
/** Agenda ids the model said it addressed, kept between passes (newest win). */
const AGENDA_COVERED_MAX = 500;
/** Neuron kinds a standing-agenda pair is made of (not bots, people, or the watcher's own thoughts). */
const AGENDA_KINDS = new Set<NeuronKind>([
  'fact',
  'topic',
  'goal',
  'pattern',
  'surprise',
  'question',
]);
/** `integrate.agendaFloorMs` for a config written before it existed. */
const AGENDA_FLOOR_DEFAULT_MS = 2 * 3_600_000;
/** Questions deferred while the operator is silent (O3), kept at most this many and this long. */
export const DEFERRED_QUESTIONS_MAX = 10;
export const DEFERRED_QUESTION_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** Pending items kept between passes (the most salient win). */
const PENDING_MAX_ITEMS = 100;
const PENDING_MAX_NEURONS = 200;
/** Text similarity at which an insight is one the graph already has. */
export const INTEGRATE_DEDUPE_TEXT = 0.8;
const MAX_TEXT = 300;
const INTEGRATE_TEMPERATURE = 0.4;
const HOUR_MS = 3_600_000;
const MAX_HORIZON_HOURS = 24 * 14;
const CONFIDENCE_PROBABILITY: Record<Confidence, number> = { low: 0.55, medium: 0.7, high: 0.85 };

export interface IntegrateInsightOut {
  text: string;
  support: string[];
  confidence?: string;
  /** One line: why this insight calls for no broadcast. */
  whyNoBroadcast?: string;
}
export interface IntegrateContradictionOut {
  a: string;
  b: string;
  text: string;
}
export interface IntegratePredictionOut {
  text: string;
  horizonHours?: number;
  probability?: number;
  confidence?: string;
  about?: string;
  neuronIds: string[];
}
export interface IntegrateBroadcastOut {
  bot: string;
  kind: string;
  text: string;
  insightIndex: number;
  /** An insight already in the graph and shown in the prompt (instead of `insightIndex`). */
  insightId?: string;
}
export interface IntegrateOutput {
  insights: IntegrateInsightOut[];
  contradictions: IntegrateContradictionOut[];
  predictions: IntegratePredictionOut[];
  broadcasts: IntegrateBroadcastOut[];
  attending: string[];
  /** Phase 4: which "How I am" variables the model says shaped this pass. */
  drivenBy: string[];
  /** Standing-agenda ids (edge or insight) the model addressed: no longer shown. */
  agendaCovered: string[];
  /** Shown insights the model decided not to broadcast, with its one line why. */
  noBroadcast: Array<{ insightId: string; why: string }>;
}

export type IntegrateOutcome =
  | { status: 'idle' }
  | { status: 'capped' | 'breaker' }
  | { status: 'failed'; error: string }
  | { status: 'unparsable' }
  | {
      status: 'integrated';
      insights: Neuron[];
      contradictions: Neuron[];
      predictions: Neuron[];
      broadcasts: BroadcastResult[];
    }
  /** Its run was stopped: nothing written after that (graph, state, log, broadcasts). */
  | { status: 'cancelled' };

/** `<dir>/integrate.json`: what is pending, when it last ran, what it attends to. */
export interface IntegrateState {
  lastRunAt?: string;
  lastAttemptAt?: string;
  /** Neuron ids the last readable pass said it attends to (phase 4 reads them). */
  attending: string[];
  attendingAt?: string;
  pending: { items: BufferItem[]; neurons: string[]; salience: number };
  /** Standing-agenda ids a pass addressed (`agendaCovered`); never shown again. */
  agendaCovered?: string[];
  /**
   * When the agenda the last applied agenda pass was shown was scanned: only a
   * pair or insight created after it is news, and agenda-only passes wait
   * `integrate.agendaFloorMs` from it.
   */
  lastAgendaAt?: string;
  /** When that pass finished its sends: a broadcast failing after it puts its insight back as news. */
  agendaSettledAt?: string;
  /** The `drivenBy` of the newest applied pass shown a "How I am" record (introspection reads it). */
  drivenBy?: string[];
  /** O2: the standing-agenda ids the last applied agenda pass was shown; a new id makes the agenda changed. */
  agendaIds?: string[];
  /** O3: questions a pass kept back while the operator was silent (`releaseQuestions` sends them). */
  deferredQuestions?: DeferredQuestion[];
  /**
   * Insight id -> when a pass's broadcast for it was last unsuccessful
   * (failed, deferred, capped). Such an insight is agenda news once
   * `integrate.agendaFloorMs` has passed since that attempt; a delivery, or an
   * applied pass that was shown it again, clears the entry (one retry each).
   */
  agendaRetryAt?: Record<string, string>;
}

/** O3: a question broadcast kept back while the operator is silent. */
export interface DeferredQuestion {
  insightId: string;
  botId: string;
  text: string;
  /** The insight's text (the broadcast's `reason`). */
  reason: string;
  deferredAt: string;
}

/** O2/O3: what woke the pass and what the stakes ask of it. */
export interface IntegrateRunOptions extends PassOptions {
  /** The operator is silent: a question broadcast is kept back (`deferredQuestions`). */
  deferQuestions?: boolean;
  /** Fleet karma is falling: the prompt opens with "## Something is wrong". */
  somethingWrong?: string;
}

export interface IntegrateDeps {
  dir: string;
  graph: Graph;
  log: WatcherLog;
  client: Pick<InstrumentedClient, 'chat' | 'model' | 'backend'>;
  budget: Pick<DailyBudget, 'firstCapToday'>;
  config: () => WatcherConfig;
  now: () => number;
  /** Bots a broadcast may target (enabled bots of the config). */
  bots: () => Array<{ id: string; name: string }>;
  botName?: (botId: string) => string;
  /** `list`, `countToday` and `cap` (optional for older fakes) feed the prompt's caps and per-insight history. */
  broadcaster?: Pick<Broadcaster, 'send'> &
    Partial<Pick<Broadcaster, 'list' | 'countToday' | 'cap'>>;
  embed?: (text: string) => Promise<number[]>;
  /** Phase 4: the interoceptive record for "## How I am"; absent until then. */
  interoception?: () => Record<string, unknown>;
  /** Phase 4: what the watcher attends to, for "## What I am attending to". */
  attention?: () => Attention;
  logger?: { warn: (obj: object, msg: string) => void };
}

export function integrateStateFile(dir: string): string {
  return join(dir, 'integrate.json');
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const objList = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : [];
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isConfidence = (c: unknown): c is Confidence => c === 'low' || c === 'medium' || c === 'high';

/** The model's answer, or null when it is not the integrate JSON. */
export function parseIntegrateOutput(
  text: string,
  logger: { warn: (obj: object, msg: string) => void }
): IntegrateOutput | null {
  const warnOnly = { warn: (obj: object, msg?: string) => logger.warn(obj, msg ?? '') };
  return parseLLMJson<IntegrateOutput>(text ?? '', warnOnly as never, {
    label: 'watcher integrate',
    extractPattern:
      /\{[\s\S]*"(insights|contradictions|predictions|broadcasts|attending|noBroadcast|agendaCovered)"[\s\S]*\}/,
    validate: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const known = [
        'insights',
        'contradictions',
        'predictions',
        'broadcasts',
        'attending',
        'noBroadcast',
        'agendaCovered',
      ];
      if (!known.some((k) => k in raw)) return null;
      return {
        insights: objList(raw.insights).map((i) => ({
          text: str(i.text),
          support: strList(i.support),
          ...(typeof i.confidence === 'string' ? { confidence: i.confidence } : {}),
          ...(typeof i.whyNoBroadcast === 'string' && i.whyNoBroadcast.trim()
            ? { whyNoBroadcast: i.whyNoBroadcast }
            : {}),
        })),
        contradictions: objList(raw.contradictions).map((c) => ({
          a: str(c.a),
          b: str(c.b),
          text: str(c.text),
        })),
        predictions: objList(raw.predictions).map((p) => ({
          text: str(p.text),
          ...(typeof p.horizonHours === 'number' ? { horizonHours: p.horizonHours } : {}),
          ...(typeof p.probability === 'number' ? { probability: p.probability } : {}),
          ...(typeof p.confidence === 'string' ? { confidence: p.confidence } : {}),
          ...(typeof p.about === 'string' && p.about ? { about: p.about } : {}),
          neuronIds: strList(p.neuronIds),
        })),
        broadcasts: objList(raw.broadcasts).map((b) => ({
          bot: str(b.bot),
          kind: str(b.kind),
          text: str(b.text),
          insightIndex: typeof b.insightIndex === 'number' ? b.insightIndex : -1,
          ...(typeof b.insightId === 'string' && b.insightId ? { insightId: b.insightId } : {}),
        })),
        attending: strList(raw.attending),
        drivenBy: strList(raw.drivenBy),
        agendaCovered: strList(raw.agendaCovered),
        noBroadcast: objList(raw.noBroadcast)
          .map((x) => ({ insightId: str(x.insightId), why: str(x.why).trim() }))
          .filter((x) => x.insightId && x.why),
      };
    },
  });
}

function clip(text: string, max: number): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

function deferredQuestion(r: Record<string, unknown>): DeferredQuestion[] {
  const q = {
    insightId: str(r.insightId),
    botId: str(r.botId),
    text: str(r.text),
    reason: str(r.reason),
    deferredAt: str(r.deferredAt),
  };
  return q.insightId && q.botId && q.text && q.deferredAt ? [q] : [];
}

/** A standing-agenda scan: the agenda, the broadcasts it read, and when. */
interface ScannedAgenda {
  agenda: IntegrateAgenda;
  sent: Map<string, IntegrateInsightBroadcast[]>;
  at: number;
}

const agendaIdsOf = (a: IntegrateAgenda): string[] => [
  ...a.pairs.map((p) => p.id),
  ...a.insights.map((n) => n.id),
];

function emptyState(): IntegrateState {
  return { attending: [], pending: { items: [], neurons: [], salience: 0 } };
}

function isoRecord(raw: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && Number.isFinite(Date.parse(v))) out[k] = v;
  }
  return out;
}

function readState(dir: string): IntegrateState {
  try {
    const path = integrateStateFile(dir);
    if (!existsSync(path)) return emptyState();
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<IntegrateState>;
    const p = (raw.pending ?? {}) as Partial<IntegrateState['pending']>;
    return {
      ...(typeof raw.lastRunAt === 'string' ? { lastRunAt: raw.lastRunAt } : {}),
      ...(typeof raw.lastAttemptAt === 'string' ? { lastAttemptAt: raw.lastAttemptAt } : {}),
      attending: strList(raw.attending),
      ...(typeof raw.attendingAt === 'string' ? { attendingAt: raw.attendingAt } : {}),
      pending: {
        items: Array.isArray(p.items)
          ? p.items.filter(
              (i): i is BufferItem =>
                !!i && typeof i.id === 'string' && !!i.event && typeof i.salience === 'number'
            )
          : [],
        neurons: strList(p.neurons),
        salience: typeof p.salience === 'number' && Number.isFinite(p.salience) ? p.salience : 0,
      },
      ...(Array.isArray(raw.agendaCovered) ? { agendaCovered: strList(raw.agendaCovered) } : {}),
      ...(typeof raw.lastAgendaAt === 'string' ? { lastAgendaAt: raw.lastAgendaAt } : {}),
      ...(typeof raw.agendaSettledAt === 'string' ? { agendaSettledAt: raw.agendaSettledAt } : {}),
      ...(Array.isArray(raw.drivenBy) ? { drivenBy: strList(raw.drivenBy) } : {}),
      ...(Array.isArray(raw.agendaIds) ? { agendaIds: strList(raw.agendaIds) } : {}),
      ...(raw.agendaRetryAt && typeof raw.agendaRetryAt === 'object'
        ? { agendaRetryAt: isoRecord(raw.agendaRetryAt) }
        : {}),
      ...(Array.isArray(raw.deferredQuestions)
        ? { deferredQuestions: objList(raw.deferredQuestions).flatMap(deferredQuestion) }
        : {}),
    };
  } catch {
    return emptyState();
  }
}

export class Integrator {
  private st: IntegrateState;
  private inFlight: Promise<IntegrateOutcome> | null = null;
  private inFlightCancelled: () => boolean = () => false;
  private pausedLogged = false;
  private readonly bornAt: number;
  /**
   * The agenda `wake` scanned (the scan reads the whole graph): reused by
   * `wake` and taken once by the pass while fresh (`INTEGRATE_MIN_GAP_MS`).
   */
  private carriedAgenda: ScannedAgenda | undefined;

  constructor(private readonly deps: IntegrateDeps) {
    this.st = readState(deps.dir);
    this.bornAt = deps.now();
  }

  /** A buffer item tier 0 kept (called on every push, before notice drains it). */
  observe(item: BufferItem): void {
    const p = this.st.pending;
    if (p.items.some((i) => i.id === item.id)) return;
    p.items.push(item);
    p.salience += item.salience;
    if (p.items.length > PENDING_MAX_ITEMS) {
      p.items.sort((a, b) => b.salience - a.salience);
      p.items = p.items.slice(0, PENDING_MAX_ITEMS);
    }
  }

  /** What a notice pass created or recognised joins the next integration. */
  observeNotice(outcome: NoticeOutcome | null | undefined): void {
    if (!outcome || outcome.status !== 'noticed') return;
    const p = this.st.pending;
    p.neurons = uniq([
      ...p.neurons,
      ...outcome.created.map((n) => n.id),
      ...outcome.recognised.map((n) => n.id),
    ]).slice(-PENDING_MAX_NEURONS);
  }

  attending(): string[] {
    return [...this.st.attending];
  }

  /** What the newest pass said drove it (only "How I am" keys it was shown); empty before one. */
  drivenBy(): string[] {
    return [...(this.st.drivenBy ?? [])];
  }

  state(): IntegrateState {
    return JSON.parse(JSON.stringify(this.st)) as IntegrateState;
  }

  persist(): void {
    try {
      mkdirSync(this.deps.dir, { recursive: true });
      const path = integrateStateFile(this.deps.dir);
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.st), 'utf-8');
      renameSync(tmp, path);
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher integrate: could not persist its state');
    }
  }

  /** A pass is due when `wake` says why. */
  due(): boolean {
    return this.wake() !== null;
  }

  /**
   * Why a pass should run now (O2): `salience` (pending salience ≥
   * `wakeSalience`, default `integrate.wakeSalience`), `agenda-changed` (the
   * standing agenda holds an id the last agenda pass was not shown) or
   * `heartbeat` (`heartbeatMs` since the last pass with `minItems` pending).
   * Null within `INTEGRATE_MIN_GAP_MS` of the last attempt.
   */
  wake(opts: { wakeSalience?: number } = {}): Exclude<PassTrigger, 'age' | 'manual'> | null {
    const cfg = this.deps.config().integrate;
    if (!cfg.enabled) return null;
    const p = this.st.pending;
    const nowMs = this.deps.now();
    const attempt = this.st.lastAttemptAt ? Date.parse(this.st.lastAttemptAt) : undefined;
    if (attempt !== undefined && nowMs - attempt < INTEGRATE_MIN_GAP_MS) return null;
    const anyPending = p.items.length > 0 || p.neurons.length > 0;
    if (anyPending && p.salience >= (opts.wakeSalience ?? cfg.wakeSalience)) return 'salience';
    // A quiet fleet still acts on cross-bot pairs and waiting insights, but
    // only on news: an agenda the last agenda pass already saw never wakes one.
    if (this.agendaChanged(this.scanAgenda(cfg.agendaMax ?? 0, nowMs), nowMs)) {
      return 'agenda-changed';
    }
    const last = this.st.lastRunAt ? Date.parse(this.st.lastRunAt) : this.bornAt;
    // The heartbeat waits for enough salient items: a pass on 1-3 events had
    // nothing to integrate (live, 2026-10-24).
    if (nowMs - last >= cfg.heartbeatMs && p.items.length >= (cfg.minItems ?? 1)) {
      return 'heartbeat';
    }
    return null;
  }

  /**
   * True when the agenda holds news for an agenda-only pass: before any agenda
   * pass, any item; after one, only once `integrate.agendaFloorMs` has passed
   * and only a pair or insight created after that pass's scan, or an insight
   * whose broadcast failed or was deferred after that pass settled, or an
   * insight whose broadcast by a pass was unsuccessful (failed, deferred,
   * capped) `agendaFloorMs` or more ago (`agendaRetryAt`, one retry). With a
   * backlog larger than `agendaMax`, covering one item slides an older one in:
   * that is not news (review 2026-10-24, ~1,388 related links live).
   *
   * Deliberate: only items that would be SHOWN (the top `agendaMax`, which is
   * what `scan.agenda` holds) can make the agenda "changed". A pass cannot act
   * on an item it is not shown, so news below the cut must not wake one.
   */
  private agendaChanged(scan: ScannedAgenda, nowMs: number): boolean {
    const { agenda, sent } = scan;
    const lastIso = this.st.lastAgendaAt;
    if (!lastIso) return agendaIdsOf(agenda).length > 0;
    const last = Date.parse(lastIso);
    const floor = this.deps.config().integrate.agendaFloorMs ?? AGENDA_FLOOR_DEFAULT_MS;
    if (nowMs - last < floor) return false;
    const settled = this.st.agendaSettledAt ? Date.parse(this.st.agendaSettledAt) : last;
    const after = (iso: string | undefined, ref: number) => !!iso && Date.parse(iso) > ref;
    const retry = this.st.agendaRetryAt ?? {};
    const retryDue = (id: string) => {
      const at = retry[id];
      return !!at && nowMs - Date.parse(at) >= floor;
    };
    return (
      agenda.pairs.some((p) => after(p.createdAt, last)) ||
      agenda.insights.some(
        (n) =>
          after(n.createdAt, last) ||
          retryDue(n.id) ||
          (sent.get(n.id) ?? []).some(
            (b) => (b.status === 'failed' || b.status === 'deferred') && after(b.createdAt, settled)
          )
      )
    );
  }

  /** The standing agenda, scanned at most once per `INTEGRATE_MIN_GAP_MS` (kept for the pass). */
  private scanAgenda(max: number, nowMs: number): ScannedAgenda {
    const carried = this.carriedAgenda;
    if (carried && nowMs - carried.at < INTEGRATE_MIN_GAP_MS) return carried;
    const sent = this.broadcastsByInsight();
    const scan = { agenda: this.standingAgenda(max, sent), sent, at: nowMs };
    this.carriedAgenda = scan;
    return scan;
  }

  /** The agenda `wake` carried when still fresh (taken once), else a new scan. */
  private takeAgenda(
    max: number,
    sent: Map<string, IntegrateInsightBroadcast[]>,
    nowMs: number
  ): ScannedAgenda {
    const carried = this.carriedAgenda;
    this.carriedAgenda = undefined;
    if (carried && nowMs - carried.at < INTEGRATE_MIN_GAP_MS) return carried;
    return { agenda: this.standingAgenda(max, sent), sent, at: nowMs };
  }

  /** O3: the questions kept back while the operator was silent, oldest first. */
  deferredQuestions(): DeferredQuestion[] {
    return (this.st.deferredQuestions ?? []).map((q) => ({ ...q }));
  }

  /**
   * O3: send every deferred question now (the operator wrote). Only a
   * `delivered` or `duplicate` (already out) answer takes it off the list as
   * sent; `invalid` (it can never go out) and older than
   * `DEFERRED_QUESTION_MAX_AGE_MS` drop it unsent, with a row. Anything else
   * (`deferred` by the throttle, `capped` by the bot's daily cap, `failed`, a
   * throw) keeps it held for the next release. One row when anything was
   * sent. Never throws.
   */
  async releaseQuestions(opts: PassOptions = {}): Promise<BroadcastResult[]> {
    const bc = this.deps.broadcaster;
    const queue = this.st.deferredQuestions ?? [];
    if (!bc || queue.length === 0) return [];
    const isCancelled = opts.isCancelled ?? (() => false);
    const nowMs = this.deps.now();
    const results: BroadcastResult[] = [];
    const released: DeferredQuestion[] = [];
    // Off the persisted list at once, one by one: a stop or a crash mid-release
    // never resends what already went out. A pass may defer more meanwhile:
    // those stay.
    const take = (q: DeferredQuestion) => {
      const next = (this.st.deferredQuestions ?? []).filter((x) => x !== q);
      this.st.deferredQuestions = next.length ? next : undefined;
      this.persist();
    };
    for (const q of [...queue]) {
      if (isCancelled()) break;
      const at = Date.parse(q.deferredAt);
      if (!Number.isFinite(at) || nowMs - at > DEFERRED_QUESTION_MAX_AGE_MS) {
        this.questionDropped(q, 'held over 7 days');
        take(q);
        continue;
      }
      let result: BroadcastResult;
      try {
        result = await bc.send({
          botId: q.botId,
          kind: 'question',
          text: q.text,
          insightId: q.insightId,
          reason: q.reason,
          source: 'integrate',
        });
      } catch (err) {
        this.deps.logger?.warn({ err }, 'Watcher integrate: a deferred question failed to send');
        continue;
      }
      results.push(result);
      if (result.status === 'invalid') {
        this.questionDropped(q, 'rejected by the broadcaster');
        take(q);
        continue;
      }
      if (result.status !== 'delivered' && result.status !== 'duplicate') continue;
      released.push(q);
      take(q);
    }
    if (released.length && !isCancelled()) {
      this.deps.log.say(
        'integrate',
        'integrate:question-released',
        `The operator is back: I sent ${released.length} question${released.length === 1 ? '' : 's'} I had held while they were silent.`,
        {
          neuronIds: uniq(released.map((q) => q.insightId)),
          drivenBy: ['operatorPresent'],
          source: 'watcher:integrate',
        }
      );
    }
    return results;
  }

  /** O3: keep a question back (newest replaces the same insight and bot; capped, with a row per drop). */
  private deferQuestion(q: DeferredQuestion): void {
    const rest = (this.st.deferredQuestions ?? []).filter(
      (x) => !(x.insightId === q.insightId && x.botId === q.botId)
    );
    const all = [...rest, q];
    const over = all.length - DEFERRED_QUESTIONS_MAX;
    for (const dropped of over > 0 ? all.slice(0, over) : []) {
      this.questionDropped(dropped, `more than ${DEFERRED_QUESTIONS_MAX} held`);
    }
    this.st.deferredQuestions = all.slice(-DEFERRED_QUESTIONS_MAX);
  }

  /** O3: one row for a held question that will never be sent. */
  private questionDropped(q: DeferredQuestion, why: string): void {
    this.deps.log.say(
      'integrate',
      'integrate:question-dropped',
      `I dropped a question I had held for the operator about ${this.deps.botName?.(q.botId) ?? q.botId} (${why}): "${clip(q.text, 120)}".`,
      { neuronIds: [q.insightId], whyNoBroadcast: why, source: 'watcher:integrate' }
    );
  }

  /**
   * One pass; a call while one runs shares it, unless that one's run was
   * cancelled (it writes nothing more, so a new run starts its own).
   */
  run(opts: IntegrateRunOptions = {}): Promise<IntegrateOutcome> {
    if (this.inFlight && !this.inFlightCancelled()) return this.inFlight;
    const isCancelled = opts.isCancelled ?? (() => false);
    const run: Promise<IntegrateOutcome> = this.pass(isCancelled, opts)
      .catch((err): IntegrateOutcome => {
        if (isCancelled()) return { status: 'cancelled' };
        this.deps.logger?.warn({ err }, 'Watcher integrate: pass failed');
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    this.inFlightCancelled = isCancelled;
    return run;
  }

  /**
   * Checked before every embed, after every embed settles (its result is
   * dropped), before every graph write, before every `broadcaster.send` and
   * before the state and the log: after a stop the state was persisted and the
   * graph compacted, so a write here would land after the sleep row.
   */
  private async pass(
    isCancelled: () => boolean,
    opts: IntegrateRunOptions = {}
  ): Promise<IntegrateOutcome> {
    const { graph, log } = this.deps;
    const cfg = this.deps.config();
    if (!cfg.integrate.enabled) return { status: 'idle' };
    const pending = this.st.pending;
    const nothingPending = pending.items.length === 0 && pending.neurons.length === 0;
    const sentByInsight = this.broadcastsByInsight();
    const scan = this.takeAgenda(cfg.integrate.agendaMax ?? 0, sentByInsight, this.deps.now());
    const { agenda } = scan;
    const hasAgenda = agenda.pairs.length > 0 || agenda.insights.length > 0;
    // Nothing pending: only news on the agenda justifies a pass (also when
    // `run` is called directly); an agenda the last pass saw is idle.
    if (nothingPending && !this.agendaChanged(scan, this.deps.now())) return { status: 'idle' };
    if (isCancelled()) return { status: 'cancelled' };

    // Snapshot what this pass reads: anything observed meanwhile stays pending.
    const readItems = [...pending.items];
    const readNeurons = [...pending.neurons];
    const readSalience = pending.salience;
    const attemptIso = new Date(this.deps.now()).toISOString();
    this.st.lastAttemptAt = attemptIso;
    this.persist();

    const botName = this.deps.botName ?? ((id: string) => id);
    const events = [...readItems]
      .sort((a, b) => b.salience - a.salience)
      .slice(0, INTEGRATE_MAX_EVENTS);
    const live = (id: string) => {
      const n = graph.get(id);
      return n && !n.archivedAt ? n : undefined;
    };
    const fresh = readNeurons.map(live).filter((n): n is Neuron => !!n);
    const seeds = uniq([...fresh.map((n) => n.id), ...events.flatMap((i) => i.touched)]);
    const neighbourhood = this.neighbourhood(seeds);
    const goals = graph
      .list()
      .filter(
        (n) =>
          n.kind === 'goal' &&
          !n.archivedAt &&
          n.meta?.status !== 'done' &&
          n.meta?.status !== 'completed'
      )
      .slice(0, INTEGRATE_MAX_GOALS);
    const insights = this.latest('insight', INTEGRATE_LAST_INSIGHTS);
    const predictions = this.latest('prediction', INTEGRATE_LAST_PREDICTIONS);
    const bots = this.deps.bots();
    const bc = this.deps.broadcaster;
    const cap = bc?.countToday ? bc.cap : undefined;
    const interoception = this.readSelf(() => this.deps.interoception?.());
    const attention = this.readSelf(() => this.deps.attention?.());

    const input: IntegratePromptInput = {
      events: noticeItems(events, botName),
      fresh,
      neighbourhood,
      goals: goals.map((g) => {
        const botId = g.support.bots[0] ?? '';
        return { id: g.id, botId, bot: botName(botId), text: g.text };
      }),
      insights,
      predictions: predictions.map(predictionRow),
      bots: bots.map((b) => ({
        ...b,
        ...(cap !== undefined ? { broadcastsToday: this.countToday(b.id) } : {}),
      })),
      ...(cap !== undefined ? { broadcastCap: cap } : {}),
      // Insights, and the fresh and nearby neurons a fast-lane directive came from.
      insightBroadcasts: Object.fromEntries(
        [...insights, ...fresh, ...neighbourhood]
          .map((n) => [n.id, sentByInsight.get(n.id) ?? []] as const)
          .filter(([, v]) => v.length > 0)
      ),
      ...(agenda.pairs.length || agenda.insights.length ? { agenda } : {}),
      ...(interoception ? { interoception } : {}),
      ...(attention ? { attention } : {}),
      ...(opts.somethingWrong ? { somethingWrong: opts.somethingWrong } : {}),
    };
    const shown = new Map<string, Neuron>();
    const agendaNeurons = [...agenda.pairs.flatMap((p) => [p.a, p.b]), ...agenda.insights];
    for (const n of [
      ...fresh,
      ...neighbourhood,
      ...goals,
      ...insights,
      ...predictions,
      ...agendaNeurons,
    ]) {
      shown.set(n.id, n);
    }
    const agendaIds = new Set([
      ...agenda.pairs.map((p) => p.id),
      ...agenda.insights.map((n) => n.id),
    ]);
    // Same rule as notice: any event that is not a non-operator human message
    // (bot activity is operator material) marks what the pass creates.
    const sawOperator =
      events.some((i) => !isPublicHumanItem(i)) ||
      [...shown.values()].some((n) => isOperatorSourced(n));

    const prompt = buildIntegratePrompt(input);
    const res = await this.deps.client.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      { temperature: INTEGRATE_TEMPERATURE }
    );
    if (isCancelled()) return { status: 'cancelled' };
    if (!res.ok) return this.refused(res);
    this.pausedLogged = false;
    const cost = {
      model: res.model,
      tokens: res.tokens,
      ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
      durationMs: res.durationMs,
      source: 'watcher:integrate',
    };

    const out = parseIntegrateOutput(res.text, this.deps.logger ?? { warn: () => {} });
    if (!out) {
      log.say('integrate', 'integrate:failed', narrateIntegrateUnparsable(), cost);
      return { status: 'unparsable' };
    }

    const ctx: ApplyCtx = {
      shown,
      model: res.model,
      eventAt: earliestEventAt(readItems),
      operatorSourced: sawOperator,
    };
    const insightByIndex: Array<Neuron | undefined> = [];
    const createdInsights: Neuron[] = [];
    const botIds = new Set(bots.map((b) => b.id));
    // A broadcast `sendable` can send (known bot and kind, a broadcaster); only
    // those take an insight's `whyNoBroadcast` away.
    const targetOk = (b: IntegrateBroadcastOut) =>
      botIds.has(b.bot) &&
      (BROADCAST_KINDS as readonly string[]).includes(b.kind) &&
      !!this.deps.broadcaster;
    const proposedIds = new Set(
      out.broadcasts.flatMap((b) =>
        b.insightId && targetOk(b) && shown.get(b.insightId)?.kind === 'insight'
          ? [b.insightId]
          : []
      )
    );
    for (const [index, i] of out.insights.entries()) {
      if (isCancelled()) return { status: 'cancelled' };
      const proposed = out.broadcasts.some(
        (b) => b.insightIndex === index && !b.insightId && targetOk(b)
      );
      const r = await this.insight(i, ctx, isCancelled, { proposed, proposedIds, bots });
      if (isCancelled()) return { status: 'cancelled' };
      insightByIndex.push(r?.neuron);
      if (r?.created) createdInsights.push(r.neuron);
    }
    // contradiction() and prediction() are synchronous: nothing settles in between.
    const contradictions = out.contradictions
      .map((c) => this.contradiction(c, ctx))
      .filter((n): n is Neuron => !!n);
    const preds = out.predictions
      .map((p) => this.prediction(p, ctx, bots))
      .filter((n): n is Neuron => !!n);

    // What the pass wrote is in the graph: consume what it read and persist
    // before broadcasting, so a cancel during a send only loses the remaining
    // broadcasts and a restart never re-integrates (and duplicates) the same items.
    if (isCancelled()) return { status: 'cancelled' };
    const known = new Set([
      ...shown.keys(),
      ...insightByIndex.filter((n): n is Neuron => !!n).map((n) => n.id),
      ...contradictions.map((n) => n.id),
      ...preds.map((n) => n.id),
    ]);
    const nowIso = new Date(this.deps.now()).toISOString();
    this.st.attending = uniq(out.attending.filter((id) => known.has(id)));
    this.st.attendingAt = nowIso;
    this.st.lastRunAt = nowIso;
    const shownVariables = new Set(Object.keys(interoception ?? {}));
    // The model's "How I am" variables, plus the stakes rules that shaped the
    // pass (O3): introspection reads both as what drove it.
    const stakesDrove = uniq(opts.drivenBy ?? []);
    const drivenBy = uniq([...out.drivenBy.filter((k) => shownVariables.has(k)), ...stakesDrove]);
    if (shownVariables.size || stakesDrove.length) this.st.drivenBy = drivenBy;
    // Only a pass that applied an answer uses up the agenda change: a refused,
    // failed, unparsable or cancelled one leaves the agenda due again.
    if (hasAgenda) {
      this.st.lastAgendaAt = new Date(scan.at).toISOString();
      this.st.agendaIds = agendaIdsOf(agenda);
    }
    // A retry is used up by a pass shown the insight (a send below that fails
    // again re-arms it); entries for insights gone from the graph drop.
    if (this.st.agendaRetryAt) {
      const shownNow = new Set(agenda.insights.map((n) => n.id));
      const kept = Object.entries(this.st.agendaRetryAt).filter(
        ([id]) => !shownNow.has(id) && !!live(id)
      );
      this.st.agendaRetryAt = kept.length ? Object.fromEntries(kept) : undefined;
    }
    // An agenda insight is retired only once it acted: a delivered broadcast
    // (after the sends below) or a `whyNoBroadcast`. Covered but capped,
    // deferred, failed or never sent leaves it on the agenda for a retry.
    // Other agenda items (pairs) are retired by being covered.
    const covered = out.agendaCovered.filter((id) => agendaIds.has(id));
    const coveredInsights = covered.filter((id) => graph.get(id)?.kind === 'insight');
    this.retireAgenda(covered.filter((id) => !coveredInsights.includes(id)));
    const readIds = new Set(readItems.map((i) => i.id));
    const readNeuronIds = new Set(readNeurons);
    this.st.pending = {
      items: this.st.pending.items.filter((i) => !readIds.has(i.id)),
      neurons: this.st.pending.neurons.filter((id) => !readNeuronIds.has(id)),
      salience: Math.max(0, this.st.pending.salience - readSalience),
    };
    this.persist();

    const broadcasts: BroadcastResult[] = [];
    const shownInsight = (id: string | undefined) => {
      const n = id ? (shown.get(id) ?? insightByIndex.find((x) => x?.id === id)) : undefined;
      return n?.kind === 'insight' ? n : undefined;
    };
    const sendable = (b: IntegrateBroadcastOut) => {
      const insight = b.insightId ? shownInsight(b.insightId) : insightByIndex[b.insightIndex];
      return insight && targetOk(b) ? insight : undefined;
    };
    // A "no broadcast" for an insight this pass also broadcasts contradicts
    // itself: the broadcast wins and the reason is not recorded.
    const broadcastNow = new Set(out.broadcasts.map(sendable).flatMap((n) => (n ? [n.id] : [])));
    const contradicted: string[] = [];
    for (const nb of out.noBroadcast) {
      const insight = shownInsight(nb.insightId);
      if (!insight) continue;
      if (broadcastNow.has(insight.id)) {
        contradicted.push(insight.id);
        continue;
      }
      const why = clip(nb.why, 200);
      graph.patchMeta(insight.id, { whyNoBroadcast: why });
      log.say(
        'integrate',
        'integrate:no-broadcast',
        narrateIntegrateNoBroadcast({ insight: insight.text, why }),
        { neuronIds: [insight.id], whyNoBroadcast: why, source: 'watcher:integrate' }
      );
    }
    if (contradicted.length) {
      this.deps.logger?.warn(
        { insightIds: uniq(contradicted) },
        'Watcher integrate: noBroadcast skipped for insights broadcast in the same pass'
      );
    }
    // A reason left by an earlier pass on an insight this pass broadcasts is
    // stale: the broadcast replaced it. Cleared before the sends, together with
    // the agenda retirement that reason earned, so a capped, deferred or failed
    // send leaves the insight on the agenda for a retry; a delivered one
    // retires it again.
    const unretired: string[] = [];
    for (const id of broadcastNow) {
      if (!graph.get(id)?.meta?.whyNoBroadcast) continue;
      graph.dropMeta(id, ['whyNoBroadcast']);
      if (this.st.agendaCovered?.includes(id)) unretired.push(id);
    }
    if (unretired.length) {
      this.st.agendaCovered = (this.st.agendaCovered ?? []).filter((id) => !unretired.includes(id));
      this.persist();
    }
    const deliveredFor = new Set<string>();
    const retireActed = () => {
      const acted = uniq([...coveredInsights, ...unretired]).filter(
        (id) => deliveredFor.has(id) || !!graph.get(id)?.meta?.whyNoBroadcast
      );
      if (this.retireAgenda(acted)) this.persist();
    };
    let deferred = 0;
    for (const b of out.broadcasts) {
      const insight = sendable(b);
      if (!insight || !this.deps.broadcaster) continue;
      if (isCancelled()) {
        retireActed();
        return { status: 'cancelled' };
      }
      // O3: the operator is silent, so a question would go unanswered. It is
      // kept (sent when they write) and the insight stays on the agenda: no
      // delivery and no `whyNoBroadcast` on the neuron, so it is not retired.
      if (b.kind === 'question' && opts.deferQuestions) {
        this.deferQuestion({
          insightId: insight.id,
          botId: b.bot,
          text: clip(b.text, 500),
          reason: insight.text,
          deferredAt: nowIso,
        });
        deferred++;
        log.say(
          'integrate',
          'integrate:question-deferred',
          `The operator has been silent, so I am holding my question to ${this.deps.botName?.(b.bot) ?? b.bot} until they write: "${clip(b.text, 120)}".`,
          {
            neuronIds: [insight.id],
            whyNoBroadcast: 'operator silent',
            drivenBy: ['operatorSilence'],
            source: 'watcher:integrate',
          }
        );
        continue;
      }
      const result = await this.deps.broadcaster.send({
        botId: b.bot,
        kind: b.kind,
        text: clip(b.text, 500),
        insightId: insight.id,
        reason: insight.text,
        source: 'integrate',
      });
      broadcasts.push(result);
      if (result.status === 'delivered') deliveredFor.add(insight.id);
      this.noteRetry(insight.id, result.status);
    }
    retireActed();
    if (hasAgenda) this.st.agendaSettledAt = new Date(this.deps.now()).toISOString();
    if (deferred || hasAgenda || this.st.agendaRetryAt) this.persist();

    if (isCancelled()) return { status: 'cancelled' };

    const delivered = broadcasts.filter((b) => b.status === 'delivered').length;
    const createdIds = [...createdInsights, ...contradictions, ...preds].map((n) => n.id);
    log.say(
      'integrate',
      'integrate:pass',
      narrateIntegratePass({
        events: readItems.length,
        insights: createdInsights.length,
        contradictions: contradictions.length,
        predictions: preds.length,
        broadcasts: delivered,
      }),
      {
        ...cost,
        ...(createdIds.length ? { neuronIds: createdIds } : {}),
        ...(shownVariables.size || stakesDrove.length ? { drivenBy } : {}),
        trigger: opts.trigger ?? 'manual',
      }
    );
    return {
      status: 'integrated',
      insights: createdInsights,
      contradictions,
      predictions: preds,
      broadcasts,
    };
  }

  /** Adds `ids` to the covered agenda ids; true when anything was added. */
  /** Arms (failed, deferred, capped) or clears (delivered) an insight's agenda retry. */
  private noteRetry(insightId: string, status: BroadcastResult['status']): void {
    const retry = { ...(this.st.agendaRetryAt ?? {}) };
    if (status === 'delivered') delete retry[insightId];
    else if (status === 'failed' || status === 'deferred' || status === 'capped') {
      retry[insightId] = new Date(this.deps.now()).toISOString();
    } else return;
    this.st.agendaRetryAt = Object.keys(retry).length ? retry : undefined;
  }

  private retireAgenda(ids: string[]): boolean {
    if (!ids.length) return false;
    this.st.agendaCovered = uniq([...(this.st.agendaCovered ?? []), ...ids]).slice(
      -AGENDA_COVERED_MAX
    );
    return true;
  }

  /** A self-model reader that throws only drops its section. */
  private readSelf<T>(read: () => T | undefined): T | undefined {
    try {
      return read();
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher integrate: a self-model reader failed');
      return undefined;
    }
  }

  private refused(res: Exclude<WatcherCallResult, { ok: true }>): IntegrateOutcome {
    const { log, budget } = this.deps;
    if (res.reason === 'error') {
      log.say('integrate', 'integrate:failed', narrateIntegrateFailed({ error: res.error }), {
        model: res.model,
        durationMs: res.durationMs,
        source: 'watcher:integrate',
      });
      return { status: 'failed', error: res.error };
    }
    if (res.reason === 'breaker') {
      if (!this.pausedLogged) {
        this.pausedLogged = true;
        log.say(
          'integrate',
          'integrate:paused',
          narrateIntegratePaused({ backend: this.deps.client.backend })
        );
      }
      return { status: 'breaker' };
    }
    if (budget.firstCapToday('integrate')) {
      const cfg = this.deps.config().integrate;
      log.say(
        'integrate',
        'integrate:capped',
        narrateIntegrateCapped(
          res.reason === 'tokens'
            ? { reason: 'tokens', maxTokensPerDay: cfg.maxTokensPerDay }
            : { reason: 'cap', maxPerDay: cfg.maxPerDay }
        )
      );
    }
    return { status: 'capped' };
  }

  /** Neurons within 2 hops of the seeds (seeds excluded), live, capped. */
  private neighbourhood(seeds: string[]): Neuron[] {
    const seen = new Set(seeds);
    const out: Neuron[] = [];
    let frontier = seeds;
    for (let hop = 0; hop < 2 && out.length < INTEGRATE_NEIGHBOURHOOD_MAX; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const { neuron } of this.deps.graph.neighbours(id)) {
          if (seen.has(neuron.id) || neuron.archivedAt) continue;
          seen.add(neuron.id);
          next.push(neuron.id);
          out.push(neuron);
          if (out.length >= INTEGRATE_NEIGHBOURHOOD_MAX) return out;
        }
      }
      frontier = next;
    }
    return out;
  }

  private countToday(botId: string): number {
    try {
      return this.deps.broadcaster?.countToday?.(botId) ?? 0;
    } catch {
      return 0;
    }
  }

  /** What each insight already broadcast (bot name, kind, status); empty without a broadcaster list. */
  private broadcastsByInsight(): Map<string, IntegrateInsightBroadcast[]> {
    const out = new Map<string, IntegrateInsightBroadcast[]>();
    let all: ReturnType<NonNullable<Broadcaster['list']>> = [];
    try {
      all = this.deps.broadcaster?.list?.() ?? [];
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher integrate: could not read the broadcasts');
    }
    const botName = this.deps.botName ?? ((id: string) => id);
    const nowMs = this.deps.now();
    for (const b of all) {
      // An open record past BROADCAST_INFLIGHT_MAX_MS was left by a process
      // that died mid-delivery: failed, not in flight forever.
      const status: IntegrateInsightBroadcast['status'] = b.deliveredAt
        ? 'delivered'
        : b.deferred
          ? 'deferred'
          : b.deliveryError !== undefined || isStaleOpen(b, nowMs)
            ? 'failed'
            : 'in flight';
      const list = out.get(b.insightId) ?? [];
      list.push({
        bot: botName(b.botId),
        kind: b.kind,
        status,
        ...(b.source === 'fast-lane' ? { source: b.source } : {}),
        createdAt: b.createdAt,
      });
      out.set(b.insightId, list);
    }
    return out;
  }

  /**
   * Knowledge no event brings up: the strongest cross-bot `related` pairs no
   * insight stands on yet (both ends cited by one insight, edge `caused`),
   * and insights at medium confidence or more with no delivered or in-flight
   * broadcast (an open record past `BROADCAST_INFLIGHT_MAX_MS` is failed) and
   * no `whyNoBroadcast`. What a pass said it covered
   * (`agendaCovered`) never comes back. At most `max` of each.
   */
  private standingAgenda(
    max: number,
    sent: Map<string, IntegrateInsightBroadcast[]>
  ): IntegrateAgenda {
    if (max <= 0) return { pairs: [], insights: [] };
    const { graph } = this.deps;
    const covered = new Set(this.st.agendaCovered ?? []);
    const live = (n: Neuron | undefined): n is Neuron => !!n && !n.archivedAt;
    const insightsOf = (id: string) =>
      new Set(
        graph
          .edgesOf(id)
          .filter((e) => e.rel === 'caused' && e.from === id)
          .map((e) => e.to)
      );
    const pairs: IntegrateAgendaPair[] = [];
    const insights: Neuron[] = [];
    for (const n of graph.list()) {
      if (!live(n)) continue;
      if (n.kind === 'insight') {
        if (covered.has(n.id) || n.meta?.whyNoBroadcast) continue;
        if (n.confidence !== 'medium' && n.confidence !== 'high') continue;
        const acted = (sent.get(n.id) ?? []).some(
          (b) => b.status === 'delivered' || b.status === 'in flight'
        );
        if (!acted) insights.push(n);
        continue;
      }
      if (!AGENDA_KINDS.has(n.kind)) continue;
      let onA: Set<string> | undefined;
      for (const e of graph.edgesOf(n.id)) {
        if (e.rel !== 'related' || e.from !== n.id || covered.has(e.id)) continue;
        const m = graph.get(e.to);
        if (!live(m) || !AGENDA_KINDS.has(m.kind) || !crossBot(n, m)) continue;
        if (!onA) onA = insightsOf(n.id);
        const on = onA;
        if ([...insightsOf(m.id)].some((id) => on.has(id))) continue;
        pairs.push({ id: e.id, weight: e.weight, a: n, b: m, createdAt: e.createdAt });
      }
    }
    pairs.sort((x, y) => y.weight - x.weight);
    insights.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return { pairs: pairs.slice(0, max), insights: insights.slice(0, max) };
  }

  private latest(kind: NeuronKind, n: number): Neuron[] {
    return this.deps.graph
      .list()
      .filter((x) => x.kind === kind && !x.archivedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, n);
  }

  private meta(ctx: ApplyCtx, support: Neuron[], extra: Record<string, string>) {
    const operator = ctx.operatorSourced || support.some((n) => isOperatorSourced(n));
    const eventAt =
      ctx.eventAt ??
      support
        .map((n) => n.meta?.eventAt)
        .filter((x): x is string => typeof x === 'string')
        .sort()[0];
    return {
      source: 'integrate',
      model: ctx.model,
      ...(eventAt ? { eventAt } : {}),
      ...extra,
      ...(operator ? { [OPERATOR_SOURCED]: 'true' } : {}),
    };
  }

  private supportOf(neurons: Neuron[], extraBots: string[] = []) {
    const bots = uniq([...neurons.flatMap((n) => n.support.bots), ...extraBots]);
    const conversations = uniq(neurons.flatMap((n) => n.support.conversations ?? []));
    const cycles = uniq(neurons.flatMap((n) => n.support.cycles ?? []));
    return {
      bots,
      ...(conversations.length ? { conversations } : {}),
      ...(cycles.length ? { cycles } : {}),
    };
  }

  private place(id: string, kind: NeuronKind, around: Neuron[]): Vec3 {
    const pos = around.map((n) => n.pos).filter((p): p is Vec3 => Array.isArray(p));
    return placeWithoutEmbedding({ id, kind }, pos);
  }

  private async insight(
    i: IntegrateInsightOut,
    ctx: ApplyCtx,
    isCancelled: () => boolean,
    act: {
      proposed: boolean;
      /** Insights a broadcast of this pass names by `insightId`. */
      proposedIds?: Set<string>;
      bots: Array<{ id: string; name: string }>;
    } = {
      proposed: false,
      bots: [],
    }
  ): Promise<{ neuron: Neuron; created: boolean } | null> {
    const { graph, log } = this.deps;
    const text = clip(i.text, MAX_TEXT);
    if (!text) return null;
    const support = uniq(i.support)
      .map((id) => ctx.shown.get(id))
      .filter((n): n is Neuron => !!n);
    if (support.length === 0) return null;

    const same = graph
      .findSimilarText(text, INTEGRATE_DEDUPE_TEXT)
      .find((n) => n.kind === 'insight');
    const why = i.whyNoBroadcast ? clip(i.whyNoBroadcast, 200) : undefined;
    if (same) {
      const active = graph.activate(same.id) ?? same;
      // Same rule as a created insight: a proposed broadcast drops the reason.
      const proposed = act.proposed || act.proposedIds?.has(same.id) === true;
      if (why && !proposed) graph.patchMeta(active.id, { whyNoBroadcast: why });
      log.say(
        'integrate',
        'integrate:recognised',
        narrateNoticeRecognised({ text: active.text, activations: active.activations }),
        {
          neuronIds: [active.id],
          source: 'watcher:integrate',
          ...(why && !proposed ? { whyNoBroadcast: why } : {}),
        }
      );
      return { neuron: active, created: false };
    }
    // Embedded before the neuron is written: an embedding that settles after a
    // stop drops the whole insight instead of leaving a half-linked neuron.
    let vec: number[] | undefined;
    if (this.deps.embed) {
      try {
        vec = await this.deps.embed(text);
      } catch {
        // an insight without an embedding is still kept
      }
      if (isCancelled()) return null;
    }
    const neuron = graph.addNeuron({
      kind: 'insight',
      text,
      support: this.supportOf(support),
      createdBy: 'watcher',
      activations: 1,
      ...(isConfidence(i.confidence) ? { confidence: i.confidence } : {}),
      pos: this.place(text, 'insight', support),
      meta: this.meta(ctx, support, {
        supportNeurons: support.map((n) => n.id).join(','),
        ...(why && !act.proposed ? { whyNoBroadcast: why } : {}),
      }),
    });
    if (vec) graph.setEmbedding(neuron.id, vec);
    const edgeIds = support.map(
      (s) =>
        graph.addEdge({
          from: s.id,
          to: neuron.id,
          rel: 'caused',
          weight: 0.8,
          createdBy: 'watcher',
        }).id
    );
    const botName = this.deps.botName ?? ((id: string) => id);
    // An insight that should act names a broadcast or says why not; the row
    // shows which, so the operator can read the reasoning.
    const reasonMissing = !act.proposed && !why && insightNeedsBroadcast(neuron, act.bots);
    const noBroadcastWhy = !act.proposed ? why : undefined;
    log.say(
      'integrate',
      'integrate:insight',
      narrateIntegrateInsight({
        text,
        ...(neuron.confidence ? { confidence: neuron.confidence } : {}),
        bots: neuron.support.bots.map(botName),
        ...(noBroadcastWhy ? { whyNoBroadcast: noBroadcastWhy } : {}),
        ...(reasonMissing ? { reasonMissing: true } : {}),
      }),
      {
        neuronIds: [neuron.id],
        edgeIds,
        model: ctx.model,
        source: 'watcher:integrate',
        ...(noBroadcastWhy ? { whyNoBroadcast: noBroadcastWhy } : {}),
        ...(reasonMissing ? { broadcastReasonMissing: true as const } : {}),
      }
    );
    return { neuron, created: true };
  }

  private contradiction(c: IntegrateContradictionOut, ctx: ApplyCtx): Neuron | null {
    const { graph, log } = this.deps;
    const text = clip(c.text, MAX_TEXT);
    const a = ctx.shown.get(c.a);
    const b = ctx.shown.get(c.b);
    if (!text || !a || !b || a.id === b.id) return null;
    const neuron = graph.addNeuron({
      kind: 'contradiction',
      text,
      support: this.supportOf([a, b]),
      createdBy: 'watcher',
      activations: 1,
      pos: this.place(text, 'contradiction', [a, b]),
      meta: this.meta(ctx, [a, b], { a: a.id, b: b.id }),
    });
    const edgeIds = [a, b].map(
      (x) =>
        graph.addEdge({
          from: neuron.id,
          to: x.id,
          rel: 'contradicts',
          weight: 1,
          createdBy: 'watcher',
        }).id
    );
    log.say('integrate', 'integrate:contradiction', narrateIntegrateContradiction({ text }), {
      neuronIds: [neuron.id, a.id, b.id],
      edgeIds,
      model: ctx.model,
      source: 'watcher:integrate',
    });
    return neuron;
  }

  private prediction(
    p: IntegratePredictionOut,
    ctx: ApplyCtx,
    bots: Array<{ id: string }>
  ): Neuron | null {
    const { graph, log } = this.deps;
    const text = clip(p.text, MAX_TEXT);
    if (!text) return null;
    const about = p.about && bots.some((b) => b.id === p.about) ? p.about : undefined;
    const on = uniq(p.neuronIds)
      .map((id) => ctx.shown.get(id))
      .filter((n): n is Neuron => !!n);
    const horizon = Math.min(
      MAX_HORIZON_HOURS,
      Math.max(1, Math.round(Number.isFinite(p.horizonHours) ? (p.horizonHours as number) : 24))
    );
    const raw =
      typeof p.probability === 'number' && Number.isFinite(p.probability)
        ? p.probability
        : isConfidence(p.confidence)
          ? CONFIDENCE_PROBABILITY[p.confidence]
          : 0.6;
    const probability = Math.min(0.99, Math.max(0.01, raw));
    const dueAt = new Date(this.deps.now() + horizon * HOUR_MS).toISOString();
    const neuron = graph.addNeuron({
      kind: 'prediction',
      text,
      support: this.supportOf(on, about ? [about] : []),
      createdBy: 'watcher',
      activations: 1,
      pos: this.place(text, 'prediction', on),
      meta: this.meta(ctx, on, {
        probability: String(probability),
        horizonHours: String(horizon),
        dueAt,
        ...(about ? { about } : {}),
      }),
    });
    const edgeIds = on.map(
      (x) =>
        graph.addEdge({
          from: neuron.id,
          to: x.id,
          rel: 'predicts',
          weight: 0.6,
          createdBy: 'watcher',
        }).id
    );
    log.say(
      'integrate',
      'integrate:prediction',
      narrateIntegratePrediction({ text, probability, horizonHours: horizon }),
      {
        neuronIds: [neuron.id],
        ...(edgeIds.length ? { edgeIds } : {}),
        model: ctx.model,
        source: 'watcher:integrate',
      }
    );
    return neuron;
  }
}

/** Two neurons known by different bots (one has a bot the other lacks). */
function crossBot(a: Neuron, b: Neuron): boolean {
  const A = new Set(a.support.bots);
  const B = new Set(b.support.bots);
  if (A.size === 0 || B.size === 0) return false;
  return [...A].some((x) => !B.has(x)) || [...B].some((x) => !A.has(x));
}

/**
 * An insight that should come with a broadcast or a `whyNoBroadcast`:
 * confidence medium or high, supported by two or more bots, and naming one
 * of the bots (its name or id, as a whole word).
 */
export function insightNeedsBroadcast(
  n: Pick<Neuron, 'text' | 'support' | 'confidence'>,
  bots: Array<{ id: string; name: string }>
): boolean {
  if (n.confidence !== 'medium' && n.confidence !== 'high') return false;
  if (new Set(n.support.bots).size < 2) return false;
  return bots.some((b) => [b.name, b.id].some((w) => mentionsWord(n.text, w)));
}

interface ApplyCtx {
  shown: Map<string, Neuron>;
  model: string;
  eventAt?: string;
  operatorSourced: boolean;
}

function predictionRow(n: Neuron): IntegratePredictionRow {
  const m = n.meta ?? {};
  return {
    id: n.id,
    text: n.text,
    dueAt: m.dueAt ?? n.createdAt,
    ...(m.resolvedAt
      ? {
          resolved:
            m.outcome === 'unknown'
              ? { unknown: true as const }
              : { happened: m.happened === 'true', brier: Number(m.brier) || 0 },
        }
      : {}),
  };
}
