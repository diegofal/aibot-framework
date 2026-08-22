import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';
import {
  DEFAULT_KARMA_REWARDS,
  KARMA_KIND_SOURCE,
  type KarmaBreakdown,
  type KarmaEvent,
  type KarmaOutcomeKind,
  type KarmaRewards,
  type KarmaScore,
  type KarmaTrend,
} from './types';

export interface KarmaConfig {
  enabled: boolean;
  baseDir: string;
  initialScore: number;
  decayDays: number;
  dedupCooldownMinutes?: number;
  /** Per-outcome deltas; missing kinds fall back to DEFAULT_KARMA_REWARDS */
  rewards?: Partial<KarmaRewards>;
  /** At most one humanReply credit per bot within this window (0 disables the cooldown) */
  humanReplyCooldownHours?: number;
}

/** Trailing window the dashboard breakdown is computed over */
const BREAKDOWN_WINDOW_DAYS = 30;
const DEFAULT_HUMAN_REPLY_COOLDOWN_HOURS = 6;

export class KarmaService {
  private baseDir: string;
  private initialScore: number;
  private decayDays: number;
  private dedupCooldownMs: number;
  private rewards: KarmaRewards;
  /** Per-kind cooldown (ms) applied before any event is written; kinds absent here have none */
  private outcomeCooldownMs: Partial<Record<KarmaOutcomeKind, number>>;
  /** botId → dedupKey → lastTimestamp (ms) */
  private dedupMap = new Map<string, Map<string, number>>();

  constructor(
    private config: KarmaConfig,
    private logger: Logger
  ) {
    this.baseDir = config.baseDir;
    this.initialScore = config.initialScore;
    this.decayDays = config.decayDays;
    this.dedupCooldownMs = (config.dedupCooldownMinutes ?? 60) * 60_000;
    this.rewards = { ...DEFAULT_KARMA_REWARDS, ...stripUndefined(config.rewards) };
    this.outcomeCooldownMs = {
      humanReply:
        (config.humanReplyCooldownHours ?? DEFAULT_HUMAN_REPLY_COOLDOWN_HOURS) * 3_600_000,
    };
  }

  /** Effective rewards table (defaults merged with config overrides) */
  getRewards(): KarmaRewards {
    return { ...this.rewards };
  }

  /**
   * Record an outcome by kind. The delta comes from the rewards table; a kind
   * worth 0 is a no-op (returns null) so a hook can stay wired while its
   * reward is switched off. Some kinds carry a per-bot cooldown (humanReply)
   * so a chatty operator does not mint karma on every message.
   */
  recordOutcome(
    botId: string,
    kind: KarmaOutcomeKind,
    reason: string,
    metadata?: Record<string, unknown>
  ): KarmaEvent | null {
    const delta = this.rewards[kind];
    const source = KARMA_KIND_SOURCE[kind];
    if (typeof delta !== 'number' || !source) {
      this.logger.warn({ botId, kind }, 'Karma outcome ignored: unknown kind');
      return null;
    }
    if (delta === 0) {
      this.logger.debug({ botId, kind, reason }, 'Karma outcome skipped (reward is 0)');
      return null;
    }

    const cooldownMs = this.outcomeCooldownMs[kind];
    if (cooldownMs && cooldownMs > 0) {
      if (!this.claimDedupSlot(botId, `outcome:${kind}`, cooldownMs)) {
        this.logger.debug({ botId, kind }, 'Karma outcome deduped (per-kind cooldown)');
        return null;
      }
    }

    return this.addEvent(botId, delta, reason, source, metadata, kind);
  }

  /**
   * Returns true and records `now` when the key is outside its cooldown;
   * false when a previous claim is still fresh.
   */
  private claimDedupSlot(botId: string, key: string, cooldownMs: number): boolean {
    const now = Date.now();
    let botDedup = this.dedupMap.get(botId);
    if (!botDedup) {
      botDedup = new Map();
      this.dedupMap.set(botId, botDedup);
    }
    const lastSeen = botDedup.get(key);
    if (lastSeen !== undefined && now - lastSeen < cooldownMs) return false;
    botDedup.set(key, now);
    return true;
  }

