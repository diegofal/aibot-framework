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
}

export class KarmaService {
  private baseDir: string;
  private initialScore: number;
  private decayDays: number;

  constructor(
    private config: KarmaConfig,
    private logger: Logger,
  ) {
    this.baseDir = config.baseDir;
    this.initialScore = config.initialScore;
    this.decayDays = config.decayDays;
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

  addEvent(
    botId: string,
    delta: number,
    reason: string,
    source: KarmaEvent['source'],
    metadata?: Record<string, unknown>,
  ): KarmaEvent {
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
