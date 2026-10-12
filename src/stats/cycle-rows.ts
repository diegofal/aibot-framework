/**
 * The rows of an agent-loop cycle — LLM calls, tool calls, production
 * entries, asks, outcomes, karma — read from disk and shaped into a
 * `GoalCycle`. Shared by the goal drawer (`goal-detail-aggregator.ts`) and the
 * single-cycle view (`cycle-detail.ts`). Read-only, never throws on missing data.
 */
import { join } from 'node:path';
import type { BotConfig } from '../config';
import { readEntries } from '../productions/changelog';
import type { ProductionEntry } from '../productions/types';
import type { StatsContext } from './context';
import { resolveBotPaths } from './paths';
import { type AgentCycleRecord, readAgentCycles } from './readers/agent-cycles';
import { type LlmQueryEntry, readLlmEntries } from './readers/llm-query-log';
import { type ToolAuditEntry, isToolFailure, readToolEntries } from './readers/tool-audit';
import type {
  GoalAttribution,
  GoalCycle,
  GoalCycleAsk,
  GoalCycleKarma,
  GoalCycleProduction,
} from './types';
import { readJsonlSafe, toIso, toMs } from './util';

export const MAX_TOOLS_PER_CYCLE = 50;

export type Tagged = { cycleId?: string; goalId?: string };

export interface AskRow {
  id: string;
  type?: string;
  title?: string;
  createdAt: string;
  inboxStatus?: string;
  cycleId?: string;
  goalId?: string;
  metadata?: Tagged;
}

export interface OutcomeRow {
  timestamp: number;
  description?: string;
  cycleId?: string;
}

