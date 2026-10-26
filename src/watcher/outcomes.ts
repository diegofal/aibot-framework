/**
 * What became of the watcher's broadcasts and predictions (phase 3), read
 * from records only:
 * - a broadcast is served when a completed cycle row of the same bot, ended
 *   after the broadcast, names it in `servesBroadcast` (the planner's
 *   `serves_broadcast`); the first such cycle wins;
 * - a prediction resolves once its `dueAt` passes: a tier 1 call judges it
 *   against the ground truth of the bots it names (tool audit + cycle log in
 *   `[createdAt, dueAt]`, `groundTruthLines`) and the watcher rows, and
 *   answers `{ outcome: happened | did_not_happen | unknown, evidence }`
 *   (the old `{ happened }` still parses). Stored on the neuron: `resolvedAt`,
 *   `outcome`, `evidence`, `resolvedModel`, and for a settled one `happened`
 *   and `brier`; `unknown` is final and never scored. Nothing recorded about
 *   the named bots = `unknown` without a call. Budget and breaker apply (the
 *   instrumented client); a refused call stops the pass, an unreadable answer
 *   leaves the prediction open. Never throws.
 */
import { parseLLMJson } from '../bot/llm-json-parser';
import type { Broadcast, Broadcaster } from './broadcast';
import type { Graph } from './graph';
import type { InstrumentedClient, WatcherCallResult } from './llm';
import type { WatcherLog } from './log';
import { narratePredictionResolved, narratePredictionUnknown } from './narration';
import type { Neuron } from './types';

/** Most predictions one resolution pass asks about. */
export const RESOLVE_MAX_PER_PASS = 3;
const MAX_EVENTS = 40;
const EVIDENCE_MAX = 300;

/** The slice of a cycle row the served check reads. */
export interface ServedCycleRow {
  cycleId: string;
  botId?: string;
  endedAt?: string;
  status?: string;
  servesBroadcast?: string;
}

/** Brier score of one forecast: (p − outcome)². A missing probability is 0.5. */
export function brierScore(probability: number, happened: boolean): number {
  const p = Number.isFinite(probability) ? Math.min(1, Math.max(0, probability)) : 0.5;
  const o = happened ? 1 : 0;
  return (p - o) ** 2;
}

/** Unserved broadcasts that a completed cycle served, with that cycle. */
export function servedFromCycles(
  broadcasts: Broadcast[],
  cycles: ServedCycleRow[]
): Array<{ id: string; cycleId: string; at: string }> {
  const out: Array<{ id: string; cycleId: string; at: string }> = [];
  const sorted = [...cycles].sort((a, b) =>
    String(a.endedAt ?? '').localeCompare(String(b.endedAt ?? ''))
  );
  for (const b of broadcasts) {
    if (b.servedByCycle) continue;
    const created = Date.parse(b.createdAt);
    const row = sorted.find(
      (r) =>
        r.servesBroadcast === b.id &&
        r.status === 'completed' &&
        (r.botId === undefined || r.botId === b.botId) &&
        typeof r.endedAt === 'string' &&
        Date.parse(r.endedAt) >= created
    );
    if (row) out.push({ id: b.id, cycleId: row.cycleId, at: row.endedAt as string });
  }
  return out;
}

/** Mark what the cycles served; returns how many changed. */
export function applyServed(
  broadcaster: Pick<Broadcaster, 'list' | 'markServed'>,
  cycles: ServedCycleRow[]
): number {
  let n = 0;
  for (const s of servedFromCycles(broadcaster.list(), cycles)) {
    if (broadcaster.markServed(s.id, s.cycleId, s.at)) n++;
  }
  return n;
}

/** Live, unresolved predictions whose `dueAt` has passed, oldest due first. */
export function duePredictions(graph: Pick<Graph, 'list'>, nowMs: number): Neuron[] {
  return graph
    .list()
    .filter(
      (n) =>
        n.kind === 'prediction' &&
        !n.archivedAt &&
        !n.meta?.resolvedAt &&
        Number.isFinite(Date.parse(n.meta?.dueAt ?? '')) &&
        Date.parse(n.meta?.dueAt as string) <= nowMs
    )
    .sort((a, b) => Date.parse(a.meta?.dueAt ?? '') - Date.parse(b.meta?.dueAt ?? ''));
}

/** What the judge answers: it came true, it did not, or the records cannot settle it. */
export type PredictionOutcome = 'happened' | 'did_not_happen' | 'unknown';

