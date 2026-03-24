/**
 * Goal Genealogy — Causal chain tracking for goals.
 *
 * Enriches goals with origin context, tracks parent-child relationships,
 * computes outcome scores, and provides origin-based performance stats
 * for the strategist to reason about.
 */

import type { GoalEntry } from '../tools/goals';
import type { OutcomeLedger } from './outcome-ledger';

// ── Types ──

export type GoalOrigin =
  | 'operator'
  | 'strategist'
  | 'reflection'
  | 'environment'
  | 'mesh'
  | 'crystallizer';

export interface GoalGenealogyFields {
  origin?: GoalOrigin;
  originContext?: string;
  parentGoalId?: string;
  childGoalIds?: string[];
  outcomeScore?: number;
}

export type EnrichedGoalEntry = GoalEntry & GoalGenealogyFields;

export interface OriginStats {
  origin: GoalOrigin;
  total: number;
  completed: number;
  avgScore: number;
  successRate: number;
}

// ── Score weights ──

const SCORE_CONSUMED = 0.4;
const SCORE_VALIDATED = 0.3;
const SCORE_KARMA_POSITIVE = 0.2;
const SCORE_ON_TIME = 0.1;

// ── GoalGenealogy ──

export class GoalGenealogy {
  /**
   * Enrich a goal source string with origin and context.
   * Transforms "strategist:2026-03-24" into structured origin data.
   */
  enrichSource(
    sourceStr: string | undefined,
    triggerContext?: string
  ): { origin: GoalOrigin; originContext?: string } {
    if (!sourceStr) return { origin: 'operator' };

    const origin = parseOriginFromSource(sourceStr);
    const context = triggerContext || extractContextFromSource(sourceStr);

    return {
      origin,
      originContext: context || undefined,
    };
  }

  /**
   * Create a parent-child link between two goals.
   */
  linkChild(
    parent: EnrichedGoalEntry,
    child: EnrichedGoalEntry,
    parentId: string,
    childId: string
  ): void {
    child.parentGoalId = parentId;
    if (!parent.childGoalIds) parent.childGoalIds = [];
    if (!parent.childGoalIds.includes(childId)) {
      parent.childGoalIds.push(childId);
    }
  }

  /**
   * Compute an outcome score for a completed goal.
   * Score is 0.0-1.0 based on production consumption and karma.
   */
  scoreOutcome(
    goal: EnrichedGoalEntry,
    ledger?: OutcomeLedger | null,
    botId?: string,
    karmaTrendPositive?: boolean
  ): number {
    let score = 0;

    // Check if any production was consumed/validated
    if (ledger && botId) {
      const stats = ledger.getStats(botId, 3 * 24 * 3_600_000); // last 3 days
      if (stats.consumed > 0) score += SCORE_CONSUMED;
      if (stats.validated > 0) score += SCORE_VALIDATED;
    }

    // Karma trend
    if (karmaTrendPositive) score += SCORE_KARMA_POSITIVE;

    // Completed at all = on time (simplified)
    if (goal.status === 'completed' || goal.completed) score += SCORE_ON_TIME;

    return Math.min(1.0, score);
  }

  /**
   * Propagate a child's score up to its parent.
   * Parent score = average of own score + children scores.
   */
  propagateScore(goals: EnrichedGoalEntry[], goalMap: Map<string, EnrichedGoalEntry>): void {
    for (const goal of goals) {
      if (!goal.childGoalIds || goal.childGoalIds.length === 0) continue;

      const childScores = goal.childGoalIds
        .map((id) => goalMap.get(id)?.outcomeScore)
        .filter((s): s is number => s !== undefined);

      if (childScores.length > 0) {
        const avgChild = childScores.reduce((a, b) => a + b, 0) / childScores.length;
        const ownScore = goal.outcomeScore ?? 0;
        goal.outcomeScore = (ownScore + avgChild) / 2;
      }
    }
  }

