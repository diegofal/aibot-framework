/**
 * Tier 2: integration (phase 3). Notice drains the working buffer, so the
 * integrator keeps its own "since my last thought" accumulation: every buffer
 * item tier 0 pushed (`observe`) and every neuron notice created or recognised
 * (`observeNotice`). A pass is due when that salience reaches
 * `integrate.salienceBar`, or on the heartbeat (`integrate.heartbeatMs`) with
 * anything pending, never closer than `INTEGRATE_MIN_GAP_MS` to the previous
 * attempt, and only while `integrate.enabled`.
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
import type { BroadcastResult, Broadcaster } from './broadcast';
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

function emptyState(): IntegrateState {
  return { attending: [], pending: { items: [], neurons: [], salience: 0 } };
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

  due(): boolean {
    const cfg = this.deps.config().integrate;
    if (!cfg.enabled) return false;
    const p = this.st.pending;
    if (p.items.length === 0 && p.neurons.length === 0) return false;
    const nowMs = this.deps.now();
    const attempt = this.st.lastAttemptAt ? Date.parse(this.st.lastAttemptAt) : undefined;
    if (attempt !== undefined && nowMs - attempt < INTEGRATE_MIN_GAP_MS) return false;
    if (p.salience >= cfg.salienceBar) return true;
    // The heartbeat waits for enough salient items: a pass on 1-3 events had
    // nothing to integrate (live, 2026-10-24).
    if (p.items.length < (cfg.minItems ?? 1)) return false;
    const last = this.st.lastRunAt ? Date.parse(this.st.lastRunAt) : this.bornAt;
    return nowMs - last >= cfg.heartbeatMs;
  }

  /**
   * One pass; a call while one runs shares it, unless that one's run was
   * cancelled (it writes nothing more, so a new run starts its own).
   */
  run(opts: PassOptions = {}): Promise<IntegrateOutcome> {
    if (this.inFlight && !this.inFlightCancelled()) return this.inFlight;
    const isCancelled = opts.isCancelled ?? (() => false);
    const run: Promise<IntegrateOutcome> = this.pass(isCancelled)
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
  private async pass(isCancelled: () => boolean): Promise<IntegrateOutcome> {
    const { graph, log } = this.deps;
    const cfg = this.deps.config();
    if (!cfg.integrate.enabled) return { status: 'idle' };
    const pending = this.st.pending;
    if (pending.items.length === 0 && pending.neurons.length === 0) return { status: 'idle' };
    if (isCancelled()) return { status: 'cancelled' };

    // Snapshot what this pass reads: anything observed meanwhile stays pending.
    const readItems = [...pending.items];
    const readNeurons = [...pending.neurons];
    const readSalience = pending.salience;
    this.st.lastAttemptAt = new Date(this.deps.now()).toISOString();
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
    const sentByInsight = this.broadcastsByInsight();
    const agenda = this.standingAgenda(cfg.integrate.agendaMax ?? 0, sentByInsight);
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
      insightBroadcasts: Object.fromEntries(
        insights
          .map((n) => [n.id, sentByInsight.get(n.id) ?? []] as const)
          .filter(([, v]) => v.length > 0)
      ),
      ...(agenda.pairs.length || agenda.insights.length ? { agenda } : {}),
      ...(interoception ? { interoception } : {}),
      ...(attention ? { attention } : {}),
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
    for (const [index, i] of out.insights.entries()) {
      if (isCancelled()) return { status: 'cancelled' };
      const proposed = out.broadcasts.some((b) => b.insightIndex === index && !b.insightId);
      const r = await this.insight(i, ctx, isCancelled, { proposed, bots });
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
    const covered = out.agendaCovered.filter((id) => agendaIds.has(id));
    if (covered.length) {
      this.st.agendaCovered = uniq([...(this.st.agendaCovered ?? []), ...covered]).slice(
        -AGENDA_COVERED_MAX
      );
    }
    const readIds = new Set(readItems.map((i) => i.id));
    const readNeuronIds = new Set(readNeurons);
    this.st.pending = {
      items: this.st.pending.items.filter((i) => !readIds.has(i.id)),
      neurons: this.st.pending.neurons.filter((id) => !readNeuronIds.has(id)),
      salience: Math.max(0, this.st.pending.salience - readSalience),
    };
    this.persist();

    const broadcasts: BroadcastResult[] = [];
    const botIds = new Set(bots.map((b) => b.id));
    const shownInsight = (id: string | undefined) => {
      const n = id ? (shown.get(id) ?? insightByIndex.find((x) => x?.id === id)) : undefined;
      return n?.kind === 'insight' ? n : undefined;
    };
    for (const nb of out.noBroadcast) {
      const insight = shownInsight(nb.insightId);
      if (!insight) continue;
      const why = clip(nb.why, 200);
      graph.patchMeta(insight.id, { whyNoBroadcast: why });
      log.say(
        'integrate',
        'integrate:no-broadcast',
        narrateIntegrateNoBroadcast({ insight: insight.text, why }),
        { neuronIds: [insight.id], whyNoBroadcast: why, source: 'watcher:integrate' }
      );
    }
    for (const b of out.broadcasts) {
      const insight = b.insightId ? shownInsight(b.insightId) : insightByIndex[b.insightIndex];
      if (
        !insight ||
        !botIds.has(b.bot) ||
        !(BROADCAST_KINDS as readonly string[]).includes(b.kind)
      )
        continue;
      if (!this.deps.broadcaster) continue;
      if (isCancelled()) return { status: 'cancelled' };
      broadcasts.push(
        await this.deps.broadcaster.send({
          botId: b.bot,
          kind: b.kind,
          text: clip(b.text, 500),
          insightId: insight.id,
          reason: insight.text,
        })
      );
    }

    if (isCancelled()) return { status: 'cancelled' };

    const shownVariables = new Set(Object.keys(interoception ?? {}));
    const drivenBy = uniq(out.drivenBy.filter((k) => shownVariables.has(k)));
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
        ...(shownVariables.size ? { drivenBy } : {}),
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
    for (const b of all) {
      const status: IntegrateInsightBroadcast['status'] = b.deliveredAt
        ? 'delivered'
        : b.deferred
          ? 'deferred'
          : b.deliveryError !== undefined
            ? 'failed'
            : 'in flight';
      const list = out.get(b.insightId) ?? [];
      list.push({ bot: botName(b.botId), kind: b.kind, status });
      out.set(b.insightId, list);
    }
    return out;
  }

  /**
   * Knowledge no event brings up: the strongest cross-bot `related` pairs no
   * insight stands on yet (both ends cited by one insight, edge `caused`),
   * and insights at medium confidence or more with no delivered or in-flight
   * broadcast and no `whyNoBroadcast`. What a pass said it covered
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
      for (const e of graph.edgesOf(n.id)) {
        if (e.rel !== 'related' || e.from !== n.id || covered.has(e.id)) continue;
        const m = graph.get(e.to);
        if (!live(m) || !AGENDA_KINDS.has(m.kind) || !crossBot(n, m)) continue;
        const onA = insightsOf(n.id);
        if ([...insightsOf(m.id)].some((id) => onA.has(id))) continue;
        pairs.push({ id: e.id, weight: e.weight, a: n, b: m });
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
    act: { proposed: boolean; bots: Array<{ id: string; name: string }> } = {
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
      if (why) graph.patchMeta(active.id, { whyNoBroadcast: why });
      log.say(
        'integrate',
        'integrate:recognised',
        narrateNoticeRecognised({ text: active.text, activations: active.activations }),
        {
          neuronIds: [active.id],
          source: 'watcher:integrate',
          ...(why && !act.proposed ? { whyNoBroadcast: why } : {}),
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
      ? { resolved: { happened: m.happened === 'true', brier: Number(m.brier) || 0 } }
      : {}),
  };
}
