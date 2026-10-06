/**
 * Everything about one goal, for the Agent Home goal sidebar
 * (`GET /api/agents/:id/goals/detail`).
 *
 * Work is tied to a goal per agent-loop cycle, three ways:
 * - exact: the agent loop recorded the cycle with the goal's id
 *   (`agent-cycles/<bot>/<day>.jsonl`), and every row of the cycle (LLM calls,
 *   tool calls, production entries, asks) carries its `cycleId`;
 * - inferred: an unrecorded cycle (data from before cycles were recorded, a
 *   window rebuilt from the LLM query log: one bot runs one cycle at a time)
 *   that called `manage_goals` naming the goal, or produced a file the goal's
 *   notes mention;
 * - weak: the cycle's plan summary shares enough of the goal's words.
 * Read-only, never throws on missing data.
 */
import { basename, join } from 'node:path';
import type { BotConfig } from '../config';
import { titleTokens } from '../hygiene/text-utils';
import { readEntries } from '../productions/changelog';
import type { ProductionEntry } from '../productions/types';
import { type GoalEntry, findGoalIndex, goalBucket, parseGoals } from '../tools/goals';
import type { StatsContext } from './context';
import { resolveBotPaths } from './paths';
import { type AgentCycleRecord, readAgentCycles } from './readers/agent-cycles';
import {
  type GoalEvent,
  goalTitleKey,
  readGoalEvents,
  readGoalExtras,
} from './readers/goal-events';
import { type LlmQueryEntry, readLlmEntries } from './readers/llm-query-log';
import { type ToolAuditEntry, isToolFailure, readToolEntries } from './readers/tool-audit';
import type {
  GoalAttribution,
  GoalCycle,
  GoalCycleAsk,
  GoalCycleKarma,
  GoalCycleProduction,
  GoalDetailHeader,
  GoalDetailResponse,
  GoalOrigin,
  GoalTimelineEvent,
} from './types';
import { readJsonlSafe, readTextSafe, toIso, toMs } from './util';

export const GOAL_DETAIL_DEFAULT_DAYS = 14;
export const GOAL_DETAIL_MAX_DAYS = 30;
export const GOAL_DETAIL_MAX_CYCLES = 30;
const MAX_TOOLS_PER_CYCLE = 50;
const DAY_MS = 86_400_000;
/** A gap this long between agent-loop LLM calls always starts a new cycle. */
const CYCLE_GAP_MS = 30 * 60_000;
/** Rows land a little after the last LLM call of their cycle. */
const WINDOW_SLACK_MS = 5_000;
const AGENT_LOOP_CALLERS = new Set(['strategist', 'planner', 'executor']);
const ORIGINS: GoalOrigin[] = [
  'operator',
  'agent',
  'strategist',
  'reflection',
  'curiosity',
  'preset',
];

type Tagged = { cycleId?: string; goalId?: string };

export interface GoalKey {
  id?: string | null;
  title?: string | null;
  days?: number;
}

/** Who set a goal and when, from its `source` line (`operator:2026-10-04`). */
export function goalOrigin(source: string | null | undefined): {
  origin: GoalOrigin;
  date: string | null;
} {
  const s = String(source ?? '').trim();
  const head = s.split(':')[0].toLowerCase();
  const origin = (ORIGINS as string[]).includes(head) ? (head as GoalOrigin) : 'unknown';
  if (origin === 'unknown') return { origin, date: null };
  const date = /\d{4}-\d{2}-\d{2}/.exec(s)?.[0] ?? null;
  return { origin, date };
}

export interface CycleWindow {
  startMs: number;
  endMs: number;
  llm: LlmQueryEntry[];
}

function isLoopCaller(caller: string): boolean {
  return AGENT_LOOP_CALLERS.has(caller) || caller.startsWith('curiosity:');
}

/**
 * Rebuild cycle windows from agent-loop LLM calls (timestamp = end of call).
 * A strategist/planner call after an executor call, or a long gap, starts a
 * new cycle. Conversation and other non-loop calls are ignored.
 */
