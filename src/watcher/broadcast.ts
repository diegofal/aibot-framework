/**
 * Broadcasts: the watcher's downward path (phase 3). An insight can wake a
 * bot, give its planner a directive, add a goal, or ask the operator a
 * question, only through entry points that already exist (the delivery deps:
 * `requestImmediateAgentRun(botId, { feedback: false })`,
 * `CuriosityService.recordDirective(…, 'watcher')`, `writeWatcherGoal`, and
 * the shared `send_proactive_message` executor with `chatId: 'operator'`).
 *
 * Every broadcast is a record in `<dir>/broadcasts.jsonl` (append-only, last
 * line per id wins, like `RelayStore`). Caps, all counted from that file so a
 * restart never resets them: at most `maxPerBotPerDay` (3) per bot per UTC
 * day, and never two of the same kind for the same insight. The record is
 * written before delivery is awaited, so concurrent sends cannot both pass
 * the cap; a failed delivery still counts toward the daily cap, but is not a
 * duplicate: only a delivered (or still in flight) broadcast blocks another
 * of the same kind for the same insight, so a failed one may be retried.
 * A record still open (neither delivered nor failed) after
 * `BROADCAST_INFLIGHT_MAX_MS` was left by a process that exited mid-delivery
 * (`isStaleOpen`): it no longer blocks a retry, and on load it is closed as
 * failed ("interrupted"), so it keeps its slot of that day's cap.
 * A question the shared proactive throttle refused is `deferred`, not failed:
 * nothing was attempted, so it neither counts toward the cap nor blocks a
 * retry once the cooldown is over.
 * A question with no Telegram route or no operator chat is not a failure: it
 * lands in Work → Sent to you (`deliverWatcherQuestion`), so it is never
 * retried into the cap. Never throws.
 *
 * The planner sees what was delivered and not shown yet (`pendingFor`, 24 h)
 * in its "## Fleet broadcast" section; the cycle row names what it served
 * (`servesBroadcast`), which `outcomes.ts` turns into `servedByCycle`.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeGoalsFile } from '../bot/goal-events';
import { localDateStr } from '../date-utils';
import { appendGoal } from '../tools/goals';
import type { WatcherLog } from './log';
import { narrateBroadcast } from './narration';
import { BROADCAST_KINDS, type BroadcastKind } from './prompts';

export { BROADCAST_KINDS, type BroadcastKind };

export const BROADCAST_DAILY_CAP = 3;
/** A delivered broadcast waits this long for a planner to see it. */
export const BROADCAST_PENDING_MS = 86_400_000;
/** An open record older than this was left by a process that died mid-delivery. */
export const BROADCAST_INFLIGHT_MAX_MS = 10 * 60_000;
const MAX_TEXT = 500;

/** Neither delivered nor failed, and created more than `BROADCAST_INFLIGHT_MAX_MS` ago. */
export function isStaleOpen(
  b: Pick<Broadcast, 'createdAt' | 'deliveredAt' | 'deliveryError'>,
  nowMs: number
): boolean {
  if (b.deliveredAt || b.deliveryError !== undefined) return false;
  const at = Date.parse(b.createdAt);
  return Number.isFinite(at) && nowMs - at > BROADCAST_INFLIGHT_MAX_MS;
}

export type BroadcastSignal = 'up' | 'down';

export interface Broadcast {
  /** `b-` + 8 hex. */
  id: string;
  botId: string;
  kind: BroadcastKind;
  text: string;
  /** The insight neuron it comes from. */
  insightId: string;
  createdAt: string;
  deliveredAt?: string;
  deliveryError?: string;
  /**
   * Not attempted: the shared proactive throttle (`__watcher__` cooldown or
   * fleet cap) refused a question before anything was sent. A deferral is not
   * a delivery attempt, so it never counts toward the daily cap and never
   * blocks a retry of the same insight and kind (`deliveryError` says why).
   */
  deferred?: boolean;
  /** What the entry point answered (the proactive tool's text for a question). */
  delivery?: string;
  /** When a planner prompt listed it, and in which cycle. */
  shownAt?: string;
  shownInCycle?: string;
  /** The completed cycle whose row names it in `servesBroadcast`. */
  servedByCycle?: string;
  servedAt?: string;
  signal?: BroadcastSignal;
  signalAt?: string;
}

export interface BroadcastDelivery {
  wake?: (botId: string) => void;
  directive?: (botId: string, text: string) => void;
  goal?: (botId: string, text: string, reason: string) => void | Promise<void>;
  /**
   * Ask the operator; `ok: false` when the throttle refused or delivery failed.
   * `deferred: true` = the throttle refused before any attempt (not a failure).
   */
  question?: (
    botId: string,
    text: string
  ) => Promise<{ ok: boolean; detail: string; deferred?: boolean }>;
}

export interface BroadcastInput {
  botId: string;
  kind: string;
  text: string;
  insightId: string;
  /** Why (the insight's text): the goal event's reason. */
  reason?: string;
}

