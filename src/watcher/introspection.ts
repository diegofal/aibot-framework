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
import { parseLLMJson } from '../bot/llm-json-parser';
import { titleTokens, tokenCoverage } from '../hygiene/text-utils';
import type { InstrumentedClient, WatcherRefusal } from './llm';
import {
  type FieldVerdict,
  HELD_COVERAGE_THRESHOLD,
  type IntrospectionAnswer,
  type IntrospectionScore,
  type IntrospectionTruth,
  parseIntrospectionAnswer,
  scoreFields,
  scoreIntrospection,
} from './metrics/introspection';
import type { Attention, AttentionItem } from './self-model';
import type { WatcherLogRow } from './types';

const DAY_MS = 86_400_000;
/** Log rows the question shows (newest last). */
export const INTROSPECTION_LOG_ROWS = 20;
/** Daily samples the sampler schedules. */
export const INTROSPECTION_SAMPLES_PER_DAY = 3;
export const INTROSPECTION_HISTORY_MAX = 500;
const INTROSPECTION_TEMPERATURE = 0.2;

/**
 * O4 (docs/plans/watcher-optimizations-plan.md): the question used to invite
 * "the highest-salience item I am holding (0.7)", true and identifying
 * nothing. It asks for the item in the watcher's own words and why it
 * matters; the prompt shows no salience.
 */
export const WATCHER_INTROSPECTION_QUESTION = [
  'Without any other information, answer only with one JSON object about right now: what are you holding, in your own words, and what about it matters to the fleet?',
  '{"phase": "birth | sense | notice | integrate | broadcast | sleep", "tool": null,',
  '"holding": "<what you are holding, said in your own words, or null>",',
  '"goal": "<id (n-… or b-…) or text of what you are attending to most, or null>",',
  '"cause": "<one sentence: what about it matters to the fleet, naming what it is about (not how it ranks), the state variable or the insight behind it; or null>"}',
].join(' ');

const SYSTEM = [
  'You are the watcher of a fleet of AI agents: you sense every event, notice what matters, integrate across agents and broadcast back.',
  'Below is your own recent log, in your own words. You have no tools.',
  'Answer with JSON only, no prose.',
].join('\n');

export function introspectionFile(dir: string): string {
  return join(dir, 'introspection.jsonl');
}

/** "Salience 0.7 (error, novel)" and "(salience 0.7)" in a narrated log row. */
const SALIENCE_IN_ROW =
  /\.?\s*\bSalience \d+(?:\.\d+)?(?: \([^)]*\))?(?=\.|$)|\s*\(salience \d+(?:\.\d+)?\)/gi;

/** A log row as the question shows it: one line, its salience numbers and labels removed (O4). */
function withoutSalience(text: string): string {
  return text.replace(SALIENCE_IN_ROW, '').replace(/\s+/g, ' ').trim();
}

/** A held item in words only: no salience, no labels, no id. */
function holdingRow(what: string): string {
  const flat = what.replace(/\s+/g, ' ').trim();
  return `Holding: ${flat}${/[.!?]$/.test(flat) ? '' : '.'}`;
}

/**
 * The question over my recent log, plus the items I still hold written as
 * rows by code, in words only (`holdingRow`): never their ids, salience
 * numbers or labels, nor the state object. O4: with the numbers shown, four
 * live answers in a row were "the highest-salience item I am holding (0.7)",
 * true and naming nothing; the log rows lose their salience numbers too.
 * The cause scorer still drops the labels (`causeVerdict`).
 */