export function reconstructCycleWindows(entries: LlmQueryEntry[]): CycleWindow[] {
  const calls = entries
    .filter((e) => isLoopCaller(String(e.caller)))
    .map((e) => {
      const end = toMs(e.timestamp) ?? 0;
      return { e, start: end - (Number(e.durationMs) || 0), end };
    })
    .sort((a, b) => a.start - b.start);
  const windows: CycleWindow[] = [];
  let cur: CycleWindow | null = null;
  for (const c of calls) {
    const opens = c.e.caller === 'strategist' || c.e.caller === 'planner';
    const hadExecutor = cur?.llm.some((l) => l.caller === 'executor') ?? false;
    if (!cur || (opens && hadExecutor) || c.start - cur.endMs > CYCLE_GAP_MS) {
      cur = { startMs: c.start, endMs: c.end, llm: [c.e] };
      windows.push(cur);
      continue;
    }
    cur.llm.push(c.e);
    cur.startMs = Math.min(cur.startMs, c.start);
    cur.endMs = Math.max(cur.endMs, c.end);
  }
  return windows;
}

interface AskRow {
  id: string;
  type?: string;
  title?: string;
  createdAt: string;
  inboxStatus?: string;
  cycleId?: string;
  goalId?: string;
  metadata?: Tagged;
}

interface OutcomeRow {
  timestamp: number;
  description?: string;
  cycleId?: string;
}