export interface PredictionResolution {
  outcome: PredictionOutcome;
  /** Absent for `unknown`. */
  happened?: boolean;
  evidence?: string;
}

const OUTCOMES: readonly PredictionOutcome[] = ['happened', 'did_not_happen', 'unknown'];

/**
 * The judge's answer: `{ outcome, evidence }`, or the old `{ happened, evidence }`
 * (still read, for answers written before the outcome schema). Null when neither.
 */
export function parsePredictionResolution(
  text: string,
  logger: { warn: (obj: object, msg: string) => void }
): PredictionResolution | null {
  const warnOnly = { warn: (obj: object, msg?: string) => logger.warn(obj, msg ?? '') };
  return parseLLMJson<PredictionResolution>(text ?? '', warnOnly as never, {
    label: 'watcher prediction',
    extractPattern: /\{[\s\S]*"(?:outcome|happened)"[\s\S]*\}/,
    validate: (raw) => {
      if (!raw || typeof raw !== 'object') return null;
      let outcome: PredictionOutcome | undefined;
      if (typeof raw.outcome === 'string' && OUTCOMES.includes(raw.outcome as PredictionOutcome)) {
        outcome = raw.outcome as PredictionOutcome;
      } else if (raw.outcome === undefined && typeof raw.happened === 'boolean') {
        outcome = raw.happened ? 'happened' : 'did_not_happen';
      }
      if (!outcome) return null;
      return {
        outcome,
        ...(outcome === 'unknown' ? {} : { happened: outcome === 'happened' }),
        ...(typeof raw.evidence === 'string' && raw.evidence.trim()
          ? { evidence: raw.evidence.trim() }
          : {}),
      };
    },
  });
}

/** One audited tool call, as the judge reads it (from the tool audit). */
export interface GroundTruthTool {
  ts: string;
  tool: string;
  success: boolean;
  failureKind?: string;
  /** Host + path of a URL, a file path or a command (`toolTarget`). */
  target?: string;
}

/** One agent-loop cycle row, as the judge reads it (from the cycle log). */
export interface GroundTruthCycle {
  startedAt: string;
  endedAt?: string;
  status?: string;
  planSummary?: string | null;
  focus?: string | null;
  goalTitle?: string | null;
}

export interface GroundTruthBot {
  id: string;
  /** How the lines name it (the display name). */
  name?: string;
  /** Other names a prediction may use (the config name). */
  aliases?: string[];
}

/** Where the ground truth comes from: the fleet's tool audit and cycle log, per bot and window. */
export interface GroundTruthDeps {
  bots: () => GroundTruthBot[];
  tools?: (botId: string, fromMs: number, toMs: number) => GroundTruthTool[];
  cycles?: (botId: string, fromMs: number, toMs: number) => GroundTruthCycle[];
}

/** Most ground-truth lines one judge prompt carries. */
export const GROUND_TRUTH_MAX_LINES = 60;
const LINE_TEXT_MAX = 160;

const words = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;

/** The bots a text names (id, name or alias as whole words); possibly none. Pure. */
export function namedBots(text: string, bots: GroundTruthBot[]): GroundTruthBot[] {
  const hay = words(text);
  return bots.filter((b) =>
    [b.id, b.name, ...(b.aliases ?? [])].some((needle) => {
      const w = needle ? words(needle) : '  ';
      return w.trim().length > 0 && hay.includes(w);
    })
  );
}

/** The bots a prediction names (id or name as whole words); none named = every bot. Pure. */
export function predictionBots(text: string, bots: GroundTruthBot[]): GroundTruthBot[] {
  const named = namedBots(text, bots);
  return named.length ? named : bots;
}

const clip = (s: string) => (s.length > LINE_TEXT_MAX ? `${s.slice(0, LINE_TEXT_MAX - 1)}…` : s);

type TruthLine = {
  at: number;
  text: string;
  kind: 'cycle' | 'tool';
  tool?: string;
  failed: boolean;
};

/** `k` items spread evenly over `items` (in time order), first and last included. */
function spread<T>(items: T[], k: number): T[] {
  if (k <= 0) return [];
  if (items.length <= k) return items;
  if (k === 1) return [items[items.length - 1] as T];
  const out: T[] = [];
  for (let i = 0; i < k; i++) out.push(items[Math.round((i * (items.length - 1)) / (k - 1))] as T);
  return out;
}

