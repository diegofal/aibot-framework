import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger';
import type { KarmaEvent, KarmaScore, KarmaTrend } from './types';

export interface KarmaConfig {
  enabled: boolean;
  baseDir: string;
  initialScore: number;
  decayDays: number;
  dedupCooldownMinutes?: number;
}

export class KarmaService {
  private baseDir: string;
  private initialScore: number;
  private decayDays: number;
  private dedupCooldownMs: number;
  /** botId → dedupKey → lastTimestamp (ms) */
  private dedupMap = new Map<string, Map<string, number>>();

  constructor(
    private config: KarmaConfig,
    private logger: Logger,
  ) {
    this.baseDir = config.baseDir;
    this.initialScore = config.initialScore;
    this.decayDays = config.decayDays;
    this.dedupCooldownMs = (config.dedupCooldownMinutes ?? 60) * 60_000;
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
  ): KarmaEvent | null {
    // Only dedup negative events from automated sources
    if (delta < 0 && source !== 'manual' && source !== 'feedback') {
      const dedupKey = KarmaService.extractDedupKey(source, reason);
      const now = Date.now();
      let botDedup = this.dedupMap.get(botId);
      if (!botDedup) {
        botDedup = new Map();
        this.dedupMap.set(botId, botDedup);
      }
      const lastSeen = botDedup.get(dedupKey);
      if (lastSeen !== undefined && (now - lastSeen) < this.dedupCooldownMs) {
        this.logger.debug({ botId, delta, dedupKey }, 'Karma event deduped (cooldown)');
        return null;
      }
      botDedup.set(dedupKey, now);
    }

    const event: KarmaEvent = {
      id: randomUUID(),
      botId,
      timestamp: new Date().toISOString(),
      delta,
      reason,
      source,
      metadata,
    };

    const eventsPath = this.getEventsPath(botId);
    appendFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf-8');
    this.logger.debug({ botId, delta, reason, source }, 'Karma event recorded');
    return event;
  }

  getAllEvents(botId: string): KarmaEvent[] {
    const eventsPath = this.getEventsPath(botId);
    if (!existsSync(eventsPath)) return [];

    const content = readFileSync(eventsPath, 'utf-8').trim();
    if (!content) return [];

    return content.split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as KarmaEvent;
      } catch {
        return null;
      }
    }).filter((e): e is KarmaEvent => e !== null);
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
    const recentEvents = events.filter(
      (e) => new Date(e.timestamp).getTime() >= sevenDaysAgo,
    );

    if (recentEvents.length === 0) return 'stable';

    const totalDelta = recentEvents.reduce((sum, e) => sum + e.delta, 0);
    if (totalDelta > 2) return 'rising';
    if (totalDelta < -2) return 'falling';
    return 'stable';
  }

  getKarmaScore(botId: string): KarmaScore {
    return {
      botId,
      current: this.getScore(botId),
      trend: this.getTrend(botId),
      recentEvents: this.getRecentEvents(botId),
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
    opts?: { limit?: number; offset?: number },
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