interface KarmaRow {
  timestamp: string;
  delta: number;
  reason: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

interface Rows {
  llm: LlmQueryEntry[];
  tools: ToolAuditEntry[];
  productions: ProductionEntry[];
  asks: AskRow[];
  outcomes: OutcomeRow[];
}

const tagOf = (row: unknown): Tagged => {
  const r = (row ?? {}) as Tagged & { metadata?: Tagged };
  return { cycleId: r.cycleId ?? r.metadata?.cycleId, goalId: r.goalId ?? r.metadata?.goalId };
};

function clip(text: string, max: number): string {
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

export function buildGoalDetail(
  ctx: StatsContext,
  bot: BotConfig,
  key: GoalKey
): GoalDetailResponse | null {
  const now = ctx.now();
  const days = Math.min(
    GOAL_DETAIL_MAX_DAYS,
    Math.max(1, Math.round(Number(key.days) || GOAL_DETAIL_DEFAULT_DAYS))
  );
  const since = now - days * DAY_MS;
  const paths = resolveBotPaths(ctx.config, bot);

  // ── The goal ──
  const { active, completed } = parseGoals(readTextSafe(join(paths.soulDir, 'GOALS.md')));
  const extras = readGoalExtras(paths.soulDir);
  const all: Array<{ g: GoalEntry; section: 'active' | 'completed' }> = [
    ...active.map((g) => ({ g, section: 'active' as const })),
    ...completed.map((g) => ({ g, section: 'completed' as const })),
  ];
  const wantId = key.id?.trim() || null;
  const wantTitle = key.title ? goalTitleKey(key.title) : null;
  const found =
    (wantId && all.find(({ g }) => extras.get(goalTitleKey(g.text))?.id === wantId)) ||
    (wantTitle && all.find(({ g }) => goalTitleKey(g.text) === wantTitle)) ||
    null;
  if (!found) return null;
  const { g, section } = found;
  const gKey = goalTitleKey(g.text);
  const gx = extras.get(gKey) ?? {};
  const goalId = gx.id ?? null;
  const allGoals = all.map((x) => x.g);
  const namesThisGoal = (search: unknown) => {
    if (typeof search !== 'string' || !search.trim()) return false;
    const idx = findGoalIndex(allGoals, search);
    return idx !== -1 && goalTitleKey(allGoals[idx].text) === gKey;
  };
  const isThisGoal = (id?: string | null, title?: string | null) =>
    (goalId !== null && id === goalId) || (!!title && goalTitleKey(title) === gKey);

  // ── Timeline ──
  const events = readGoalEvents(paths.soulDir).filter((e) => isThisGoal(e.goalId, e.title));
  const firstEventMs = Math.min(...events.map((e) => toMs(e.ts) ?? Number.POSITIVE_INFINITY));
  const tools = readToolEntries(ctx.dirs.toolAudit, bot.id, since, now);
  const timeline: GoalTimelineEvent[] = [
    ...events.map((e: GoalEvent) => ({
      ts: e.ts,
      op: e.op,
      from: e.from ?? null,
      to: e.to ?? null,
      actor: e.actor ?? null,
      note: null,
      inferred: false,
      source: 'goal-events' as const,
    })),
    ...tools
      .filter(
        (t) =>
          t.toolName === 'manage_goals' &&
          (toMs(t.timestamp) ?? 0) < firstEventMs &&
          namesThisGoal(t.args?.goal)
      )
      .map((t) => {
        const action = String(t.args?.action ?? '');
        const status = typeof t.args?.status === 'string' ? t.args.status : null;
        const op =
          action === 'add'
            ? 'add'
            : action === 'complete'
              ? 'complete'
              : status
                ? 'status'
                : 'notes';
        const notes = typeof t.args?.notes === 'string' ? clip(t.args.notes, 200) : null;
        return {
          ts: t.timestamp,
          op,
          from: null,
          to: op === 'complete' ? 'done' : status,
          actor: 'tool',
          note: notes,
          inferred: true,
          source: 'tool-audit' as const,
        };
      }),
  ].sort((a, b) => (toMs(a.ts) ?? 0) - (toMs(b.ts) ?? 0));

  // ── Rows ──
  const llm = readLlmEntries(ctx.dirs.llmQueryLog, bot.id, since, now);
  const changelog = readChangelog(paths.workDir);
  const productions = changelog.filter((p) => (toMs(p.timestamp) ?? 0) >= since);
  const asks = readAsks(ctx.dirs.conversations, bot.id).filter(
    (a) => (toMs(a.createdAt) ?? 0) >= since
  );
  const outcomes = readJsonlSafe<OutcomeRow>(
    join(ctx.dirs.outcomeLedger, bot.id, 'outcomes.jsonl')
  ).filter((o) => (toMs(o?.timestamp) ?? 0) >= since);
  const karmaRows = readJsonlSafe<KarmaRow>(join(ctx.dirs.karma, bot.id, 'events.jsonl')).filter(
    (k) => (toMs(k?.timestamp) ?? 0) >= since
  );
  const records = readAgentCycles(ctx.dirs.agentCycles, bot.id, since, now);

  const byCycle = (id: string): Rows => ({
    llm: llm.filter((r) => tagOf(r).cycleId === id),
    tools: tools.filter((r) => tagOf(r).cycleId === id),
    productions: productions.filter((r) => tagOf(r).cycleId === id),
    asks: asks.filter((r) => tagOf(r).cycleId === id),
    outcomes: outcomes.filter((r) => tagOf(r).cycleId === id),
  });
  const untagged = <T>(rows: T[]) => rows.filter((r) => !tagOf(r).cycleId);
  const inWindow = (ms: number | null, w: { startMs: number; endMs: number }) =>
    ms !== null && ms >= w.startMs - 1_000 && ms <= w.endMs + WINDOW_SLACK_MS;
  const byWindow = (w: { startMs: number; endMs: number }, llmRows: LlmQueryEntry[]): Rows => ({
    llm: llmRows,
    tools: untagged(tools).filter((r) => r.chatId === 0 && inWindow(toMs(r.timestamp), w)),
    productions: untagged(productions).filter((r) => inWindow(toMs(r.timestamp), w)),
    asks: untagged(asks).filter((r) => inWindow(toMs(r.createdAt), w)),
    outcomes: untagged(outcomes).filter((r) => inWindow(toMs(r.timestamp), w)),
  });

  // Signals for cycles that were not recorded against this goal.
  const notesText = `${g.notes ?? ''} ${g.outcome ?? ''}`.toLowerCase();
  const goalWords = new Set(titleTokens(g.text).filter((w) => w.length >= 3));
  const signal = (
    rows: Rows,
    summary: string | null
  ): { attribution: GoalAttribution; reason: string } | null => {
    if (rows.tools.some((t) => t.toolName === 'manage_goals' && namesThisGoal(t.args?.goal)))
      return { attribution: 'inferred', reason: 'manage_goals named this goal' };
    const files = [
      ...rows.productions.map((p) => p.path),
      ...rows.tools
        .filter((t) => t.toolName === 'file_write' || t.toolName === 'file_edit')
        .map((t) => String(t.args?.path ?? '')),
    ]
      .map((p) => basename(p).toLowerCase())
      .filter((p) => p.length > 3);
    if (files.some((f) => notesText.includes(f)))
      return { attribution: 'inferred', reason: 'file named in goal notes' };
    if (summary && goalWords.size > 0) {
      const words = new Set(titleTokens(summary));
      const shared = [...goalWords].filter((w) => words.has(w)).length;
      if (shared >= 3 && shared / goalWords.size >= 0.25)
        return { attribution: 'weak', reason: 'keyword overlap' };
    }
    return null;
  };

  interface Candidate {
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
  const candidates: Candidate[] = [];
  const summaryOf = (rows: Rows, record?: AgentCycleRecord) =>
    record?.planSummary ||
    record?.focus ||
    rows.outcomes.map((o) => o.description).find(Boolean) ||
    null;

  // 1. Recorded cycles.
  const recordedIds = new Set<string>();
  for (const r of records) {
    recordedIds.add(r.cycleId);
    const startMs = toMs(r.startedAt) ?? 0;
    const endMs = toMs(r.endedAt) ?? startMs + (Number(r.durationMs) || 0);
    let rows = byCycle(r.cycleId);
    if (rows.llm.length === 0) rows = byWindow({ startMs, endMs }, []);
    let hit: { attribution: GoalAttribution; reason: string } | null = null;
    if (isThisGoal(r.goalId, r.goalTitle)) hit = { attribution: 'exact', reason: 'cycle log' };
    else if (!r.goalId && !r.goalTitle) hit = signal(rows, summaryOf(rows, r));
    if (!hit) continue;
    candidates.push({
      cycleId: r.cycleId,
      startMs,
      endMs,
      status: r.status ?? null,
      focus: r.focus ?? null,
      planSummary: r.planSummary ?? null,
      ...hit,
      rows,
    });
  }

  // 2. Cycles known only by the cycleId on their rows.
  const looseIds = new Set(
    [...llm, ...tools]
      .map((r) => tagOf(r).cycleId)
      .filter((id): id is string => !!id && !recordedIds.has(id))
  );
  for (const id of looseIds) {
    const rows = byCycle(id);
    const times = [...rows.llm, ...rows.tools]
      .map((r) => toMs(r.timestamp))
      .filter((t): t is number => t !== null);
    if (times.length === 0) continue;
    const firstLlm = rows.llm[0];
    const startMs = Math.min(...times) - (firstLlm ? Number(firstLlm.durationMs) || 0 : 0);
    const goalIds = new Set(
      [...rows.llm, ...rows.tools].map((r) => tagOf(r).goalId).filter(Boolean)
    );
    let hit: { attribution: GoalAttribution; reason: string } | null = null;
    if (goalId !== null && goalIds.has(goalId)) hit = { attribution: 'exact', reason: 'cycle id' };
    else if (goalId === null || goalIds.size === 0) hit = signal(rows, summaryOf(rows));
    if (!hit) continue;
    candidates.push({
      cycleId: id,
      startMs,
      endMs: Math.max(...times),
      status: null,
      focus: null,
      planSummary: summaryOf(rows),
      ...hit,
      rows,
    });
  }

  // 3. Windows rebuilt from untagged LLM calls (data from before cycle ids).
  for (const w of reconstructCycleWindows(untagged(llm))) {
    const rows = byWindow(w, w.llm);
    const summary = summaryOf(rows);
    const hit = signal(rows, summary);
    if (!hit) continue;
    candidates.push({
      cycleId: null,
      startMs: w.startMs,
      endMs: w.endMs,
      status: null,
      focus: null,
      planSummary: summary,
      ...hit,
      rows,
    });
  }

  const kept = candidates.sort((a, b) => b.startMs - a.startMs).slice(0, GOAL_DETAIL_MAX_CYCLES);

  // Review state per production row: its own verdict, else pending when it is
  // the file's latest content row, else superseded (null).
  const latestContent = new Map<string, string>();
  for (const p of changelog) {
    if (p.action === 'create' || p.action === 'edit') latestContent.set(p.path, p.id);
  }
  const reviewOf = (p: ProductionEntry): GoalCycleProduction['review'] => {
    const s = p.evaluation?.status;
    if (s === 'approved' || s === 'rejected') return s;
    if (p.action !== 'create' && p.action !== 'edit') return null;
    return latestContent.get(p.path) === p.id ? 'pending' : null;
  };

  // Karma: tagged by cycle, or the review of a file the cycle produced
  // (credited to the newest kept cycle that produced it before the event).
  const karmaFor = new Map<Candidate, GoalCycleKarma[]>();
  for (const k of karmaRows) {
    const tag = tagOf(k.metadata);
    const ms = toMs(k.timestamp) ?? 0;
    const path = typeof k.metadata?.path === 'string' ? k.metadata.path : null;
    const owner = tag.cycleId
      ? kept.find((c) => c.cycleId === tag.cycleId)
      : path
        ? kept.find((c) => c.startMs <= ms && c.rows.productions.some((p) => p.path === path))
        : undefined;
    if (!owner) continue;
    const list = karmaFor.get(owner) ?? [];
    list.push({
      ts: k.timestamp,
      delta: Number(k.delta) || 0,
      reason: k.reason,
      kind: k.kind ?? null,
    });
    karmaFor.set(owner, list);
  }

  const cycles: GoalCycle[] = kept.map((c) => ({
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
    karma: karmaFor.get(c) ?? [],
  }));

  const started =
    gx.started ??
    timeline.find((e) => e.to === 'in_progress' || e.to === 'in-progress')?.ts ??
    null;
  const header: GoalDetailHeader = {
    id: goalId,
    text: g.text,
    status: g.status,
    section,
    bucket: section === 'completed' ? 'done' : goalBucket(g.status),
    priority: g.priority,
    notes: g.notes ?? null,
    outcome: g.outcome ?? null,
    source: g.source ?? null,
    ...(() => {
      const o = goalOrigin(g.source);
      return { origin: o.origin, originDate: o.date };
    })(),
    created: g.created ?? null,
    started,
    updated: gx.updated ?? timeline.at(-1)?.ts ?? null,
    completed: g.completed ?? null,
  };

  const exactCycles = cycles.filter((c) => c.attribution === 'exact').length;
  const exact = goalId !== null && (events.length > 0 || exactCycles > 0);
  return {
    botId: bot.id,
    generatedAt: new Date(now).toISOString(),
    days,
    goal: header,
    timeline,
    cycles,
    totals: {
      cycles: cycles.length,
      exactCycles,
      inferredCycles: cycles.length - exactCycles,
      llmCalls: cycles.reduce((s, c) => s + c.llmCalls.length, 0),
      tokens: cycles.reduce(
        (s, c) => s + c.llmCalls.reduce((t, l) => t + l.promptTokens + l.completionTokens, 0),
        0
      ),
      toolCalls: cycles.reduce((s, c) => s + c.toolCalls.length, 0),
      toolFailures: cycles.reduce((s, c) => s + c.toolCalls.filter((t) => !t.ok).length, 0),
      files: cycles.reduce((s, c) => s + c.productions.length, 0),
      asks: cycles.reduce((s, c) => s + c.asks.length, 0),
    },
    tracking: {
      exact,
      note: exact
        ? 'Cycles recorded with this goal are exact; older ones are inferred from logs.'
        : 'Exact tracking starts once the agent records which goal each cycle serves; everything here is inferred from logs.',
    },
  };
}
