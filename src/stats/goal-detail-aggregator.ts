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
import { type GoalEntry, findGoalIndex, goalBucket, parseGoals } from '../tools/goals';
import { goalEventToWhy } from '../why/builders/goal-event';
import { CycleIndex } from '../why/cycle-index';
import type { StatsContext } from './context';
import {
  type CycleCandidate,
  type Rows,
  clip,
  karmaRowToCycleKarma,
  readCycleSources,
  reviewStateOf,
  rowsOfCycle,
  tagOf,
  toGoalCycle,
} from './cycle-rows';
import { resolveBotPaths } from './paths';
import { type AgentCycleRecord, readAgentCycles } from './readers/agent-cycles';
import {
  type GoalEvent,
  goalTitleKey,
  readGoalEvents,
  readGoalExtras,
} from './readers/goal-events';
import type { LlmQueryEntry } from './readers/llm-query-log';
import type {
  GoalAttribution,
  GoalCycle,
  GoalCycleKarma,
  GoalDetailHeader,
  GoalDetailResponse,
  GoalOrigin,
  GoalTimelineEvent,
} from './types';
import { readTextSafe, toMs } from './util';

export const GOAL_DETAIL_DEFAULT_DAYS = 14;
export const GOAL_DETAIL_MAX_DAYS = 30;
export const GOAL_DETAIL_MAX_CYCLES = 30;
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

/**
 * Each timeline change with its `why`: the cycle row comes from the cycles
 * already read for the window, and changes older than the window get one more
 * read of the cycle log spanning just them (`CycleIndex.for`).
 */
function explainTimeline(
  ctx: StatsContext,
  botId: string,
  changes: Array<Omit<GoalTimelineEvent, 'why'>>,
  records: AgentCycleRecord[],
  since: number
): GoalTimelineEvent[] {
  const known = new Map(records.map((r) => [r.cycleId, r]));
  const older = changes.filter(
    (c) => c.cycleId && !known.has(c.cycleId) && (toMs(c.ts) ?? since) < since
  );
  const index = CycleIndex.for(
    older.length > 0 ? (b, s, u) => readAgentCycles(ctx.dirs.agentCycles, b, s, u) : undefined,
    older.map((c) => ({ botId, at: c.ts }))
  );
  return changes.map((c) => {
    const cycle = c.cycleId ? (known.get(c.cycleId) ?? index.byId(botId, c.cycleId)) : undefined;
    return { ...c, why: goalEventToWhy({ botId, event: c, ...(cycle ? { cycle } : {}) }) };
  });
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
  const src = readCycleSources(ctx, bot, since, now);
  const { tools } = src;
  const changes: Array<Omit<GoalTimelineEvent, 'why'>> = [
    ...events.map((e: GoalEvent) => ({
      ts: e.ts,
      op: e.op,
      from: e.from ?? null,
      to: e.to ?? null,
      actor: e.actor ?? null,
      note: e.note ?? null,
      ...(e.task ? { task: e.task } : {}),
      inferred: false,
      source: 'goal-events' as const,
      cycleId: e.cycleId ?? null,
      reason: e.reason ?? null,
      runId: e.runId ?? null,
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
          cycleId: tagOf(t).cycleId ?? null,
          reason: null,
          runId: null,
        };
      }),
  ].sort((a, b) => (toMs(a.ts) ?? 0) - (toMs(b.ts) ?? 0));
  const timeline = explainTimeline(ctx, bot.id, changes, src.records, since);

  // ── Rows ──
  const { llm, changelog, productions, asks, outcomes, records } = src;
  const karmaRows = src.karma;
  const byCycle = (id: string): Rows => rowsOfCycle(src, id);
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

  type Candidate = CycleCandidate;
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

  const reviewOf = reviewStateOf(changelog);

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
    list.push(karmaRowToCycleKarma(k));
    karmaFor.set(owner, list);
  }

  const cycles: GoalCycle[] = kept.map((c) => toGoalCycle(c, karmaFor.get(c) ?? [], reviewOf));

  const started =
    gx.started ??
    timeline.find(
      (e) => !e.op.startsWith('task-') && (e.to === 'in_progress' || e.to === 'in-progress')
    )?.ts ??
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