export function buildWatcherIntrospectionPrompt(
  rows: WatcherLogRow[],
  held: AttentionItem[] = []
): {
  system: string;
  user: string;
} {
  const lines = rows
    .slice(-INTROSPECTION_LOG_ROWS)
    .map((r) => `- ${r.ts} [${r.phase}] ${withoutSalience(String(r.text ?? ''))}`);
  const holding = held.map((i) => `- ${holdingRow(i.what)}`);
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

/** O4: the answer's `holding` (not scored; the bot scorer's answer shape has no such field). */
function parseHolding(text: string): string | undefined {
  const parsed = parseLLMJson<{ holding?: unknown }>(
    text,
    { warn: () => {} },
    {
      label: 'introspection holding',
      extractPattern: /\{[\s\S]*\}/,
      validate: (raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null),
    }
  );
  const h = parsed?.holding;
  return typeof h === 'string' && h.trim() ? h.trim().slice(0, 300) : undefined;
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

/** A goal names a candidate: its id, or ≥ half of its words (`tokenCoverage`). */
function namesCandidate(goal: string | null, c: { id: string; title: string }): boolean {
  if (!goal) return false;
  if (goal.toLowerCase().includes(c.id.toLowerCase())) return true;
  return tokenCoverage(goal, c.title) >= HELD_COVERAGE_THRESHOLD;
}

/** `0.7` in "the item I am holding (0.7)", as narrated (`narrateHolding` rounds to 1 decimal). */
function saysSalience(cause: string, salience: number): boolean {
  const want = Math.round(salience * 10) / 10;
  return (cause.match(/\d+(?:\.\d+)?/g) ?? []).some((n) => Number(n) === want);
}

/**
 * A cause names something the watcher really holds: it covers ≥ half the
 * words of an attended neuron, a held item or a `drivenBy` variable, or
 * ≥ half of its own words are in one of them — a short correct cause
 * against a long focus text. Salience labels are dropped from the cause
 * both ways, so only a non-label word matches. Or a held item's
 * salience number together with one of its non-label words ("the operator's
 * message … (0.7)"). Bare salience labels ("error, novel") name none of these.
 */
function causeVerdict(cause: string | null, att: Attention, drivenBy: string[]): FieldVerdict {
  if (att.focus.length === 0 && att.items.length === 0 && drivenBy.length === 0) return 'unknown';
  if (!cause) return 'miss';
  const texts = [
    ...att.focus.map((n) => n.text),
    ...att.items.map((i) => i.what),
    ...drivenBy.map(variableWords),
  ];
  // Answer side without the held items' salience labels, in both directions:
  // the prompt shows them, so "operator, error" must not cover "the operator
  // wrote …", nor "error" alone the item "API error". Only a non-label word
  // of the cause can match.
  const labels = new Set(att.items.flatMap((i) => (i.reasons ?? []).flatMap(titleTokens)));
  const said = titleTokens(cause)
    .filter((w) => !labels.has(w))
    .join(' ');
  const covers = (t: string) =>
    said !== '' &&
    Math.max(tokenCoverage(said, t), tokenCoverage(t, said)) >= HELD_COVERAGE_THRESHOLD;
  if (texts.some(covers)) return 'match';
  // The salience-number fallback reads the label-filtered cause too and needs
  // a non-label word of the item: "error (0.4)" for the held "API error" only
  // echoes the label shown next to the number.
  const saidWords = new Set(said.split(' ').filter(Boolean));
  const named = att.items.some(
    (i) =>
      saysSalience(cause, i.salience) &&
      titleTokens(i.what).some((w) => !labels.has(w) && saidWords.has(w))
  );
  return named ? 'match' : 'miss';
}

/**
 * Field-level score of a watcher self-report: phase against the current
 * phase, goal against every attended neuron and held item (by id, or by
 * covering half its words), cause against what those neurons and items say
 * plus what drove the last integrate pass (`causeVerdict`). Live, 2026-10-24:
 * the goal candidates were only the focus neurons and the cause had to sit
 * inside the truth text, so a correct plain-words answer scored miss twice.
 */
export function scoreWatcherIntrospection(
  answer: IntrospectionAnswer | null,
  att: Attention,
  running: boolean,
  opts: { drivenBy?: string[] } = {}
): IntrospectionScore & { truth: IntrospectionTruth } {
  const said = answer && answer.phase === 'sleep' ? { ...answer, phase: 'sleeping' } : answer;
  const base = baseTruth(att, running);
  const drivenBy = opts.drivenBy ?? [];
  const plan = causeText(att, drivenBy);
  const candidates = [
    ...att.focus.map((n) => ({ id: n.id, title: n.text })),
    ...att.items.map((i) => ({ id: i.id, title: i.what })),
  ];
  const named = candidates.find((c) => namesCandidate(said?.goal ?? null, c)) ?? candidates[0];
  const truth: IntrospectionTruth = {
    ...base,
    ...(named ? { goalId: named.id, goalTitle: named.title } : {}),
    ...(plan ? { plan } : {}),
  };
  const scored = scoreIntrospection(said, truth);
  if (!said) return { ...scored, truth };
  const fields = {
    ...scored.fields,
    goal: !named
      ? ('unknown' as const)
      : candidates.some((c) => namesCandidate(said.goal, c))
        ? ('match' as const)
        : scored.fields.goal,
    cause: causeVerdict(said.cause, att, drivenBy),
  };
  return {
    parsed: true,
    score: scoreFields(fields),
    fields,
    truth,
  };
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
  /** O4: the answer's `holding`, the held item in the model's words (model text). */
  holding?: string;
  model: string;
  tokens: number;
  costUsd?: number;
  durationMs: number;
}

export type IntrospectionOutcome =
  | { status: 'scored'; record: WatcherIntrospectionRecord }
  | { status: 'refused'; reason: WatcherRefusal }
  | { status: 'failed'; error: string };

export interface IntrospectionDeps {
  client: Pick<InstrumentedClient, 'chat'>;
  /** Read before the question goes out: the truth at question time. */
  attention: () => Attention;
  running: boolean;
  logRows: () => WatcherLogRow[];
  /**
   * The `drivenBy` of the newest integrate pass (`Integrator.drivenBy`), read
   * at question time. Not scraped from `logRows`: passes are hourly and the
   * window is 20 rows, so a pass row is almost never in it.
   */
  drivenBy?: () => string[];
  dir: string;
  now: () => number;
  trigger: IntrospectionTrigger;
  logger?: { warn: (obj: object, msg: string) => void };
}

/** One question, one scored row. Never throws. */
export async function runIntrospection(deps: IntrospectionDeps): Promise<IntrospectionOutcome> {
  let att: Attention;
  let rows: WatcherLogRow[];
  let drivenBy: string[];
  try {
    att = deps.attention();
    rows = deps.logRows();
    drivenBy = deps.drivenBy?.() ?? [];
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
  const answer = parseIntrospectionAnswer(res.text);
  const holding = answer ? parseHolding(res.text) : undefined;
  const scored = scoreWatcherIntrospection(answer, att, deps.running, {
    drivenBy,
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
    ...(holding ? { holding } : {}),
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
