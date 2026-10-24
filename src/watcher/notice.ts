/**
 * Tier 1: noticing (phase 2). When the salient items waiting add up to
 * `notice.wakeSalience` (an operator message at once), or the oldest has
 * waited `notice.maxWaitMs` (O2, `wake`), the watcher shows the salient part of the working buffer and
 * the neurons it touched to a cheap model and keeps what is worth remembering
 * as new neurons (`createdBy: 'watcher'`), merging into an existing one when
 * the text (`textSimilarity ≥ 0.8`) or, with embeddings, the meaning
 * (`≥ graph.relatedThreshold`) is already known. A recognition unions the
 * pass items' bots and cycles into that neuron's support (`Graph.addSupport`)
 * and marks it `operatorSourced` by the same rule as a new one (never unmarks).
 *
 * Code decides what the model sees (`noticeItems`: tier 0 already reduced
 * non-operator text to topic words; tool args and results never reach it) and
 * what a kept item becomes: its support (bots, cycles) is built from the
 * buffer items it names, never from what the model claims, and a "fact" that
 * only non-operator messages support is kept as a topic. A neuron is
 * `operatorSourced` unless every item behind it is a non-operator message
 * (`restsOnOperatorMaterial`: bot activity — cycles, tools, surprises, workers,
 * goals, tasks — is operator material), and also whenever an operator-sourced
 * neuron was among the touched neurons the prompt showed in full. Every row is
 * code-written; model text appears only quoted. Budget and breaker are
 * consulted by the instrumented client before every call; a capped day logs
 * one row, an open circuit one row per episode. The buffer is drained only
 * after an answer was read; a failure keeps it for the next pass. Never throws.
 */
import { createHash } from 'node:crypto';
import { parseLLMJson } from '../bot/llm-json-parser';
import type { DailyBudget } from './budget';
import type { WorkingBuffer } from './buffer';
import type { Graph } from './graph';
import { placeWithoutEmbedding } from './layout';
import type { InstrumentedClient, WatcherCallResult } from './llm';
import type { WatcherLog } from './log';
import {
  describeEvent,
  narrateNoticeCapped,
  narrateNoticeFailed,
  narrateNoticeLearned,
  narrateNoticePass,
  narrateNoticePaused,
  narrateNoticeRecognised,
  narrateNoticeUnparsable,
} from './narration';
import {
  NOTICE_KEEP_KINDS,
  type NoticeKeepKind,
  type NoticePromptItem,
  buildNoticePrompt,
} from './prompts';
import { noticeWake } from './sense';
import {
  type BufferItem,
  type Confidence,
  type Neuron,
  OPERATOR_MESSAGE,
  OPERATOR_SOURCED,
  type PassTrigger,
  type Vec3,
  type WatcherConfig,
  isHumanInbound,
  isOperatorSourced,
  isPublicHumanItem,
  restsOnOperatorMaterial,
} from './types';

/** Most buffer items one pass shows the model (the most salient first). */
export const NOTICE_MAX_ITEMS = 20;
/** Never two passes closer than this, early or not. */
export const NOTICE_MIN_GAP_MS = 60_000;
/** Text similarity at which a kept item is the same as an existing neuron. */
export const NOTICE_DEDUPE_TEXT = 0.8;
const MAX_TEXT = 300;
const DETAIL_MAX = 300;
const NOTICE_TEMPERATURE = 0.2;
/** Event fields the model may see; never `args`, `result` or message bodies. */
const DETAIL_KEYS = [
  'summary',
  'plan',
  'planSummary',
  'focus',
  'goalTitle',
  'reason',
  'error',
  'status',
  'question',
  'from',
  'to',
  'delta',
] as const;

export interface NoticeKeep {
  text: string;
  kind: string;
  confidence?: string;
  from?: string[];
  relatedTo?: string[];
}

export interface NoticeOutput {
  keep: NoticeKeep[];
  drop: string[];
  touched: string[];
}

