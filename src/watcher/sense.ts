/**
 * Tier 0: sense every activity-stream event and every `human_inbound` hook
 * event, score it (`salience.ts`), keep what scores in the working buffer,
 * activate the neurons it touches, and log only what matters: a row when the
 * salience reaches `notice.salienceBar` or a neuron was touched, plus one
 * summary row per `log.senseSummaryEveryMs` window that saw anything.
 * Privacy: text from anyone but the operator is reduced to topic words here,
 * before anything is stored. Operator messages from the operator surfaces
 * (private Telegram chat, dashboard thread) arrive on `operator_message` and
 * are kept verbatim, flagged `fromOperator`. A listener never throws into the
 * publisher.
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
import { privateView, scoreEvent } from './salience';
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

export interface SenseDeps {
  graph: Graph;
  buffer: WorkingBuffer;
  log: WatcherLog;
  config: () => WatcherConfig;
  now: () => number;
  botName?: (botId: string) => string;
  /** Who wrote a `human_inbound`; unknown senders are not the operator. */
  sender?: (event: HumanInboundEvent) => SenderInfo;
  logger?: { warn: (obj: object, msg: string) => void };
}

export class Sense {
  lastTickAt?: string;
  private attached: Array<{ target: Listenable; event: string; fn: (e: SensedEvent) => void }> = [];
  private windowStart: number | null = null;
  private windowCount = 0;
  private windowTop: { what: string; salience: number } | null = null;

  constructor(private readonly deps: SenseDeps) {}

  attach(stream: Listenable, hooks: Listenable): void {
    this.detach();
    const onActivity = (e: SensedEvent) => this.safeHandle(e);
    const onHuman = (e: SensedEvent) => this.safeHandle(e);
    const onOperator = (e: OperatorMessageEvent) => this.safeHandleOperator(e);
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

    const score = scoreEvent(event, { graph: this.deps.graph, nowMs });
    const noticedAt = new Date(nowMs).toISOString();
    this.lastTickAt = noticedAt;
    const what = describeEvent(event, {
      botName: this.deps.botName ?? ((id) => id),
      ...(senderName ? { sender: senderName } : {}),
    });

    if (this.windowStart === null) this.windowStart = nowMs;
    this.windowCount++;
    if (score.salience > 0 && (!this.windowTop || score.salience > this.windowTop.salience)) {
      this.windowTop = { what, salience: score.salience };
    }

    for (const id of score.touched) this.deps.graph.activate(id);

    const bar = this.deps.config().notice.salienceBar;
    if (score.salience >= bar || score.touched.length > 0) {
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
    return item;
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
        ...(this.windowTop
          ? { top: this.windowTop.what, topSalience: this.windowTop.salience }
          : {}),
      })
    );
    this.windowStart = null;
    this.windowCount = 0;
    this.windowTop = null;
    return row;
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
