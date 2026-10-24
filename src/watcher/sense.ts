/**
 * Tier 0: sense every activity-stream event and every `human_inbound` hook
 * event, score it (`salience.ts`), keep what scores in the working buffer,
 * activate the neurons it touches (and the bot that owns a touched goal or
 * topic, edge `owned_by`, so the bot lights up with its goal), and log only
 * what matters: a row when the salience reaches `notice.salienceBar` (a touch
 * below it activates silently), plus one summary row per
 * `log.senseSummaryEveryMs` window that saw anything (it counts every event).
 * Privacy: text from anyone but the operator is reduced to topic words here,
 * before anything is stored. Operator messages from the operator surfaces
 * (private Telegram chat, dashboard thread) arrive on `operator_message` and
 * are kept verbatim, flagged `fromOperator`. A listener never throws into the
 * publisher, and never works in its call: the listeners only queue the event,
 * and the queue is sensed in one batch on the next macrotask (`defer`), so a
 * bot's `ActivityStream.publish` costs a push. `flush()` senses the queue at
 * once (the watcher calls it before reading the buffer and on stop).
 */
import { randomBytes } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import {
  HUMAN_INBOUND_HOOK,
  type HumanInboundEvent,
  OPERATOR_MESSAGE_HOOK,
  type OperatorMessageEvent,
} from '../bot/agent-loop-utils';
import type { WorkingBuffer } from './buffer';
import type { Graph } from './graph';
import type { WatcherLog } from './log';
import { describeEvent, narrateNoticed, narrateSenseSummary } from './narration';
import { REPEAT_WINDOW_MS, privateView, repeatKey, scoreEvent, withoutNovelty } from './salience';
import {
  type BufferItem,
  type SensedEvent,
  type WatcherConfig,
  type WatcherLogRow,
  isHumanInbound,
} from './types';

/** The watcher's own pseudo bot id; its events are never sensed back. */
export const WATCHER_BOT_ID = '__watcher__';

type Listenable = Pick<EventEmitter, 'on' | 'off'>;

export interface SenderInfo {
  name?: string;
  isOperator: boolean;
}

/**
 * Who wrote a `human_inbound`: the contact's name, never the operator. The
 * operator's surfaces (the private Telegram chat, the dashboard thread)
 * arrive on `operator_message` instead; Telegram never emits a
 * `human_inbound`, and on REST, web, WhatsApp and Discord the sender id is
 * client-supplied, so neither a chat id nor a directory contact's role can
 * make one the operator.
 */
export function inboundSender(
  _event: HumanInboundEvent,
  ctx: { contact?: { displayName?: string } | undefined }
): SenderInfo {
  const name = ctx.contact?.displayName;
  return { isOperator: false, ...(name ? { name } : {}) };
}

export interface SenseDeps {
  graph: Graph;
  buffer: WorkingBuffer;
  log: WatcherLog;
  config: () => WatcherConfig;
  now: () => number;
  botName?: (botId: string) => string;
  /** Who wrote a `human_inbound`; unknown senders are not the operator. */
  sender?: (event: HumanInboundEvent) => SenderInfo;
  /** Every item kept in the buffer (integrate accumulates them: notice drains the buffer). */
  onItem?: (item: BufferItem) => void;
  /** Schedules the batch that senses the queue (default `setImmediate`). */
  defer?: (fn: () => void) => void;
  /** After each batch that sensed anything, with the number of events in it. */
  onBatch?: (events: number) => void;
  logger?: { warn: (obj: object, msg: string) => void };
}

export class Sense {
  lastTickAt?: string;
  private attached: Array<{ target: Listenable; event: string; fn: (e: SensedEvent) => void }> = [];
  private windowStart: number | null = null;
  private windowCount = 0;
  private windowTop: { what: string; salience: number } | null = null;
  private windowRepeats = 0;
  /** Last time each repeat key was seen (`repeatKey`), pruned past the window. */
  private lastSeen = new Map<string, number>();
  private queue: Array<
    { operator: false; e: SensedEvent } | { operator: true; e: OperatorMessageEvent }
  > = [];
  private scheduled = false;