export type NoticeOutcome =
  | { status: 'idle' }
  | { status: 'capped' | 'breaker' }
  | { status: 'failed'; error: string }
  | { status: 'unparsable' }
  | { status: 'noticed'; created: Neuron[]; recognised: Neuron[] }
  /** Its run was stopped: nothing written after that (graph, buffer, log). */
  | { status: 'cancelled' };

/** Per-run cancellation (the watcher run's signal): a cancelled pass writes nothing more. */
export interface PassOptions {
  isCancelled?: () => boolean;
  /** O2: what woke the pass (on its pass row; default `manual`). */
  trigger?: PassTrigger;
  /** O3: the stakes rules that shaped the pass (on its pass row). */
  drivenBy?: string[];
}

export interface NoticeDeps {
  graph: Graph;
  buffer: WorkingBuffer;
  log: WatcherLog;
  client: Pick<InstrumentedClient, 'chat' | 'model' | 'backend'>;
  budget: Pick<DailyBudget, 'firstCapToday'>;
  config: () => WatcherConfig;
  now: () => number;
  embed?: (text: string) => Promise<number[]>;
  botName?: (botId: string) => string;
  logger?: { warn: (obj: object, msg: string) => void };
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** The model's answer, or null when it is not the notice JSON. */
export function parseNoticeOutput(
  text: string,
  logger: { warn: (obj: object, msg: string) => void }
): NoticeOutput | null {
  const warnOnly = { warn: (obj: object, msg?: string) => logger.warn(obj, msg ?? '') };
  return parseLLMJson<NoticeOutput>(text ?? '', warnOnly as never, {
    label: 'watcher notice',
    extractPattern: /\{[\s\S]*"keep"[\s\S]*\}/,
    validate: (raw) => {
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.keep)) return null;
      const keep: NoticeKeep[] = raw.keep
        .filter((k: unknown) => k && typeof k === 'object')
        .map((k: Record<string, unknown>) => ({
          text: typeof k.text === 'string' ? k.text : '',
          kind: typeof k.kind === 'string' ? k.kind : '',
          ...(typeof k.confidence === 'string' ? { confidence: k.confidence } : {}),
          ...(Array.isArray(k.from) ? { from: strList(k.from) } : {}),
          ...(Array.isArray(k.relatedTo) ? { relatedTo: strList(k.relatedTo) } : {}),
        }));
      return { keep, drop: strList(raw.drop), touched: strList(raw.touched) };
    },
  });
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function detailOf(item: BufferItem): string | undefined {
  if (isHumanInbound(item.event)) return undefined;
  const data = (item.event.data ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of DETAIL_KEYS) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) parts.push(`${key}: ${v}`);
    else if (typeof v === 'number' && Number.isFinite(v)) parts.push(`${key}: ${v}`);
  }
  return parts.length ? clip(parts.join(' · '), DETAIL_MAX) : undefined;
}

/** Buffer items as the prompt sees them. */
export function noticeItems(
  items: BufferItem[],
  botName: (botId: string) => string
): NoticePromptItem[] {
  return items.map((item) => {
    const fromOperator = item.fromOperator === true;
    const detail = detailOf(item);
    return {
      id: item.id,
      botId: item.event.botId,
      bot: botName(item.event.botId),
      at: item.noticedAt,
      what: describeEvent(item.event, {
        botName,
        ...(fromOperator ? { sender: 'the operator' } : {}),
      }),
      ...(detail ? { detail } : {}),
      salience: item.salience,
      reasons: item.reasons,
      fromOperator,
    };
  });
}

const isKeepKind = (k: string): k is NoticeKeepKind =>
  (NOTICE_KEEP_KINDS as readonly string[]).includes(k);
const isConfidence = (c: unknown): c is Confidence => c === 'low' || c === 'medium' || c === 'high';

export class Noticer {
  lastRunAt: number;
  private inFlight: Promise<NoticeOutcome> | null = null;
  private inFlightCancelled: () => boolean = () => false;
  private pausedLogged = false;

  constructor(private readonly deps: NoticeDeps) {
    this.lastRunAt = deps.now();
  }

