/**
 * Knowledge Mesh — Shared knowledge graph where bots publish/query
 * discoveries, strategies, and insights from peers.
 *
 * Framework-wide JSONL store (not per-bot). Supports confidence scoring,
 * validation/contradiction by peers, and temporal decay.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger';

// ── Types ──

export interface KnowledgeEntry {
  id: string;
  sourceBotId: string;
  topic: string;
  insight: string;
  confidence: number; // 0.0-1.0
  evidence?: string;
  timestamp: number;
  validatedBy: string[];
  contradictedBy: string[];
}

export interface MeshQueryResult {
  entry: KnowledgeEntry;
  relevanceScore: number;
}

// ── Constants ──

const HALF_LIFE_DAYS = 14;
const MIN_CONFIDENCE = 0.1;
const MAX_ENTRIES = 500;
const CONFIDENCE_BOOST_PER_VALIDATION = 0.1;
const CONFIDENCE_PENALTY_PER_CONTRADICTION = 0.15;

// ── KnowledgeMesh ──

export class KnowledgeMesh {
  constructor(
    private filePath: string,
    private logger: Logger
  ) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // ── Write operations ──

  /**
   * Publish a new knowledge entry. Deduplicates by topic+insight similarity.
   */
  publish(
    sourceBotId: string,
    topic: string,
    insight: string,
    confidence = 0.5,
    evidence?: string
  ): KnowledgeEntry | null {
    const entries = this.loadAll();

    // Dedup: check if similar entry already exists (same bot + topic + overlapping insight)
    const topicLower = topic.toLowerCase();
    const insightLower = insight.toLowerCase();
    const duplicate = entries.find(
      (e) =>
        e.sourceBotId === sourceBotId &&
        e.topic.toLowerCase() === topicLower &&
        (e.insight.toLowerCase().startsWith(insightLower.slice(0, 30)) ||
          insightLower.startsWith(e.insight.toLowerCase().slice(0, 30)))
    );
    if (duplicate) {
      this.logger.debug({ sourceBotId, topic }, 'KnowledgeMesh: deduped entry');
      return null;
    }

    const entry: KnowledgeEntry = {
      id: randomUUID(),
      sourceBotId,
      topic: topic.slice(0, 100),
      insight: insight.slice(0, 500),
      confidence: clamp(confidence, 0, 1),
      evidence: evidence?.slice(0, 200),
      timestamp: Date.now(),
      validatedBy: [],
      contradictedBy: [],
    };

    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
    this.logger.debug({ sourceBotId, topic, id: entry.id }, 'KnowledgeMesh: published');
    return entry;
  }

  /**
   * Validate an entry (peer bot confirms the insight).
   */
  validate(entryId: string, validatingBotId: string): boolean {
    return this.updateEntry(entryId, (e) => {
      if (!e.validatedBy.includes(validatingBotId)) {
        e.validatedBy.push(validatingBotId);
        e.confidence = clamp(e.confidence + CONFIDENCE_BOOST_PER_VALIDATION, 0, 1);
      }
    });
  }

  /**
   * Contradict an entry (peer bot disputes the insight).
   */
  contradict(entryId: string, contradictingBotId: string): boolean {
    return this.updateEntry(entryId, (e) => {
      if (!e.contradictedBy.includes(contradictingBotId)) {
        e.contradictedBy.push(contradictingBotId);
        e.confidence = clamp(e.confidence - CONFIDENCE_PENALTY_PER_CONTRADICTION, 0, 1);
      }
    });
  }

  /**
   * Sweep: apply temporal decay and prune low-confidence entries.
   * Returns number of entries pruned.
   */
  sweep(): number {
    const entries = this.loadAll();
    const now = Date.now();
    let pruned = 0;

    const surviving = entries.filter((e) => {
      const weight = computeTemporalWeight(e.timestamp, now, HALF_LIFE_DAYS);
      const effectiveConfidence = e.confidence * weight;
      if (effectiveConfidence < MIN_CONFIDENCE) {
        pruned++;
        return false;
      }
      return true;
    });

    // Also enforce max entries (keep most recent)
    if (surviving.length > MAX_ENTRIES) {
      pruned += surviving.length - MAX_ENTRIES;
      surviving.splice(0, surviving.length - MAX_ENTRIES);
    }

    if (pruned > 0) {
      this.writeAll(surviving);
      this.logger.debug({ pruned, remaining: surviving.length }, 'KnowledgeMesh: swept');
    }

    return pruned;
  }

  // ── Read operations ──

  /**
   * Query the mesh by topic keyword. Excludes entries from the querying bot.
   */
  query(
    topic: string,
    opts?: { excludeBotId?: string; minConfidence?: number; maxResults?: number }
  ): MeshQueryResult[] {
    const entries = this.loadAll();
    const topicWords = topic.toLowerCase().split(/\s+/);
    const minConf = opts?.minConfidence ?? 0.2;
    const maxResults = opts?.maxResults ?? 10;

    const results: MeshQueryResult[] = [];

    for (const entry of entries) {
      if (opts?.excludeBotId && entry.sourceBotId === opts.excludeBotId) continue;
      if (entry.confidence < minConf) continue;

      // Simple keyword relevance scoring
      const entryText = `${entry.topic} ${entry.insight}`.toLowerCase();
      let matchCount = 0;
      for (const word of topicWords) {
        if (word.length >= 3 && entryText.includes(word)) matchCount++;
      }

      if (matchCount === 0) continue;

      const relevanceScore = (matchCount / topicWords.length) * entry.confidence;
      results.push({ entry, relevanceScore });
    }

    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return results.slice(0, maxResults);
  }

  /**
   * Get relevant insights for a bot based on its motivations/focus.
   * For injection into reflection cross-pollination phase.
   */
  getRelevantInsights(botId: string, motivationsText: string, maxChars = 300): string | null {
    // Extract key phrases from motivations
    const words = motivationsText
      .replace(/[#*\-\[\]()]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .slice(0, 10);

    if (words.length === 0) return null;

    const query = words.join(' ');
    const results = this.query(query, { excludeBotId: botId, minConfidence: 0.3, maxResults: 5 });

    if (results.length === 0) return null;

    const lines: string[] = ['## Peer Insights'];
    let chars = lines[0].length;

    for (const r of results) {
      const line = `- [${r.entry.sourceBotId}] ${r.entry.insight} (confidence: ${r.entry.confidence.toFixed(1)})`;
      if (chars + line.length > maxChars) break;
      lines.push(line);
      chars += line.length;
    }

    return lines.length > 1 ? lines.join('\n') : null;
  }

  /**
   * Get entry count for monitoring.
   */
  getEntryCount(): number {
    return this.loadAll().length;
  }

  /**
   * Get all entries (for dashboard/debugging).
   */
  getAll(): KnowledgeEntry[] {
    return this.loadAll();
  }

  // ── Internal ──

  private loadAll(): KnowledgeEntry[] {
    if (!existsSync(this.filePath)) return [];

    const content = readFileSync(this.filePath, 'utf-8').trim();
    if (!content) return [];

    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as KnowledgeEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is KnowledgeEntry => e !== null);
  }

  private writeAll(entries: KnowledgeEntry[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf-8');
  }

  private updateEntry(entryId: string, mutate: (e: KnowledgeEntry) => void): boolean {
    const entries = this.loadAll();
    let found = false;

    for (const e of entries) {
      if (e.id === entryId) {
        mutate(e);
        found = true;
        break;
      }
    }

    if (found) this.writeAll(entries);
    return found;
  }
}

// ── Helpers ──

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Exponential temporal decay weight.
 * Returns 1.0 for now, ~0.5 at halfLifeDays, approaches 0 over time.
 */
export function computeTemporalWeight(
  timestamp: number,
  now: number,
  halfLifeDays: number
): number {
  const ageDays = (now - timestamp) / (24 * 3_600_000);
  return 0.5 ** (ageDays / halfLifeDays);
}
