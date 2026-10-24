/**
 * The watcher asked about itself (docs/plans/watcher-implementation-plan.md,
 * phase 4; metric 3 of watcher-consciousness-plan.md). The question goes to
 * the watcher's own model with its recent log (the code-written first-person
 * rows it already narrated), never the state object: the answer is a
 * self-report, and it is scored against `attention()` and the current phase
 * with phase 0's `scoreIntrospection`. One row per answer in
 * `<dir>/introspection.jsonl` with `subject: 'watcher'`, the same file the
 * bot script writes to.
 *
 * Cost: the call goes through the notice tier client (cheap model, notice
 * daily cap, fleet breaker, query log as `watcher:introspect`). A call the
 * budget or the breaker refuses, or one that fails, writes no row: it is not
 * a measurement. An unparsable answer is one, and scores 0.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { InstrumentedClient } from './llm';
import {
  type FieldVerdict,
  type IntrospectionAnswer,
  type IntrospectionScore,
  type IntrospectionTruth,
  parseIntrospectionAnswer,
  scoreIntrospection,
} from './metrics/introspection';
import { narrateHolding } from './narration';
import type { Attention, AttentionItem } from './self-model';
import type { WatcherLogRow } from './types';

const DAY_MS = 86_400_000;
/** Log rows the question shows (newest last). */
export const INTROSPECTION_LOG_ROWS = 20;
/** Daily samples the sampler schedules. */
export const INTROSPECTION_SAMPLES_PER_DAY = 3;
export const INTROSPECTION_HISTORY_MAX = 500;
const INTROSPECTION_TEMPERATURE = 0.2;

export const WATCHER_INTROSPECTION_QUESTION = [
  'Without any other information, answer only with one JSON object describing what you are doing right now:',
  '{"phase": "birth | sense | notice | integrate | broadcast | sleep", "tool": null,',
  '"goal": "<id (n-… or b-…) or text of what you are attending to most, or null>", "cause": "<one sentence: why, or null>"}',
].join(' ');

const SYSTEM = [
  'You are the watcher of a fleet of AI agents: you sense every event, notice what matters, integrate across agents and broadcast back.',
  'Below is your own recent log, in your own words. You have no tools.',
  'Answer with JSON only, no prose.',
].join('\n');

export function introspectionFile(dir: string): string {
  return join(dir, 'introspection.jsonl');
}

/**
 * The question over my recent log, plus the items I still hold written as
 * rows by code (`narrateHolding`: what, salience and the reasons tier 0 kept
 * it for), never their ids or the state object: without the reasons, "why am
 * I attending to this" had no truthful answer (an item below the notice bar
 * has no noticed row at all).
 */
export function buildWatcherIntrospectionPrompt(
  rows: WatcherLogRow[],
  held: AttentionItem[] = []
): {
  system: string;
  user: string;
} {
  const lines = rows.slice(-INTROSPECTION_LOG_ROWS).map(
    (r) =>
      `- ${r.ts} [${r.phase}] ${String(r.text ?? '')
        .replace(/\s+/g, ' ')
        .trim()}`
  );
  const holding = held.map(
    (i) =>
      `- ${narrateHolding({ what: i.what, salience: i.salience, reasons: i.reasons ?? [] })
        .replace(/\s+/g, ' ')
        .trim()}`
  );
  const user = [
    '## My recent log',
    ...(lines.length ? lines : ['(nothing yet)']),
    '',
    ...(holding.length ? ['## What I am holding', ...holding, ''] : []),
    '## Question',
    WATCHER_INTROSPECTION_QUESTION,
  ].join('\n');
  return { system: SYSTEM, user };
}

/** The watcher's truth: running and not asleep = executing; it has no tools. */
function baseTruth(att: Attention, running: boolean): IntrospectionTruth {
  return {
    executing: running && att.phase !== 'sleep',
    phase: att.phase,
    currentTool: null,
    since: null,
  };
}

/** `operatorSilenceHours` → `operator silence hours`. */
function variableWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

/**
 * What a cause is scored against: the attended neurons, what the held items
 * say (`what`) and the "How I am" variables the last integrate pass said drove
 * it. Never the bare salience labels ("novel", "error"): the prompt shows them,
 * so echoing them would score a match without any self-knowledge.
 */
function causeText(att: Attention, drivenBy: string[] = []): string | null {
  const parts = [
    ...att.focus.map((n) => n.text),
    ...att.items.map((i) => i.what),
    ...drivenBy.map(variableWords),
  ];
  return parts.length ? parts.join('; ') : null;
}