/**
 * The tool calls and cycles of `bots` within `[fromMs, toMs]`, one line each,
 * in time order. Each record counts at its own instant: a tool call at `ts`, a
 * cycle at `endedAt` with its status; a cycle that started in the window and
 * had not ended by `toMs` is "started, not finished by the deadline", with no
 * result (nothing after the deadline leaks in). At most
 * `GROUND_TRUTH_MAX_LINES`: over it, failures (failed tool calls, error
 * cycles) are kept first, then cycles, then the other tool calls, each class
 * spread evenly over the window, and a last line counts what was not shown.
 * `rows` counts every record in the window, shown or not; `perBot` how many
 * each bot had. A reader that throws counts as nothing recorded. Pure over the readers.
 */
export function groundTruthLines(
  bots: GroundTruthBot[],
  fromMs: number,
  toMs: number,
  deps: GroundTruthDeps
): { lines: string[]; rows: number; perBot: Map<string, number> } {
  const inWindow = (iso: string | undefined) => {
    const ms = Date.parse(iso ?? '');
    return Number.isFinite(ms) && ms >= fromMs && ms <= toMs;
  };
  const all: TruthLine[] = [];
  const perBot = new Map<string, number>();
  for (const b of bots) {
    const name = b.name || b.id;
    let n = 0;
    let tools: GroundTruthTool[] = [];
    let cycles: GroundTruthCycle[] = [];
    try {
      tools = deps.tools?.(b.id, fromMs, toMs) ?? [];
    } catch {
      tools = [];
    }
    try {
      cycles = deps.cycles?.(b.id, fromMs, toMs) ?? [];
    } catch {
      cycles = [];
    }
    for (const c of cycles) {
      if (inWindow(c.endedAt)) {
        n++;
        const what = c.planSummary || c.focus || '';
        const goal = c.goalTitle ? ` [goal: ${c.goalTitle}]` : '';
        const status = c.status ?? 'unknown';
        all.push({
          at: Date.parse(c.endedAt as string),
          kind: 'cycle',
          failed: status === 'error',
          text: clip(`${c.endedAt} ${name} cycle ${status}${what ? `: ${what}` : ''}${goal}`),
        });
      } else if (inWindow(c.startedAt)) {
        // Still running at the deadline: what it did after is not evidence.
        n++;
        all.push({
          at: Date.parse(c.startedAt),
          kind: 'cycle',
          failed: false,
          text: `${c.startedAt} ${name} cycle started, not finished by the deadline`,
        });
      }
    }
    for (const e of tools) {
      if (!inWindow(e.ts)) continue;
      n++;
      const how = e.success ? 'ok' : `failed${e.failureKind ? ` (${e.failureKind})` : ''}`;
      all.push({
        at: Date.parse(e.ts),
        kind: 'tool',
        tool: e.tool,
        failed: !e.success,
        text: clip(`${e.ts} ${name} tool ${e.tool} ${how}${e.target ? ` → ${e.target}` : ''}`),
      });
    }
    perBot.set(b.id, n);
  }
  const rows = all.length;
  const byTime = [...all].sort((a, b) => a.at - b.at);
  if (rows <= GROUND_TRUTH_MAX_LINES) return { lines: byTime.map((l) => l.text), rows, perBot };
  // Over the cap: one line goes to the count of what is not shown.
  let room = GROUND_TRUTH_MAX_LINES - 1;
  const kept = new Set<TruthLine>();
  const classes = [
    byTime.filter((l) => l.failed),
    byTime.filter((l) => !l.failed && l.kind === 'cycle'),
    byTime.filter((l) => !l.failed && l.kind === 'tool'),
  ];
  for (const cls of classes) {
    for (const l of spread(cls, room)) kept.add(l);
    room = GROUND_TRUTH_MAX_LINES - 1 - kept.size;
  }
  const lines = byTime.filter((l) => kept.has(l)).map((l) => l.text);
  const rest = byTime.filter((l) => !kept.has(l));
  const cyclesLeft = rest.filter((l) => l.kind === 'cycle');
  const counts = new Map<string, { n: number; failed: number }>();
  for (const r of rest) {
    if (r.kind !== 'tool') continue;
    const c = counts.get(r.tool as string) ?? { n: 0, failed: 0 };
    c.n++;
    if (r.failed) c.failed++;
    counts.set(r.tool as string, c);
  }
  const parts = [
    ...(cyclesLeft.length
      ? [`${cyclesLeft.length} cycle${cyclesLeft.length === 1 ? '' : 's'}`]
      : []),
    ...[...counts.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([tool, c]) => `${tool} ×${c.n}${c.failed ? ` (${c.failed} failed)` : ''}`),
  ];
  lines.push(`… ${rest.length} more records in the window not shown: ${parts.join(', ')}`);
  return { lines, rows, perBot };
}