  /**
   * Compute per-origin success statistics from completed goals.
   */
  getOriginStats(goals: EnrichedGoalEntry[]): OriginStats[] {
    const byOrigin = new Map<GoalOrigin, { total: number; completed: number; scores: number[] }>();

    for (const goal of goals) {
      const origin = goal.origin ?? 'operator';
      let stats = byOrigin.get(origin);
      if (!stats) {
        stats = { total: 0, completed: 0, scores: [] };
        byOrigin.set(origin, stats);
      }
      stats.total++;
      if (goal.status === 'completed' || goal.completed) {
        stats.completed++;
        if (goal.outcomeScore !== undefined) {
          stats.scores.push(goal.outcomeScore);
        }
      }
    }

    const results: OriginStats[] = [];
    for (const [origin, stats] of byOrigin) {
      const avgScore =
        stats.scores.length > 0 ? stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length : 0;
      results.push({
        origin,
        total: stats.total,
        completed: stats.completed,
        avgScore,
        successRate: stats.total > 0 ? stats.completed / stats.total : 0,
      });
    }

    // Sort by success rate (highest first)
    results.sort((a, b) => b.successRate - a.successRate);
    return results;
  }

  /**
   * Render origin stats for strategist prompt injection.
   */
  renderForPrompt(goals: EnrichedGoalEntry[]): string | null {
    const stats = this.getOriginStats(goals);
    if (stats.length === 0) return null;

    const lines = ['## Goal Performance by Origin'];
    for (const s of stats) {
      const pct = Math.round(s.successRate * 100);
      const scoreStr = s.avgScore > 0 ? `, avg score: ${s.avgScore.toFixed(1)}` : '';
      lines.push(`- ${s.origin}: ${pct}% success (${s.completed}/${s.total}${scoreStr})`);
    }
    lines.push('');
    lines.push('Use this data to favor goal sources that historically succeed.');

    return lines.join('\n');
  }
}

// ── Helpers ──

function parseOriginFromSource(source: string): GoalOrigin {
  const lower = source.toLowerCase();
  if (lower.startsWith('strategist')) return 'strategist';
  if (lower.startsWith('reflection')) return 'reflection';
  if (lower.startsWith('environment') || lower.startsWith('sensor')) return 'environment';
  if (lower.startsWith('mesh') || lower.startsWith('peer')) return 'mesh';
  if (lower.startsWith('crystallizer')) return 'crystallizer';
  if (lower.startsWith('operator') || lower.startsWith('human') || lower.startsWith('user'))
    return 'operator';
  return 'operator';
}

function extractContextFromSource(source: string): string | null {
  // "strategist:2026-03-24:from=behavioral_rut" → "behavioral_rut"
  const fromMatch = source.match(/from=([^\s:]+)/);
  if (fromMatch) return fromMatch[1];

  // "reflection:2026-03-24" → null (no extra context)
  return null;
}

// ── Serialization helpers ──

/**
 * Serialize genealogy fields into GOALS.md metadata lines.
 */
export function serializeGenealogyFields(goal: EnrichedGoalEntry): string[] {
  const lines: string[] = [];
  if (goal.origin) lines.push(`  - origin: ${goal.origin}`);
  if (goal.originContext) lines.push(`  - origin_context: ${goal.originContext}`);
  if (goal.parentGoalId) lines.push(`  - parent: ${goal.parentGoalId}`);
  if (goal.outcomeScore !== undefined)
    lines.push(`  - outcome_score: ${goal.outcomeScore.toFixed(2)}`);
  return lines;
}

/**
 * Parse genealogy fields from GOALS.md metadata lines.
 */
export function parseGenealogyFields(metadataLines: Record<string, string>): GoalGenealogyFields {
  const fields: GoalGenealogyFields = {};
  if (metadataLines.origin) fields.origin = metadataLines.origin as GoalOrigin;
  if (metadataLines.origin_context) fields.originContext = metadataLines.origin_context;
  if (metadataLines.parent) fields.parentGoalId = metadataLines.parent;
  if (metadataLines.outcome_score)
    fields.outcomeScore = Number.parseFloat(metadataLines.outcome_score);
  return fields;
}