  constructor(private readonly deps: SenseDeps) {}

  attach(stream: Listenable, hooks: Listenable): void {
    this.detach();
    const onActivity = (e: SensedEvent) => this.enqueue({ operator: false, e });
    const onHuman = (e: SensedEvent) => this.enqueue({ operator: false, e });
    const onOperator = (e: OperatorMessageEvent) => this.enqueue({ operator: true, e });
    stream.on('activity', onActivity);
    hooks.on(HUMAN_INBOUND_HOOK, onHuman);
    hooks.on(OPERATOR_MESSAGE_HOOK, onOperator);
    this.attached = [
      { target: stream, event: 'activity', fn: onActivity },
      { target: hooks, event: HUMAN_INBOUND_HOOK, fn: onHuman },
      { target: hooks, event: OPERATOR_MESSAGE_HOOK, fn: onOperator as never },
    ];
  }

  detach(): void {
    for (const { target, event, fn } of this.attached) target.off(event, fn);
    this.attached = [];
  }

  /**
   * An operator message from an operator surface: sensed as a `human_inbound`
   * from the operator (verbatim). Returns the buffer item, or null without text.
   */
  handleOperator(raw: OperatorMessageEvent): BufferItem | null {
    if (!raw || typeof raw.botId !== 'string' || typeof raw.text !== 'string') return null;
    const text = raw.text.trim();
    if (!text) return null;
    const event: HumanInboundEvent = {
      botId: raw.botId,
      channelKind: raw.channelKind,
      chatId: 'operator',
      userId: 'operator',
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : this.deps.now(),
      text: text.slice(0, 1000),
    };
    return this.handle(event, { isOperator: true, name: 'the operator' });
  }

  /** Score one event; returns the buffer item when it scored anything. */
  handle(raw: SensedEvent, knownSender?: SenderInfo): BufferItem | null {
    if (!raw || typeof raw !== 'object' || typeof raw.botId !== 'string') return null;
    if (raw.botId === WATCHER_BOT_ID) return null;
    const nowMs = this.deps.now();
    this.tick();

    let event: SensedEvent = raw;
    let senderName: string | undefined;
    let fromOperator = false;
    if (isHumanInbound(raw)) {
      const who = knownSender ?? this.deps.sender?.(raw) ?? { isOperator: false };
      senderName = who.name;
      fromOperator = who.isOperator;
      event = privateView(raw, who.isOperator);
    }

    // The same event from the same bot within the window is a repeat: not
    // novel, no noticed row of its own, not buffered again; the summary counts it.
    const key = repeatKey(event);
    const repeat = key !== undefined && this.seenRecently(key, nowMs);
    const scored = scoreEvent(event, { graph: this.deps.graph, nowMs });
    const score = repeat ? withoutNovelty(scored) : scored;
    const noticedAt = new Date(nowMs).toISOString();
    this.lastTickAt = noticedAt;
    const what = describeEvent(event, {
      botName: this.deps.botName ?? ((id) => id),
      ...(senderName ? { sender: senderName } : {}),
    });

    if (this.windowStart === null) this.windowStart = nowMs;
    this.windowCount++;
    if (repeat) this.windowRepeats++;
    if (
      !repeat &&
      score.salience > 0 &&
      (!this.windowTop || score.salience > this.windowTop.salience)
    ) {
      this.windowTop = { what, salience: score.salience };
    }

    for (const id of score.touched) this.deps.graph.activate(id);
    for (const id of this.ownersOf(score.touched)) this.deps.graph.activate(id);

    if (repeat) return null;
    const bar = this.deps.config().notice.salienceBar;
    if (score.salience >= bar) {
      this.deps.log.say(
        'sense',
        'noticed',
        narrateNoticed({
          what,
          salience: score.salience,
          reasons: score.reasons,
          touched: score.touched.length,
        }),
        {
          salience: score.salience,
          source: isHumanInbound(event) ? HUMAN_INBOUND_HOOK : event.type,
          ...(score.touched.length ? { neuronIds: score.touched } : {}),
        }
      );
    }

    if (score.salience <= 0) return null;
    const item: BufferItem = {
      id: `b-${randomBytes(4).toString('hex')}`,
      event,
      salience: score.salience,
      reasons: score.reasons,
      noticedAt,
      touched: score.touched,
      ...(fromOperator ? { fromOperator: true as const } : {}),
    };
    this.deps.buffer.push(item);
    try {
      this.deps.onItem?.(item);
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher sense: an item listener threw');
    }
    return item;
  }