/**
 * Code-written watcher log lines (sense, notice, integrate) between two
 * instants, without the prediction rows themselves; the latest `MAX_EVENTS`.
 */
export function watcherLogLines(
  log: Pick<WatcherLog, 'dates' | 'read'>,
  fromMs: number,
  toMs: number
): string[] {
  const out: string[] = [];
  const fromDay = new Date(fromMs).toISOString().slice(0, 10);
  const toDay = new Date(toMs).toISOString().slice(0, 10);
  for (const date of log.dates()) {
    if (date < fromDay || date > toDay) continue;
    for (const row of log.read(date)) {
      const t = Date.parse(row.ts);
      if (t < fromMs || t > toMs || row.op.startsWith('prediction:')) continue;
      if (row.phase === 'sense' || row.phase === 'notice' || row.phase === 'integrate') {
        out.push(`${row.ts} ${row.text}`);
      }
    }
  }
  return out.sort().slice(-MAX_EVENTS);
}

/** Everything the judge needs besides the prediction. */
export interface JudgeDeps {
  client: Pick<InstrumentedClient, 'chat'>;
  /** Code-written lines of what happened between two instants (the watcher log). */
  events: (fromMs: number, toMs: number) => string[];
  /** The tool audit and cycle log; absent = the watcher rows only (as before). */
  groundTruth?: GroundTruthDeps;
  logger: { warn: (obj: object, msg: string) => void };
}

export type JudgeResult =
  | {
      kind: 'answer';
      resolution: PredictionResolution;
      /** The call that answered; absent when code settled it (`unknown`, nothing recorded). */
      call?: Extract<WatcherCallResult, { ok: true }>;
    }
  /** The call failed or its answer was unreadable: leave the prediction as it is. */
  | { kind: 'skip' }
  /** The budget or the breaker refused: stop the pass. */
  | { kind: 'stop'; reason: 'cap' | 'tokens' | 'breaker' };

const RESOLVE_SYSTEM = [
  'You check whether a prediction about a fleet of AI agents came true.',
  'You get the prediction, the tool calls and agent-loop cycles of the bots it names while it was open (the ground truth: the tool audit and the cycle log), and what the fleet watcher recorded.',
  'The tool calls and cycles are every one recorded for those bots in the window; a count line stands for the ones not shown.',
  'A prediction that states an absence ("makes no …", "does not …", "never …") happened when the records show the absence over the window: the bot was active and did not do it.',
  'A prediction that something happens happened when a record shows it, and did not happen when the bot was active and no record shows it.',
  'Answer "unknown" when the records cannot settle it: nothing about that bot in the window, or the prediction is about something these records do not cover.',
  'Answer with JSON only: {"outcome": "happened" | "did_not_happen" | "unknown", "evidence": "one short sentence citing the records"}.',
].join('\n');

/**
 * Judge one prediction over the window it was open (`createdAt` → `dueAt`).
 * With ground truth wired and nothing recorded about the bots it names — no
 * tool call, no cycle, no watcher row naming them — the answer is `unknown`
 * without a call. Never throws.
 */