  private getBotDir(botId: string): string {
    const dir = join(this.baseDir, botId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private getEventsPath(botId: string): string {
    return join(this.getBotDir(botId), 'events.jsonl');
  }

  /**
   * Extract a dedup key from the event source + reason.
   * Used to prevent the same error from hammering karma repeatedly.
   */
  static extractDedupKey(source: KarmaEvent['source'], reason: string): string {
    if (source === 'production') {
      // "Empty template detected in "path/file.md"" → production:path/file.md
      const match = reason.match(/"([^"]+)"/);
      if (match) {
        // Normalize: strip leading ./ and collapse duplicate slashes
        const normalized = match[1].replace(/^\.\//, '').replace(/\/\//g, '/');
        return `production:${normalized}`;
      }
    }
    if (source === 'tool') {
      // "Tool error: file_read — ..." → tool:file_read:<prefix>
      const toolMatch = reason.match(/^Tool error:\s*(\S+)/);
      if (toolMatch) return `tool:${toolMatch[1]}:${reason.slice(0, 50)}`;
    }
    if (source === 'agent-loop') {
      return `agent-loop:${reason.slice(0, 60)}`;
    }
    return `${source}:${reason.slice(0, 60)}`;
  }

  addEvent(
    botId: string,
    delta: number,
    reason: string,
    source: KarmaEvent['source'],
    metadata?: Record<string, unknown>,
    kind?: KarmaOutcomeKind
  ): KarmaEvent | null {
    // Only dedup negative events from automated sources
    if (delta < 0 && source !== 'manual' && source !== 'feedback') {
      const dedupKey = KarmaService.extractDedupKey(source, reason);
      if (!this.claimDedupSlot(botId, dedupKey, this.dedupCooldownMs)) {
        this.logger.debug({ botId, delta, dedupKey }, 'Karma event deduped (cooldown)');
        return null;
      }
    }

    const event: KarmaEvent = {
      id: randomUUID(),
      botId,
      timestamp: new Date().toISOString(),
      delta,
      reason,
      source,
      ...(kind ? { kind } : {}),
      metadata,
    };

    const eventsPath = this.getEventsPath(botId);
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf-8');
    this.logger.debug({ botId, delta, reason, source }, 'Karma event recorded');
    return event;
  }

  getAllEvents(botId: string): KarmaEvent[] {
    const eventsPath = this.getEventsPath(botId);
    if (!existsSync(eventsPath)) return [];

    const content = readFileSync(eventsPath, 'utf-8').trim();
    if (!content) return [];

    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as KarmaEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is KarmaEvent => e !== null);
  }

  getRecentEvents(botId: string, limit = 25): KarmaEvent[] {
    const events = this.getAllEvents(botId);
    return events.slice(-limit).reverse();
  }

  /**
   * Compute current score with time decay.
   * Events older than decayDays weight 50%.
   * Events older than 3*decayDays weight 25%.
   */
  getScore(botId: string): number {
    const events = this.getAllEvents(botId);
    if (events.length === 0) return this.initialScore;

    const now = Date.now();
    const decayMs = this.decayDays * 86_400_000;
    const deepDecayMs = decayMs * 3;

    let score = this.initialScore;
    for (const event of events) {
      const ageMs = now - new Date(event.timestamp).getTime();
      let weight = 1;
      if (ageMs > deepDecayMs) {
        weight = 0.25;
      } else if (ageMs > decayMs) {
        weight = 0.5;
      }
      score += event.delta * weight;
    }

    // Clamp to 0-100
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  getTrend(botId: string): KarmaTrend {
    const events = this.getAllEvents(botId);
    const sevenDaysAgo = Date.now() - 7 * 86_400_000;
    const recentEvents = events.filter((e) => new Date(e.timestamp).getTime() >= sevenDaysAgo);

    if (recentEvents.length === 0) return 'stable';

    const totalDelta = recentEvents.reduce((sum, e) => sum + e.delta, 0);
    if (totalDelta > 2) return 'rising';
    if (totalDelta < -2) return 'falling';
    return 'stable';
  }

  /**
   * Raw delta sums over the trailing window, grouped by source and by outcome
   * kind — shows what the score is made of (activity vs. operator outcomes).
   */
  getBreakdown(botId: string, windowDays = BREAKDOWN_WINDOW_DAYS): KarmaBreakdown {
    const cutoff = Date.now() - windowDays * 86_400_000;
    const bySource: KarmaBreakdown['bySource'] = {};
    const byKind: KarmaBreakdown['byKind'] = {};
    for (const event of this.getAllEvents(botId)) {
      if (new Date(event.timestamp).getTime() < cutoff) continue;
      bySource[event.source] = (bySource[event.source] ?? 0) + event.delta;
      if (event.kind) byKind[event.kind] = (byKind[event.kind] ?? 0) + event.delta;
    }
    return { windowDays, bySource, byKind };
  }

  getKarmaScore(botId: string): KarmaScore {
    return {
      botId,
      current: this.getScore(botId),
      trend: this.getTrend(botId),
      recentEvents: this.getRecentEvents(botId),
      breakdown: this.getBreakdown(botId),
    };
  }

  /**
   * Delete all events for a bot, resetting its score to initial.
   */
  clearEvents(botId: string): void {
    const eventsPath = this.getEventsPath(botId);
    writeFileSync(eventsPath, '', 'utf-8');
    this.logger.info({ botId }, 'Karma events cleared');
  }

  /**
   * Render a karma block suitable for injection into LLM prompts.
   */
  renderForPrompt(botId: string): string {
    const score = this.getScore(botId);
    const trend = this.getTrend(botId);
    const recentEvents = this.getRecentEvents(botId, 5);

    const trendArrow = trend === 'rising' ? '↑' : trend === 'falling' ? '↓' : '→';

    let block = `## Your Karma: ${score}/100 (${trend} ${trendArrow})\n`;

    if (recentEvents.length > 0) {
      block += '\nRecent karma events:\n';
      for (const event of recentEvents) {
        const sign = event.delta >= 0 ? '+' : '';
        block += `- ${sign}${event.delta}: ${event.reason}\n`;
      }
    }

    block += `\nYour karma reflects the QUALITY of your work as judged by your operator and the system.
It is earned from outcomes — productions the operator approves, questions a human answers,
humans replying to you — and lost on tool errors and rejected work. Activity alone earns nothing.
Higher karma = more trust and autonomy. Lower karma = you need to change your approach.
Focus on actions that produce real, original, data-backed output.`;

    return block;
  }

  /**
   * Render a short karma line for conversation system prompts.
   */
  renderShort(botId: string): string {
    const score = this.getScore(botId);
    const trend = this.getTrend(botId);
    return `## Karma: ${score}/100 (${trend})`;
  }

  /**
   * Get karma scores for all known bots (bots that have event files).
   */
  getAllScores(botIds: string[]): KarmaScore[] {
    return botIds.map((botId) => this.getKarmaScore(botId));
  }

  /**
   * Get paginated history for a bot.
   */
  getHistory(
    botId: string,
    opts?: { limit?: number; offset?: number }
  ): { events: KarmaEvent[]; total: number } {
    const all = this.getAllEvents(botId).reverse(); // newest first
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return {
      events: all.slice(offset, offset + limit),
      total: all.length,
    };
  }
}

function stripUndefined<T extends object>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