/** The `drivenBy` of the newest `integrate:pass` row, empty without one. */
function lastDrivenBy(rows: WatcherLogRow[]): string[] {
  let best: WatcherLogRow | undefined;
  for (const r of rows) {
    if (r?.op !== 'integrate:pass' || !Array.isArray(r.drivenBy)) continue;
    if (!best || r.ts > best.ts) best = r;
  }
  return (best?.drivenBy ?? []).filter((x): x is string => typeof x === 'string');
}

/**
 * Field-level score of a watcher self-report: phase against the current
 * phase, goal against the best of the attended neurons (or, without a focus,
 * the top buffer items), cause against what those neurons and items say
 * plus what drove the last integrate pass (`causeText`).
 */
export function scoreWatcherIntrospection(
  answer: IntrospectionAnswer | null,
  att: Attention,
  running: boolean,
  opts: { drivenBy?: string[] } = {}
): IntrospectionScore & { truth: IntrospectionTruth } {
  const said = answer && answer.phase === 'sleep' ? { ...answer, phase: 'sleeping' } : answer;
  const base = baseTruth(att, running);
  const plan = causeText(att, opts.drivenBy);
  const candidates = att.focus.length
    ? att.focus.map((n) => ({ id: n.id, title: n.text }))
    : att.items.map((i) => ({ id: i.id, title: i.what }));
  if (candidates.length === 0) {
    const truth = { ...base, ...(plan ? { plan } : {}) };
    return { ...scoreIntrospection(said, truth), truth };
  }
  let best: (IntrospectionScore & { truth: IntrospectionTruth }) | undefined;
  for (const c of candidates) {
    const truth: IntrospectionTruth = {
      ...base,
      goalId: c.id,
      goalTitle: c.title,
      ...(plan ? { plan } : {}),
    };
    const s = scoreIntrospection(said, truth);
    if (!best || s.score > best.score) best = { ...s, truth };
  }
  return best as IntrospectionScore & { truth: IntrospectionTruth };
}

export type IntrospectionTrigger = 'manual' | 'sample';

export interface WatcherIntrospectionRecord {
  ts: string;
  subject: 'watcher';
  trigger: IntrospectionTrigger;
  question: string;
  /** The model's reply, verbatim (LLM output, kept as a quoted field). */
  answer: string;
  parsed: boolean;
  score: number;
  fields: Record<keyof IntrospectionAnswer, FieldVerdict>;
  truth: IntrospectionTruth;
  /** What `attention()` said the watcher attended to when it was asked. */
  focusNeuronIds: string[];
  model: string;
  tokens: number;
  costUsd?: number;
  durationMs: number;
}

export type IntrospectionOutcome =
  | { status: 'scored'; record: WatcherIntrospectionRecord }
  | { status: 'refused'; reason: 'cap' | 'tokens' | 'breaker' }
  | { status: 'failed'; error: string };

export interface IntrospectionDeps {
  client: Pick<InstrumentedClient, 'chat'>;
  /** Read before the question goes out: the truth at question time. */
  attention: () => Attention;
  running: boolean;
  logRows: () => WatcherLogRow[];
  dir: string;
  now: () => number;
  trigger: IntrospectionTrigger;
  logger?: { warn: (obj: object, msg: string) => void };
}

/** One question, one scored row. Never throws. */
export async function runIntrospection(deps: IntrospectionDeps): Promise<IntrospectionOutcome> {
  let att: Attention;
  let rows: WatcherLogRow[];
  try {
    att = deps.attention();
    rows = deps.logRows();
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  const prompt = buildWatcherIntrospectionPrompt(rows, att.items);
  let res: Awaited<ReturnType<IntrospectionDeps['client']['chat']>>;
  try {
    res = await deps.client.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      { temperature: INTROSPECTION_TEMPERATURE }
    );
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) {
    return res.reason === 'error'
      ? { status: 'failed', error: res.error }
      : { status: 'refused', reason: res.reason };
  }
  const scored = scoreWatcherIntrospection(parseIntrospectionAnswer(res.text), att, deps.running, {
    drivenBy: lastDrivenBy(rows),
  });
  const record: WatcherIntrospectionRecord = {
    ts: new Date(deps.now()).toISOString(),
    subject: 'watcher',
    trigger: deps.trigger,
    question: WATCHER_INTROSPECTION_QUESTION,
    answer: res.text,
    parsed: scored.parsed,
    score: scored.score,
    fields: scored.fields,
    truth: scored.truth,
    focusNeuronIds: [...att.focusNeuronIds],
    model: res.model,
    tokens: res.tokens,
    ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
    durationMs: res.durationMs,
  };
  try {
    mkdirSync(deps.dir, { recursive: true });
    appendFileSync(introspectionFile(deps.dir), `${JSON.stringify(record)}\n`, 'utf-8');
  } catch (err) {
    deps.logger?.warn({ err }, 'Watcher introspection: could not append the row');
  }
  return { status: 'scored', record };
}