  /** A pass is due when `wake` says why. */
  due(): boolean {
    return this.wake() !== null;
  }

  /**
   * Why a pass should run now (O2, `noticeWake`): salience (`wakeSalience`,
   * possibly raised by the stakes; an operator message at once) or age
   * (`notice.maxWaitMs`); never within `NOTICE_MIN_GAP_MS` of the last pass.
   */
  wake(opts: { wakeSalience?: number } = {}): Extract<PassTrigger, 'salience' | 'age'> | null {
    const cfg = this.deps.config().notice;
    const nowMs = this.deps.now();
    if (nowMs - this.lastRunAt < NOTICE_MIN_GAP_MS) return null;
    return noticeWake({
      items: this.deps.buffer.items(),
      bar: cfg.salienceBar,
      wakeSalience: opts.wakeSalience ?? cfg.wakeSalience,
      maxWaitMs: cfg.maxWaitMs,
      nowMs,
      sinceMs: this.lastRunAt,
    });
  }

  /**
   * One pass; a call while one runs shares it, unless that one's run was
   * cancelled (a stopped run's pass may still wait on an embedding that cannot
   * be aborted; it writes nothing more, so a new run starts its own).
   */
  run(opts: PassOptions = {}): Promise<NoticeOutcome> {
    if (this.inFlight && !this.inFlightCancelled()) return this.inFlight;
    const isCancelled = opts.isCancelled ?? (() => false);
    const run: Promise<NoticeOutcome> = this.pass(isCancelled, opts)
      .catch((err): NoticeOutcome => {
        if (isCancelled()) return { status: 'cancelled' };
        this.deps.logger?.warn({ err }, 'Watcher notice: pass failed');
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
   * dropped), before every graph write, before `buffer.drain` and before the
   * log: after a stop the buffer was persisted and the graph compacted, so a
   * write here would land after the sleep row or in the next run's state.
   */
  private async pass(isCancelled: () => boolean, opts: PassOptions = {}): Promise<NoticeOutcome> {
    const { graph, buffer, log } = this.deps;
    const cfg = this.deps.config();
    const items = buffer
      .salient(cfg.notice.salienceBar)
      .sort((a, b) => b.salience - a.salience)
      .slice(0, NOTICE_MAX_ITEMS);
    if (items.length === 0) return { status: 'idle' };
    if (isCancelled()) return { status: 'cancelled' };
    this.lastRunAt = this.deps.now();

    const botName = this.deps.botName ?? ((id: string) => id);
    const touchedIds = [...new Set(items.flatMap((i) => i.touched))];
    const touched = touchedIds.map((id) => graph.get(id)).filter((n): n is Neuron => !!n);
    const prompt = buildNoticePrompt(noticeItems(items, botName), touched);
    // The prompt shows every touched neuron in full: if one is operator
    // material, anything the model writes may restate it (conservative).
    const shownOperator = touched.some((n) => isOperatorSourced(n));
    const res = await this.deps.client.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      { temperature: NOTICE_TEMPERATURE }
    );

    if (isCancelled()) return { status: 'cancelled' };
    if (!res.ok) return this.refused(res, items.length);
    this.pausedLogged = false;
    const cost = {
      model: res.model,
      tokens: res.tokens,
      ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
      durationMs: res.durationMs,
      source: 'watcher:notice',
    };

    const out = parseNoticeOutput(res.text, this.deps.logger ?? { warn: () => {} });
    if (!out) {
      log.say('notice', 'notice:failed', narrateNoticeUnparsable({ events: items.length }), cost);
      return { status: 'unparsable' };
    }

    const byId = new Map(items.map((i) => [i.id, i]));
    const created: Neuron[] = [];
    const recognised: Neuron[] = [];
    const used = new Set<string>();
    for (const keep of out.keep) {
      if (isCancelled()) return { status: 'cancelled' };
      const result = await this.keep(keep, byId, res.model, isCancelled, shownOperator);
      if (isCancelled()) return { status: 'cancelled' };
      if (!result) continue;
      for (const id of result.from) used.add(id);
      if (result.created) created.push(result.neuron);
      else recognised.push(result.neuron);
    }

    if (isCancelled()) return { status: 'cancelled' };
    const seen = new Set(touchedIds);
    for (const id of new Set(out.touched)) {
      if (!seen.has(id) && graph.get(id)) graph.activate(id);
    }

    buffer.drain(items.map((i) => i.id));
    log.say(
      'notice',
      'notice:pass',
      narrateNoticePass({
        events: items.length,
        kept: created.length,
        recognised: recognised.length,
        dropped: items.filter((i) => !used.has(i.id)).length,
      }),
      {
        ...cost,
        ...(created.length || recognised.length
          ? { neuronIds: [...created, ...recognised].map((n) => n.id) }
          : {}),
        trigger: opts.trigger ?? 'manual',
        ...(opts.drivenBy?.length ? { drivenBy: [...opts.drivenBy] } : {}),
      }
    );
    return { status: 'noticed', created, recognised };
  }

  private refused(res: Exclude<WatcherCallResult, { ok: true }>, events: number): NoticeOutcome {
    const { log, budget } = this.deps;
    if (res.reason === 'error') {
      log.say('notice', 'notice:failed', narrateNoticeFailed({ events, error: res.error }), {
        model: res.model,
        durationMs: res.durationMs,
        source: 'watcher:notice',
      });
      return { status: 'failed', error: res.error };
    }
    if (res.reason === 'breaker') {
      if (!this.pausedLogged) {
        this.pausedLogged = true;
        log.say(
          'notice',
          'notice:paused',
          narrateNoticePaused({ backend: this.deps.client.backend })
        );
      }
      return { status: 'breaker' };
    }
    if (budget.firstCapToday('notice')) {
      log.say(
        'notice',
        'notice:capped',
        narrateNoticeCapped({ maxPerDay: this.deps.config().notice.maxPerDay })
      );
    }
    return { status: 'capped' };
  }

  /** One kept item → a new neuron, or the existing one it repeats. Null when it is not usable. */
  private async keep(
    keep: NoticeKeep,
    items: Map<string, BufferItem>,
    model: string,
    isCancelled: () => boolean,
    shownOperator = false
  ): Promise<{ neuron: Neuron; created: boolean; from: string[] } | null> {
    const { graph, log } = this.deps;
    const text = clip(keep.text ?? '', MAX_TEXT);
    if (!text || !isKeepKind(keep.kind)) return null;
    const from = [...new Set(keep.from ?? [])].filter((id) => items.has(id));
    if (from.length === 0) return null;
    const support = from.map((id) => items.get(id) as BufferItem);

    // Privacy: a fact needs an operator message or a bot's own activity behind it.
    const onlyPublic = support.every(isPublicHumanItem);
    const kind: NoticeKeepKind = onlyPublic && keep.kind !== 'topic' ? 'topic' : keep.kind;

    const same = graph.findSimilarText(text, NOTICE_DEDUPE_TEXT)[0];
    let vec: number[] | undefined;
    let match = same;
    if (!match && this.deps.embed) {
      if (isCancelled()) return null;
      try {
        vec = await this.deps.embed(text);
        // Settled after a stop: the result belongs to no live run.
        if (isCancelled()) return null;
        match = graph.findSimilarEmbedding(vec, this.deps.config().graph.relatedThreshold)[0]
          ?.neuron;
      } catch {
        vec = undefined;
      }
    }
    if (isCancelled()) return null;
    const bots = [...new Set(support.map((i) => i.event.botId))];
    const cycles = [
      ...new Set(
        support
          .map((i) =>
            isHumanInbound(i.event)
              ? undefined
              : ((i.event.data ?? {}) as Record<string, unknown>).cycleId
          )
          .filter((c): c is string => typeof c === 'string' && c.length > 0)
      ),
    ];
    const operatorSourced = shownOperator || restsOnOperatorMaterial(support);
    // An operator message behind it: the fast lane never quotes it to a bot.
    const operatorMessage = support.some((i) => i.fromOperator === true);
    if (match) {
      graph.activate(match.id);
      // What this pass's items add: their bots and cycles join the support,
      // and operator material behind them marks it (never unmarks).
      if (isKeepKind(match.kind)) graph.addSupport(match.id, { bots, cycles });
      const marks: Record<string, string> = {
        ...(operatorSourced && !isOperatorSourced(match) ? { [OPERATOR_SOURCED]: 'true' } : {}),
        ...(operatorMessage && match.meta?.[OPERATOR_MESSAGE] !== 'true'
          ? { [OPERATOR_MESSAGE]: 'true' }
          : {}),
      };
      if (Object.keys(marks).length) graph.patchMeta(match.id, marks);
      const active = graph.get(match.id) ?? match;
      log.say(
        'notice',
        'notice:recognised',
        narrateNoticeRecognised({ text: active.text, activations: active.activations }),
        { neuronIds: [active.id], source: 'watcher:notice' }
      );
      return { neuron: active, created: false, from };
    }

    const owners = bots
      .map((b) => graph.findByKey(`bot:${b}`))
      .filter((n): n is Neuron => !!n && !n.archivedAt);
    const related = [...new Set(keep.relatedTo ?? [])]
      .map((id) => graph.get(id))
      .filter((n): n is Neuron => !!n && !n.archivedAt);
    const neighbourPos = [...owners, ...related]
      .map((n) => n.pos)
      .filter((p): p is Vec3 => Array.isArray(p));
    const hashId = `n-${createHash('sha1').update(text).digest('hex').slice(0, 8)}`;
    const eventAt = earliestEventAt(support);
    const neuron = graph.addNeuron({
      kind,
      text,
      support: { bots, ...(cycles.length ? { cycles } : {}) },
      createdBy: 'watcher',
      activations: 1,
      ...(isConfidence(keep.confidence) ? { confidence: keep.confidence } : {}),
      pos: placeWithoutEmbedding({ id: hashId, kind }, neighbourPos),
      meta: {
        source: 'notice',
        model,
        ...(eventAt ? { eventAt } : {}),
        ...(operatorSourced ? { [OPERATOR_SOURCED]: 'true' } : {}),
        ...(operatorMessage ? { [OPERATOR_MESSAGE]: 'true' } : {}),
      },
    });
    if (vec) graph.setEmbedding(neuron.id, vec);
    const edgeIds: string[] = [];
    for (const owner of owners) {
      edgeIds.push(
        graph.addEdge({
          from: neuron.id,
          to: owner.id,
          rel: 'owned_by',
          weight: 1,
          createdBy: 'watcher',
        }).id
      );
    }
    for (const r of related) {
      if (r.id === neuron.id) continue;
      edgeIds.push(
        graph.addEdge({
          from: neuron.id,
          to: r.id,
          rel: 'related',
          weight: 0.6,
          createdBy: 'watcher',
        }).id
      );
    }
    log.say(
      'notice',
      'notice:learned',
      narrateNoticeLearned({
        text: neuron.text,
        kind: neuron.kind,
        ...(neuron.confidence ? { confidence: neuron.confidence } : {}),
        bots: bots.map((b) => (this.deps.botName ?? ((id: string) => id))(b)),
      }),
      {
        neuronIds: [neuron.id],
        ...(edgeIds.length ? { edgeIds } : {}),
        model,
        source: 'watcher:notice',
      }
    );
    return { neuron, created: true, from };
  }
}

/** ISO time of the earliest event behind these buffer items (metric 2), or undefined. */
export function earliestEventAt(items: BufferItem[]): string | undefined {
  let min = Number.POSITIVE_INFINITY;
  for (const i of items) {
    const ts = (i.event as { timestamp?: unknown }).timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0 && ts < min) min = ts;
  }
  return Number.isFinite(min) ? new Date(min).toISOString() : undefined;
}
