/**
 * One agent-loop cycle on its own, for the "Open cycle" sheet every Why links
 * to (`GET /api/agents/:id/cycles/:cycleId`). Same rows and shape as a cycle
 * in the goal drawer (`cycle-rows.ts`). Read-only, never throws on missing data.
 */
import type { BotConfig } from '../config';
import { cycleRuleText } from '../why/builders/cycle';
import type { StatsContext } from './context';
import {
  type CycleCandidate,
  karmaRowToCycleKarma,
  readCycleSources,
  reviewStateOf,
  rowsOfCycle,
  tagOf,
  toGoalCycle,
} from './cycle-rows';
import type { AgentCycleRecord } from './readers/agent-cycles';
import type { CycleDetailResponse, GoalCycleKarma } from './types';
import { toMs } from './util';

/** How far back a cycle id is looked up. */
export const CYCLE_DETAIL_LOOKBACK_DAYS = 30;
const DAY_MS = 86_400_000;

export function buildCycleDetail(
  ctx: StatsContext,
  bot: BotConfig,
  cycleId: string
): CycleDetailResponse | null {
  const id = cycleId.trim();
  if (!id) return null;
  const now = ctx.now();
  const src = readCycleSources(ctx, bot, now - CYCLE_DETAIL_LOOKBACK_DAYS * DAY_MS, now);
  const record = src.records.find((r) => r.cycleId === id);
  const rows = rowsOfCycle(src, id);
  const times = [...rows.llm, ...rows.tools]
    .map((r) => toMs(r.timestamp))
    .filter((t): t is number => t !== null);
  if (!record && times.length === 0) return null;

  const firstLlm = rows.llm[0];
  const startMs = record
    ? (toMs(record.startedAt) ?? 0)
    : Math.min(...times) - (firstLlm ? Number(firstLlm.durationMs) || 0 : 0);
  const endMs = record
    ? (toMs(record.endedAt) ?? startMs + (Number(record.durationMs) || 0))
    : Math.max(...times);
  const candidate: CycleCandidate = {
    cycleId: id,
    startMs,
    endMs,
    status: record?.status ?? null,
    focus: record?.focus ?? null,
    planSummary:
      record?.planSummary ||
      record?.focus ||
      rows.outcomes.map((o) => o.description).find(Boolean) ||
      null,
    attribution: 'exact',
    reason: record ? 'cycle log' : 'cycle id',
    rows,
  };

  // Karma: tagged with this cycle, or the review of a file it produced when no
  // later cycle produced that file before the event (the goal drawer's rule).
  const producers = (path: string) =>
    src.productions
      .filter((p) => p.path === path && tagOf(p).cycleId)
      .map((p) => ({ cycleId: tagOf(p).cycleId, ms: toMs(p.timestamp) ?? 0 }));
  const karma: GoalCycleKarma[] = src.karma
    .filter((k) => {
      const tag = tagOf(k.metadata);
      if (tag.cycleId) return tag.cycleId === id;
      const path = typeof k.metadata?.path === 'string' ? k.metadata.path : null;
      if (!path || !rows.productions.some((p) => p.path === path)) return false;
      const ms = toMs(k.timestamp) ?? 0;
      if (ms < startMs) return false;
      const latest = producers(path)
        .filter((p) => p.ms <= ms)
        .sort((a, b) => b.ms - a.ms)[0];
      return !latest || latest.cycleId === id;
    })
    .map(karmaRowToCycleKarma);

  const goalId = record?.goalId ?? rows.llm.map((r) => tagOf(r).goalId).find(Boolean) ?? null;
  const goalTitle = record?.goalTitle ?? null;
  return {
    botId: bot.id,
    generatedAt: new Date(now).toISOString(),
    cycle: toGoalCycle(candidate, karma, reviewStateOf(src.changelog)),
    goal: goalTitle ? { id: goalId, title: goalTitle } : null,
    ...recordedWhy(record),
  };
}

const REASON_SOURCES: Record<string, string> = {
  planner: 'Planner',
  'engagement-gate': 'Engagement gate',
  'circuit-breaker': 'Circuit breaker',
  error: 'Error',
  system: 'System',
};

/** The why-fields the cycle log recorded for the cycle (row 11 of the Why plan). */
function recordedWhy(
  record: AgentCycleRecord | undefined
): Pick<CycleDetailResponse, 'cycleReason' | 'strategistRan' | 'reflection' | 'traitAdjustments'> {
  const reason = typeof record?.reason === 'string' ? record.reason.trim() : '';
  const reflection = typeof record?.reflection === 'string' ? record.reflection.trim() : '';
  const traits = record?.traitAdjustments;
  return {
    cycleReason: reason
      ? {
          text: cycleRuleText(reason, record?.reasonSource),
          source: REASON_SOURCES[record?.reasonSource ?? ''] ?? 'Recorded',
        }
      : null,
    strategistRan: typeof record?.strategistRan === 'boolean' ? record.strategistRan : null,
    reflection: reflection || null,
    traitAdjustments:
      traits && typeof traits === 'object' && Object.keys(traits).length > 0 ? traits : null,
  };
}