  /**
   * The bots (`entity` neurons, edge `owned_by`) that own the touched goal and
   * topic neurons, each once and never one that was touched itself.
   */
  ownersOf(touched: string[]): string[] {
    const graph = this.deps.graph;
    const seen = new Set(touched);
    const out: string[] = [];
    for (const id of touched) {
      const n = graph.get(id);
      if (!n || (n.kind !== 'goal' && n.kind !== 'topic')) continue;
      for (const e of graph.edgesOf(id)) {
        if (e.rel !== 'owned_by' || e.from !== id || seen.has(e.to)) continue;
        const owner = graph.get(e.to);
        if (!owner || owner.kind !== 'entity' || owner.archivedAt) continue;
        seen.add(e.to);
        out.push(e.to);
      }
    }
    return out;
  }

  /** True when `key` was seen within `REPEAT_WINDOW_MS`; records this sighting either way. */
  private seenRecently(key: string, nowMs: number): boolean {
    const last = this.lastSeen.get(key);
    this.lastSeen.set(key, nowMs);
    if (this.lastSeen.size > 500) {
      for (const [k, at] of this.lastSeen)
        if (nowMs - at >= REPEAT_WINDOW_MS) this.lastSeen.delete(k);
    }
    return last !== undefined && nowMs - last < REPEAT_WINDOW_MS;
  }

  /** Close the summary window when it has run its length and saw anything. */
  tick(): WatcherLogRow | null {
    if (this.windowStart === null || this.windowCount === 0) return null;
    const every = this.deps.config().log.senseSummaryEveryMs;
    if (this.deps.now() - this.windowStart < every) return null;
    const row = this.deps.log.say(
      'sense',
      'summary',
      narrateSenseSummary({
        events: this.windowCount,
        windowMs: every,
        ...(this.windowRepeats ? { repeats: this.windowRepeats } : {}),
        ...(this.windowTop
          ? { top: this.windowTop.what, topSalience: this.windowTop.salience }
          : {}),
      })
    );
    this.windowStart = null;
    this.windowCount = 0;
    this.windowTop = null;
    this.windowRepeats = 0;
    return row;
  }

  /** Sense every queued event now, in arrival order. Never throws. */
  flush(): void {
    this.scheduled = false;
    let sensed = 0;
    while (this.queue.length > 0) {
      const batch = this.queue;
      this.queue = [];
      for (const q of batch) {
        if (q.operator) this.safeHandleOperator(q.e);
        else this.safeHandle(q.e);
        sensed++;
      }
    }
    if (sensed === 0) return;
    try {
      this.deps.onBatch?.(sensed);
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher sense: a batch listener threw');
    }
  }

  private enqueue(
    item: { operator: false; e: SensedEvent } | { operator: true; e: OperatorMessageEvent }
  ): void {
    this.queue.push(item);
    if (this.scheduled) return;
    this.scheduled = true;
    try {
      (this.deps.defer ?? ((fn: () => void) => setImmediate(fn)))(() => this.flush());
    } catch (err) {
      this.scheduled = false;
      this.deps.logger?.warn({ err }, 'Watcher sense: could not schedule sensing');
    }
  }

  private safeHandleOperator(event: OperatorMessageEvent): void {
    try {
      this.handleOperator(event);
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher sense: failed to handle an operator message');
    }
  }

  private safeHandle(event: SensedEvent): void {
    try {
      this.handle(event);
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher sense: failed to handle an event');
    }
  }
}