export async function judgePrediction(p: Neuron, deps: JudgeDeps): Promise<JudgeResult> {
  const from = Date.parse(p.createdAt);
  const to = Date.parse(p.meta?.dueAt as string);
  const events = deps.events(from, to).slice(0, MAX_EVENTS);
  const sections = [`## Prediction\n${p.text}`, `## Open from ${p.createdAt} to ${p.meta?.dueAt}`];
  if (deps.groundTruth) {
    let all: GroundTruthBot[] = [];
    try {
      all = deps.groundTruth.bots();
    } catch {
      all = [];
    }
    const bots = predictionBots(p.text, all);
    const named = bots.length > 0 && bots.length < all.length;
    const truth = groundTruthLines(bots, from, to, deps.groundTruth);
    const names = bots.map((b) => b.name || b.id);
    // A watcher row naming a predicted bot is something recorded about it,
    // however many other bots it also names.
    const mentioned = named
      ? events.some((e) => namedBots(e, all).some((b) => bots.includes(b)))
      : events.length > 0;
    if (truth.rows === 0 && !mentioned) {
      return {
        kind: 'answer',
        resolution: {
          outcome: 'unknown',
          evidence: `No tool calls, cycles or watcher records about ${names.join(', ') || 'the fleet'} between ${p.createdAt} and ${p.meta?.dueAt}.`,
        },
      };
    }
    const silent = bots
      .filter((b) => (truth.perBot.get(b.id) ?? 0) === 0)
      .map((b) => `- ${b.name || b.id}: no tool calls and no cycles recorded in the window`);
    sections.push(
      `## Bots it names\n${named ? names.join(', ') : `(none named: all bots) ${names.join(', ')}`}`,
      `## Their tool calls and cycles in the window\n${
        [...truth.lines.map((l) => `- ${l}`), ...silent].join('\n') || '(nothing)'
      }`
    );
  }
  sections.push(
    `## What the watcher recorded\n${events.length ? events.map((l) => `- ${l}`).join('\n') : '(nothing)'}`
  );
  const res = await deps.client.chat(
    [
      { role: 'system', content: RESOLVE_SYSTEM },
      { role: 'user', content: sections.join('\n\n') },
    ],
    { temperature: 0 }
  );
  if (!res.ok)
    return res.reason === 'error' ? { kind: 'skip' } : { kind: 'stop', reason: res.reason };
  const resolution = parsePredictionResolution(res.text, deps.logger);
  if (!resolution) return { kind: 'skip' };
  return { kind: 'answer', resolution, call: res };
}

/**
 * The meta a resolution writes (`set`) and the keys it clears (`remove`): an
 * `unknown` carries no `happened` and no `brier`.
 */
export function resolutionMeta(
  p: Neuron,
  resolution: PredictionResolution,
  at: string,
  model?: string
): { set: Record<string, string>; remove: string[]; brier?: number } {
  const base: Record<string, string> = { resolvedAt: at, outcome: resolution.outcome };
  if (model) base.resolvedModel = model;
  if (resolution.evidence) base.evidence = resolution.evidence.slice(0, EVIDENCE_MAX);
  const remove = [
    ...(model ? [] : ['resolvedModel']),
    ...(resolution.evidence ? [] : ['evidence']),
  ];
  if (resolution.outcome === 'unknown') {
    return { set: base, remove: [...remove, 'happened', 'brier'] };
  }
  const happened = resolution.outcome === 'happened';
  const brier = brierScore(Number(p.meta?.probability), happened);
  return { set: { ...base, happened: String(happened), brier: String(brier) }, remove, brier };
}

export interface ResolveDeps extends JudgeDeps {
  graph: Pick<Graph, 'list' | 'patchMeta'>;
  log: Pick<WatcherLog, 'say'>;
  now: () => number;
  max?: number;
}

export async function resolvePredictions(
  deps: ResolveDeps
): Promise<{ resolved: number; stopped?: 'cap' | 'tokens' | 'breaker' }> {
  const due = duePredictions(deps.graph, deps.now()).slice(0, deps.max ?? RESOLVE_MAX_PER_PASS);
  let resolved = 0;
  for (const p of due) {
    const judged = await judgePrediction(p, deps);
    if (judged.kind === 'skip') continue;
    if (judged.kind === 'stop') return { resolved, stopped: judged.reason };
    const at = new Date(deps.now()).toISOString();
    const { set, remove, brier } = resolutionMeta(p, judged.resolution, at, judged.call?.model);
    deps.graph.patchMeta(p.id, set, remove);
    const call = judged.call;
    deps.log.say(
      'integrate',
      'prediction:resolved',
      brier === undefined || judged.resolution.happened === undefined
        ? narratePredictionUnknown({ text: p.text })
        : narratePredictionResolved({ text: p.text, happened: judged.resolution.happened, brier }),
      {
        neuronIds: [p.id],
        ...(call
          ? {
              model: call.model,
              tokens: call.tokens,
              ...(call.costUsd !== undefined ? { costUsd: call.costUsd } : {}),
              durationMs: call.durationMs,
            }
          : {}),
        source: 'watcher:notice',
      }
    );
    resolved++;
  }
  return { resolved, stopped: undefined };
}