export type BroadcastResult =
  | { status: 'delivered' | 'failed' | 'deferred'; broadcast: Broadcast }
  | { status: 'capped' | 'duplicate' | 'invalid'; broadcast?: undefined };

export interface BroadcasterDeps {
  dir: string;
  delivery: BroadcastDelivery;
  now?: () => number;
  log?: WatcherLog;
  botName?: (botId: string) => string;
  maxPerBotPerDay?: number;
  /**
   * A tenant bot in multi-tenant mode: never a target (`invalid`), whatever
   * proposed it. The watcher reads the whole fleet; a tenant bot must not
   * receive admin or another tenant's material.
   */
  isTenantBot?: (botId: string) => boolean;
  logger?: { warn: (obj: object, msg: string) => void };
}

export function broadcastsFile(dir: string): string {
  return join(dir, 'broadcasts.jsonl');
}

const isKind = (k: unknown): k is BroadcastKind =>
  typeof k === 'string' && (BROADCAST_KINDS as readonly string[]).includes(k);

function validBroadcast(b: unknown): b is Broadcast {
  const r = b as Partial<Broadcast> | null;
  return (
    !!r &&
    typeof r.id === 'string' &&
    typeof r.botId === 'string' &&
    isKind(r.kind) &&
    typeof r.text === 'string' &&
    typeof r.insightId === 'string' &&
    typeof r.createdAt === 'string'
  );
}

/** Every broadcast in the file (last line per id wins). Never throws. */
export function readBroadcasts(dir: string): Broadcast[] {
  const path = broadcastsFile(dir);
  const byId = new Map<string, Broadcast>();
  try {
    if (!existsSync(path)) return [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const b = JSON.parse(line);
        if (validBroadcast(b)) byId.set(b.id, b);
      } catch {
        // a malformed line is skipped
      }
    }
  } catch {
    return [];
  }
  return [...byId.values()];
}

export class Broadcaster {
  private byId = new Map<string, Broadcast>();
  private readonly now: () => number;

  constructor(private readonly deps: BroadcasterDeps) {
    this.now = deps.now ?? Date.now;
    const stale: Broadcast[] = [];
    for (const b of readBroadcasts(deps.dir)) {
      this.byId.set(b.id, b);
      if (isStaleOpen(b, this.now())) stale.push(b);
    }
    // Left open by a process that exited mid-delivery: closed as failed (a
    // retry is allowed, the cap slot stays taken).
    for (const b of stale) {
      this.put({ ...b, deliveryError: 'interrupted: the process stopped during delivery' });
    }
  }

  get cap(): number {
    return this.deps.maxPerBotPerDay ?? BROADCAST_DAILY_CAP;
  }

  get(id: string): Broadcast | undefined {
    const b = this.byId.get(id);
    return b ? { ...b } : undefined;
  }