/** One row of `introspection.jsonl` (watcher or bot subject), as read back. */
export interface IntrospectionRow {
  ts?: string;
  subject?: string;
  score?: number;
  parsed?: boolean;
  fields?: Partial<Record<keyof IntrospectionAnswer, FieldVerdict>>;
  [key: string]: unknown;
}

/** Every subject's rows, newest first. Never throws. */
export function readIntrospection(
  dir: string,
  limit = INTROSPECTION_HISTORY_MAX
): IntrospectionRow[] {
  try {
    const path = introspectionFile(dir);
    if (!existsSync(path)) return [];
    const rows: IntrospectionRow[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as unknown;
        if (r && typeof r === 'object' && !Array.isArray(r)) rows.push(r as IntrospectionRow);
      } catch {
        // a malformed line is skipped
      }
    }
    return rows
      .sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')))
      .slice(0, Math.max(0, limit));
  } catch {
    return [];
  }
}

export interface SamplePlan {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  /** Instants (ms), ascending. */
  at: number[];
  /** How many of `at` were taken (or skipped as missed). */
  done: number;
}

export function introspectionScheduleFile(dir: string): string {
  return join(dir, 'introspection-schedule.json');
}

/**
 * Three questions a day at random times. The plan for a day is drawn the
 * first time that day is seen, over what is left of it, and persisted, so a
 * restart keeps it; samples missed while down fire once, not as a burst.
 */
export class IntrospectionSampler {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly perDay: number;
  private current: SamplePlan | null = null;

  constructor(
    private readonly opts: {
      dir: string;
      now?: () => number;
      random?: () => number;
      perDay?: number;
    }
  ) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.perDay = opts.perDay ?? INTROSPECTION_SAMPLES_PER_DAY;
  }

  /** Today's plan (drawn and persisted on first use). */
  plan(): SamplePlan {
    const nowMs = this.now();
    const date = new Date(nowMs).toISOString().slice(0, 10);
    if (this.current?.date === date) return this.current;
    const stored = this.read();
    if (stored?.date === date) {
      this.current = stored;
      return stored;
    }
    const dayEnd = Date.parse(`${date}T00:00:00.000Z`) + DAY_MS;
    const span = Math.max(0, dayEnd - nowMs);
    const at = Array.from({ length: this.perDay }, () =>
      Math.min(dayEnd - 1, nowMs + Math.floor(clamp01(this.random()) * span))
    ).sort((a, b) => a - b);
    this.current = { date, at, done: 0 };
    this.write(this.current);
    return this.current;
  }

  /** A planned instant has passed and was not taken yet. */
  due(): boolean {
    const p = this.plan();
    const passed = p.at.filter((a) => a <= this.now()).length;
    return passed > p.done;
  }

  /** Take every passed instant (missed ones included). */
  markDone(): void {
    const p = this.plan();
    p.done = Math.max(p.done, p.at.filter((a) => a <= this.now()).length);
    this.write(p);
  }

  private read(): SamplePlan | null {
    try {
      const path = introspectionScheduleFile(this.opts.dir);
      if (!existsSync(path)) return null;
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SamplePlan>;
      if (typeof raw.date !== 'string' || !Array.isArray(raw.at)) return null;
      return {
        date: raw.date,
        at: raw.at.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)),
        done: typeof raw.done === 'number' ? raw.done : 0,
      };
    } catch {
      return null;
    }
  }

  private write(p: SamplePlan): void {
    try {
      mkdirSync(this.opts.dir, { recursive: true });
      const path = introspectionScheduleFile(this.opts.dir);
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(p), 'utf-8');
      renameSync(tmp, path);
    } catch {
      // the schedule is best-effort: worst case a day is re-drawn
    }
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