export interface KarmaRow {
  timestamp: string;
  delta: number;
  reason: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

export interface Rows {
  llm: LlmQueryEntry[];
  tools: ToolAuditEntry[];
  productions: ProductionEntry[];
  asks: AskRow[];
  outcomes: OutcomeRow[];
}

export const tagOf = (row: unknown): Tagged => {
  const r = (row ?? {}) as Tagged & { metadata?: Tagged };
  return { cycleId: r.cycleId ?? r.metadata?.cycleId, goalId: r.goalId ?? r.metadata?.goalId };
};

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function readChangelog(workDir: string): ProductionEntry[] {
  try {
    return readEntries(join(workDir, 'changelog.jsonl'));
  } catch {
    return [];
  }
}

function readAsks(dir: string, botId: string): AskRow[] {
  const byId = new Map<string, AskRow>();
  for (const c of readJsonlSafe<AskRow>(join(dir, botId, 'conversations.jsonl'))) {
    if (c?.type === 'inbox' && c.id) byId.set(c.id, c);
  }
  return [...byId.values()];
}

/** Every source a cycle's rows come from, for one bot over [since, now]. */
export interface CycleSources {
  llm: LlmQueryEntry[];
  tools: ToolAuditEntry[];
  /** The whole changelog (review state needs every row), unfiltered. */
  changelog: ProductionEntry[];
  productions: ProductionEntry[];
  asks: AskRow[];
  outcomes: OutcomeRow[];
  karma: KarmaRow[];
  records: AgentCycleRecord[];
}

export function readCycleSources(
  ctx: StatsContext,
  bot: BotConfig,
  since: number,
  now: number
): CycleSources {
  const paths = resolveBotPaths(ctx.config, bot);
  const changelog = readChangelog(paths.workDir);
  return {
    llm: readLlmEntries(ctx.dirs.llmQueryLog, bot.id, since, now),
    tools: readToolEntries(ctx.dirs.toolAudit, bot.id, since, now),
    changelog,
    productions: changelog.filter((p) => (toMs(p.timestamp) ?? 0) >= since),
    asks: readAsks(ctx.dirs.conversations, bot.id).filter((a) => (toMs(a.createdAt) ?? 0) >= since),
    outcomes: readJsonlSafe<OutcomeRow>(
      join(ctx.dirs.outcomeLedger, bot.id, 'outcomes.jsonl')
    ).filter((o) => (toMs(o?.timestamp) ?? 0) >= since),
    karma: readJsonlSafe<KarmaRow>(join(ctx.dirs.karma, bot.id, 'events.jsonl')).filter(
      (k) => (toMs(k?.timestamp) ?? 0) >= since
    ),
    records: readAgentCycles(ctx.dirs.agentCycles, bot.id, since, now),
  };
}

/** The rows stamped with one cycle id. */
export function rowsOfCycle(src: CycleSources, id: string): Rows {
  return {
    llm: src.llm.filter((r) => tagOf(r).cycleId === id),
    tools: src.tools.filter((r) => tagOf(r).cycleId === id),
    productions: src.productions.filter((r) => tagOf(r).cycleId === id),
    asks: src.asks.filter((r) => tagOf(r).cycleId === id),
    outcomes: src.outcomes.filter((r) => tagOf(r).cycleId === id),
  };
}

/**
 * Review state per production row: its own verdict, else pending when it is
 * the file's latest content row, else superseded (null).
 */
export function reviewStateOf(
  changelog: ProductionEntry[]
): (p: ProductionEntry) => GoalCycleProduction['review'] {
  const latestContent = new Map<string, string>();
  for (const p of changelog) {
    if (p.action === 'create' || p.action === 'edit') latestContent.set(p.path, p.id);
  }
  return (p) => {
    const s = p.evaluation?.status;
    if (s === 'approved' || s === 'rejected') return s;
    if (p.action !== 'create' && p.action !== 'edit') return null;
    return latestContent.get(p.path) === p.id ? 'pending' : null;
  };
}

export function karmaRowToCycleKarma(k: KarmaRow): GoalCycleKarma {
  return { ts: k.timestamp, delta: Number(k.delta) || 0, reason: k.reason, kind: k.kind ?? null };
}

/** One cycle, as found, before it is shaped. */
export interface CycleCandidate {
  cycleId: string | null;
  startMs: number;
  endMs: number;
  status: string | null;
  focus: string | null;
  planSummary: string | null;
  attribution: GoalAttribution;
  reason: string;
  rows: Rows;
}

export function toGoalCycle(
  c: CycleCandidate,
  karma: GoalCycleKarma[],
  reviewOf: (p: ProductionEntry) => GoalCycleProduction['review']
): GoalCycle {
  return {
    cycleId: c.cycleId,
    startedAt: toIso(c.startMs) ?? '',
    endedAt: toIso(c.endMs) ?? '',
    durationMs: Math.max(0, c.endMs - c.startMs),
    status: c.status,
    focus: c.focus,
    planSummary: c.planSummary,
    attribution: c.attribution,
    reason: c.reason,
    llmCalls: c.rows.llm.map((l) => ({
      ts: l.timestamp,
      caller: String(l.caller),
      backend: l.backend,
      model: l.model,
      promptTokens: Number(l.promptTokens) || 0,
      completionTokens: Number(l.completionTokens) || 0,
      durationMs: Number(l.durationMs) || 0,
      ok: l.success !== false,
      error: l.error ? clip(l.error, 200) : null,
    })),
    toolCalls: c.rows.tools.slice(0, MAX_TOOLS_PER_CYCLE).map((t) => ({
      ts: t.timestamp,
      name: t.toolName,
      ok: !isToolFailure(t),
      failureKind: t.failureKind ?? null,
      args: clip(JSON.stringify(t.args ?? {}), 160),
      result: clip(String(t.result ?? ''), 200),
    })),
    productions: c.rows.productions.map((p) => ({
      ts: p.timestamp,
      path: p.path,
      action: p.action,
      size: p.size,
      description: p.description,
      review: reviewOf(p),
    })),
    asks: c.rows.asks.map(
      (a): GoalCycleAsk => ({
        id: a.id,
        title: a.title ?? '',
        createdAt: a.createdAt,
        status: a.inboxStatus ?? null,
      })
    ),
    karma,
  };
}