  /** Newest first. */
  list(opts: { botId?: string; limit?: number } = {}): Broadcast[] {
    const all = [...this.byId.values()]
      .filter((b) => !opts.botId || b.botId === opts.botId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return (opts.limit ? all.slice(0, opts.limit) : all).map((b) => ({ ...b }));
  }

  /**
   * Broadcasts to a bot created on the current UTC day: delivered, failed or
   * in flight. A deferral (`deferred`) is not counted: nothing was attempted,
   * and counting it let repeated re-proposals of a throttled question cap the
   * bot for the day with nothing delivered.
   */
  countToday(botId: string): number {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    let n = 0;
    for (const b of this.byId.values()) {
      if (b.deferred && !b.deliveredAt) continue;
      if (b.botId === botId && b.createdAt.slice(0, 10) === day) n++;
    }
    return n;
  }

  async send(input: BroadcastInput): Promise<BroadcastResult> {
    const text = String(input.text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TEXT);
    const botId = String(input.botId ?? '').trim();
    const insightId = String(input.insightId ?? '').trim();
    if (!botId || !insightId || !isKind(input.kind)) return { status: 'invalid' };
    if (this.deps.isTenantBot?.(botId)) return { status: 'invalid' };
    const kind = input.kind;
    if (!text && kind !== 'wake') return { status: 'invalid' };
    for (const b of this.byId.values()) {
      if (b.insightId !== insightId || b.kind !== kind) continue;
      // A failed or deferred delivery may be retried; a delivered or in-flight one may not.
      if (b.deliveryError !== undefined && !b.deliveredAt) continue;
      if (isStaleOpen(b, this.now())) continue;
      return { status: 'duplicate' };
    }
    if (this.countToday(botId) >= this.cap) {
      this.deps.log?.say(
        'broadcast',
        'broadcast:capped',
        narrateBroadcast({ kind, bot: this.name(botId), status: 'capped', cap: this.cap })
      );
      return { status: 'capped' };
    }

    // Written before delivery is awaited: a concurrent send sees it in the cap.
    const created: Broadcast = {
      id: this.newId(),
      botId,
      kind,
      text,
      insightId,
      createdAt: this.iso(),
    };
    this.put(created);

    let outcome: { ok: boolean; detail?: string; deferred?: boolean };
    try {
      outcome = await this.deliver(created, input.reason ?? text);
    } catch (err) {
      outcome = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    const done: Broadcast = outcome.ok
      ? {
          ...created,
          deliveredAt: this.iso(),
          ...(outcome.detail ? { delivery: outcome.detail.slice(0, 300) } : {}),
        }
      : {
          ...created,
          deliveryError: (outcome.detail ?? 'not delivered').slice(0, 300),
          ...(outcome.deferred ? { deferred: true } : {}),
        };
    // Recorded (not dropped) so the record that held the cap slot while in
    // flight is closed; `deferred` takes it out of the cap and the duplicates.
    this.put(done);
    const status = outcome.ok ? 'delivered' : outcome.deferred ? 'deferred' : 'failed';
    this.deps.log?.say(
      'broadcast',
      `broadcast:${status === 'delivered' ? 'sent' : status}`,
      narrateBroadcast({
        kind,
        bot: this.name(botId),
        status: status === 'delivered' ? 'sent' : status,
        text,
        ...(outcome.ok ? {} : { error: done.deliveryError }),
      }),
      { neuronIds: [insightId], source: `broadcast:${done.id}` }
    );
    return { status, broadcast: { ...done } };
  }

  /** Delivered, not yet shown to a planner, created within `BROADCAST_PENDING_MS`. Oldest first. */
  pendingFor(botId: string): Broadcast[] {
    const cutoff = this.now() - BROADCAST_PENDING_MS;
    return [...this.byId.values()]
      .filter(
        (b) =>
          b.botId === botId && !!b.deliveredAt && !b.shownAt && Date.parse(b.createdAt) >= cutoff
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((b) => ({ ...b }));
  }

  markShown(ids: string[], cycleId?: string): void {
    for (const id of ids) {
      const b = this.byId.get(id);
      if (!b || b.shownAt) continue;
      this.put({ ...b, shownAt: this.iso(), ...(cycleId ? { shownInCycle: cycleId } : {}) });
    }
  }

  /** First serving cycle wins; false when unknown or already served. */
  markServed(id: string, cycleId: string, at?: string): boolean {
    const b = this.byId.get(id);
    if (!b || b.servedByCycle) return false;
    this.put({ ...b, servedByCycle: cycleId, servedAt: at ?? this.iso() });
    return true;
  }

  signal(id: string, signal: BroadcastSignal): Broadcast | undefined {
    const b = this.byId.get(id);
    if (!b) return undefined;
    const next = { ...b, signal, signalAt: this.iso() };
    this.put(next);
    return { ...next };
  }

  private async deliver(
    b: Broadcast,
    reason: string
  ): Promise<{ ok: boolean; detail?: string; deferred?: boolean }> {
    const d = this.deps.delivery;
    switch (b.kind) {
      case 'wake':
        if (!d.wake) return { ok: false, detail: 'wake is not wired' };
        d.wake(b.botId);
        return { ok: true };
      case 'directive':
        if (!d.directive) return { ok: false, detail: 'directives are not wired' };
        d.directive(b.botId, b.text);
        return { ok: true };
      case 'goal':
        if (!d.goal) return { ok: false, detail: 'goals are not wired' };
        await d.goal(b.botId, b.text, reason);
        return { ok: true };
      case 'question':
        if (!d.question) return { ok: false, detail: 'questions are not wired' };
        return d.question(b.botId, b.text);
    }
  }

  private name(botId: string): string {
    return this.deps.botName?.(botId) ?? botId;
  }

  private put(b: Broadcast): void {
    this.byId.set(b.id, b);
    try {
      mkdirSync(this.deps.dir, { recursive: true });
      appendFileSync(broadcastsFile(this.deps.dir), `${JSON.stringify(b)}\n`, 'utf-8');
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher broadcast: could not persist a broadcast');
    }
  }

  private newId(): string {
    let id: string;
    do id = `b-${randomBytes(4).toString('hex')}`;
    while (this.byId.has(id));
    return id;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

/**
 * A watcher goal broadcast: a To do goal (`source: watcher`, medium priority,
 * created today) appended to the bot's GOALS.md through the single writer,
 * with actor `watcher` and the insight as the goal event's reason.
 */
export function writeWatcherGoal(
  goalsPath: string,
  text: string,
  reason: string,
  opts: { now?: () => Date; backup?: (path: string) => void } = {}
): void {
  const current = existsSync(goalsPath) ? readFileSync(goalsPath, 'utf-8') : null;
  const created = localDateStr(opts.now ? opts.now() : new Date());
  writeGoalsFile(
    goalsPath,
    appendGoal(current, {
      text,
      status: 'pending',
      priority: 'medium',
      source: 'watcher',
      created,
    }),
    {
      actor: 'watcher',
      reason,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.backup ? { backup: opts.backup } : {}),
    }
  );
}
