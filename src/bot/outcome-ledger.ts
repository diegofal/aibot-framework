/**
 * Outcome Ledger — Tracks production-class actions and their consumption outcomes.
 *
 * Replaces the blunt engagement gate binary with granular per-production data.
 * Follows the JSONL storage pattern from KarmaService.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger';
import type { ActionType } from './agent-loop-utils';

// ── Types ──

export type OutcomeStatus = 'produced' | 'consumed' | 'validated' | 'stale' | 'rejected';

export interface OutcomeEntry {
  id: string;
  botId: string;
  timestamp: number;
  type: ActionType;
  description: string;
  toolCalls: string[];
  status: OutcomeStatus;
  consumedAt?: number;
  consumedBy?: string;
  validatedAt?: number;
  score?: number;
}

export interface OutcomeStats {
  total: number;
  produced: number;
  consumed: number;
  validated: number;
  stale: number;
  rejected: number;
  consumptionRate: number;
  avgScore: number;
}

// ── Ledger ──

export class OutcomeLedger {
  /** botId → dedupKey → timestamp (prevent double-recording in same cycle) */
  private dedupMap = new Map<string, Map<string, number>>();
  private static readonly DEDUP_WINDOW_MS = 5 * 60_000; // 5 minutes

  constructor(
    private baseDir: string,
    private logger: Logger
  ) {}

  private getBotDir(botId: string): string {
    const dir = join(this.baseDir, botId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private getFilePath(botId: string): string {
    return join(this.getBotDir(botId), 'outcomes.jsonl');
  }

  // ── Write operations ──

  /**
   * Record a new production-class action.
   * Returns the entry ID, or null if deduped.
   */
  record(
    botId: string,
    description: string,
    toolCalls: string[],
    actionType: ActionType
  ): string | null {
    // Dedup: prevent same description within 5 minutes
    const dedupKey = description.toLowerCase().slice(0, 80);
    const now = Date.now();
    let botDedup = this.dedupMap.get(botId);
    if (!botDedup) {
      botDedup = new Map();
      this.dedupMap.set(botId, botDedup);
    }
    const lastSeen = botDedup.get(dedupKey);
    if (lastSeen !== undefined && now - lastSeen < OutcomeLedger.DEDUP_WINDOW_MS) {
      return null;
    }
    botDedup.set(dedupKey, now);

    const entry: OutcomeEntry = {
      id: randomUUID(),
      botId,
      timestamp: now,
      type: actionType,
      description: description.slice(0, 200),
      toolCalls,
      status: 'produced',
    };

    const filePath = this.getFilePath(botId);
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
    this.logger.debug({ botId, id: entry.id, type: actionType }, 'Outcome recorded');
    return entry.id;
  }

  /**
   * Mark a production as consumed (someone responded/interacted with it).
   */
  markConsumed(botId: string, entryId: string, by?: string): boolean {
    return this.updateEntry(botId, entryId, {
      status: 'consumed',
      consumedAt: Date.now(),
      consumedBy: by,
    });
  }

  /**
   * Mark a production as validated (operator explicitly confirmed value).
   */
  markValidated(botId: string, entryId: string, score?: number): boolean {
    return this.updateEntry(botId, entryId, {
      status: 'validated',
      validatedAt: Date.now(),
      score,
    });
  }

  /**
   * Mark a production as rejected.
   */
  markRejected(botId: string, entryId: string): boolean {
    return this.updateEntry(botId, entryId, { status: 'rejected' });
  }

  /**
   * Sweep entries older than TTL with no consumption signal → mark stale.
   * Returns count of entries marked stale.
   */
  sweepStale(botId: string, ttlMs = 72 * 3_600_000): number {
    const entries = this.getAllEntries(botId);
    const now = Date.now();
    let staleCount = 0;

    const updated = entries.map((e) => {
      if (e.status === 'produced' && now - e.timestamp > ttlMs) {
        staleCount++;
        return { ...e, status: 'stale' as OutcomeStatus };
      }
      return e;
    });

    if (staleCount > 0) {
      this.writeAll(botId, updated);
      this.logger.debug({ botId, staleCount }, 'Outcome ledger: swept stale entries');
    }
    return staleCount;
  }

  // ── Read operations ──

  /**
   * Get all entries for a bot.
   */
  getAllEntries(botId: string): OutcomeEntry[] {
    const filePath = this.getFilePath(botId);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];

    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as OutcomeEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is OutcomeEntry => e !== null);
  }

  /**
   * Get recent entries for prompt injection.
   */
  getRecent(botId: string, count = 20): OutcomeEntry[] {
    const all = this.getAllEntries(botId);
    return all.slice(-count);
  }

  /**
   * Compute outcome stats within a time window.
   */
  getStats(botId: string, windowMs = 7 * 24 * 3_600_000): OutcomeStats {
    const cutoff = Date.now() - windowMs;
    const entries = this.getAllEntries(botId).filter((e) => e.timestamp >= cutoff);

    const stats: OutcomeStats = {
      total: entries.length,
      produced: 0,
      consumed: 0,
      validated: 0,
      stale: 0,
      rejected: 0,
      consumptionRate: 0,
      avgScore: 0,
    };

    let scoreSum = 0;
    let scoreCount = 0;

    for (const e of entries) {
      stats[e.status]++;
      if (e.score !== undefined) {
        scoreSum += e.score;
        scoreCount++;
      }
    }

    stats.consumptionRate = stats.total > 0 ? (stats.consumed + stats.validated) / stats.total : 0;
    stats.avgScore = scoreCount > 0 ? scoreSum / scoreCount : 0;

    return stats;
  }

  /**
   * Find the most recent 'produced' entry matching a description pattern.
   * Useful for marking consumption when operator replies about a specific production.
   */
  findRecentByDescription(
    botId: string,
    pattern: string,
    maxAgeMs = 7 * 24 * 3_600_000
  ): OutcomeEntry | null {
    const cutoff = Date.now() - maxAgeMs;
    const entries = this.getAllEntries(botId).filter(
      (e) => e.timestamp >= cutoff && e.status === 'produced'
    );
    const lower = pattern.toLowerCase();
    // Reverse to find most recent match first
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].description.toLowerCase().includes(lower)) {
        return entries[i];
      }
    }
    return null;
  }

  // ── Prompt rendering ──

  /**
   * Render stats for strategist prompt injection.
   */
  renderStatsForPrompt(botId: string): string | null {
    const stats = this.getStats(botId);
    if (stats.total === 0) return null;

    const pcts = (n: number) =>
      stats.total > 0 ? `${Math.round((n / stats.total) * 100)}%` : '0%';
    return `Production outcomes (7d): ${stats.total} total — ${pcts(stats.consumed)} consumed, ${pcts(stats.validated)} validated, ${pcts(stats.stale)} stale, ${pcts(stats.produced)} pending, ${pcts(stats.rejected)} rejected. Consumption rate: ${Math.round(stats.consumptionRate * 100)}%`;
  }

  /**
   * Render recent entries for planner prompt injection.
   */
  renderRecentForPrompt(botId: string, count = 5): string | null {
    const recent = this.getRecent(botId, count);
    if (recent.length === 0) return null;

    const lines = recent.map((e) => {
      const ago = Math.round((Date.now() - e.timestamp) / 3_600_000);
      const statusIcon =
        e.status === 'consumed'
          ? '✓'
          : e.status === 'validated'
            ? '★'
            : e.status === 'stale'
              ? '⏳'
              : e.status === 'rejected'
                ? '✗'
                : '○';
      return `${statusIcon} ${ago}h ago: ${e.description} [${e.status}]`;
    });
    return `Recent productions:\n${lines.join('\n')}`;
  }

  // ── Internal ──

  private updateEntry(botId: string, entryId: string, updates: Partial<OutcomeEntry>): boolean {
    const entries = this.getAllEntries(botId);
    let found = false;

    const updated = entries.map((e) => {
      if (e.id === entryId) {
        found = true;
        return { ...e, ...updates };
      }
      return e;
    });

    if (found) {
      this.writeAll(botId, updated);
    }
    return found;
  }

  private writeAll(botId: string, entries: OutcomeEntry[]): void {
    const filePath = this.getFilePath(botId);
    const dir = this.getBotDir(botId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf-8');
  }
}
