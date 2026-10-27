/**
 * The watcher's self-improvement loop (`docs/plans/self-improve-plan.md`,
 * "Watcher loop"). Code only, no LLM:
 *
 * 1. Fleet view: every bot's charged tool failures of the last 7 days, by
 *    failure class (`classifyFailure`); a class is present in a bot at ≥ 2.
 * 2. Tool problem: a named class (never `other:*`) present in ≥
 *    `toolProblemBots` bots and not dismissed by the operator. One log row
 *    when it is first found, and a `SuppressedClass` in the LESSONS.json of
 *    every bot whose loop is on, so no bot learns to work around a tool bug.
 *    A class no longer found (or dismissed) has its suppression removed.
 * 3. Propagation: a `proven` lesson of a bot's own is lent (`borrowed`) to
 *    every other loop-on bot where the class is present, not suppressed, and
 *    no lesson of the class is in the prompt or was created in the last 7 days.
 *    Bots whose loop is off get nothing.
 *
 * `runFleetSelfImprove` is pure orchestration over its deps and never throws;
 * `SelfImproveRunner` is the watcher's timer, status and dismiss around it.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyFailure } from '../bot/self-improve/classes';
import { baselineFor } from '../bot/self-improve/measure';
import {
  EVIDENCE_MAX,
  type FailureClass,
  LESSONS_FILE,
  type Lesson,
  type LessonsFile,
  type SuppressedClass,
  auditRowRef,
  isLessonInPrompt,
} from '../bot/self-improve/types';
import { appendSoulEvent, soulEventHead } from '../bot/soul-events';
import type { ToolAuditEntry } from '../bot/tool-audit-log';
import { writeJsonFileAtomic } from '../config';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The fleet view's window: failures, and the "created recently" rule of propagation. */
export const FLEET_WINDOW_DAYS = 7;
/** Failures of a class in a bot's window for the class to be present in it. */
export const PRESENT_MIN_FAILURES = 2;
/** How often the watcher's timer checks whether a run is due. */
export const SELF_IMPROVE_CHECK_MS = HOUR_MS;
/** The watcher config's defaults (`WatcherConfigSchema.selfImprove`). */
export const WATCHER_SELF_IMPROVE_DEFAULTS = Object.freeze({
  enabled: true,
  toolProblemBots: 3,
  everyHours: 24,
});

// ── contract ────────────────────────────────────────────────────────────

export interface FleetSelfImproveBot {
  id: string;
  name: string;
  soulDir: string;
  /** The bot's own loop (`resolveSelfImprove(config, bot).enabled`). */
  loopOn: boolean;
}

/** The part of `LessonStore` the run uses. */
export interface LessonStoreLike {
  read(): LessonsFile;
  write(file: LessonsFile): void;
}

export interface SelfImproveLogRow {
  op: string;
  text: string;
}

export interface FleetSelfImproveDeps {
  /** Enabled, non-tenant bots (the caller filters). */
  bots: FleetSelfImproveBot[];
  readAudit(botId: string, sinceMs: number, nowMs: number): ToolAuditEntry[];
  cfg: { toolProblemBots: number };
  nowMs: number;
  storeFor(soulDir: string): LessonStoreLike;
  /** One row in the watcher's log. */
  log(row: SelfImproveLogRow): void;
  isDismissed(classKey: string): boolean;
  /** Tool problems of the previous run: a row is written only for a class not among them. */
  previousToolProblems?: string[];
  /** New lesson ids (tests). Default `l-` + 8 random hex. */
  newId?: () => string;
}

export interface ToolProblem {
  classKey: string;
  /** Bots the class is present in, most failures first. */
  bots: Array<{ id: string; failures: number }>;
}

export interface BorrowRecord {
  toBot: string;
  fromBot: string;
  classKey: string;
  lessonId: string;
}

export interface BotLessonCounts {
  active: number;
  proven: number;
  retired: number;
  unproven: number;
  /** Borrowed lessons created in the last 7 days. */
  borrowed: number;
}

export interface FleetSelfImproveResult {
  ranAt: string;
  toolProblems: ToolProblem[];
  borrowed: BorrowRecord[];
  perBot: Record<string, BotLessonCounts>;
}

// ── the run ─────────────────────────────────────────────────────────────

interface BotView {
  bot: FleetSelfImproveBot;
  entries: ToolAuditEntry[];
  /** Failures by class key, newest first. */
  failures: Map<string, { cls: FailureClass; entries: ToolAuditEntry[] }>;
  store?: LessonStoreLike;
  file?: LessonsFile;
}

function errText(err: unknown): string {
  return soulEventHead(err instanceof Error ? err.message : String(err), 120);
}

function newLessonId(): string {
  return `l-${randomBytes(4).toString('hex')}`;
}

const isNamed = (cls: FailureClass) => !cls.errorClass.startsWith('other:');

function suppressionReason(p: ToolProblem): string {
  return `Seen in ${p.bots.length} bots in the last ${FLEET_WINDOW_DAYS} days: a tool problem, not a habit of this bot. No lesson until the operator dismisses it.`;
}

function sameSuppressed(a: SuppressedClass[], b: SuppressedClass[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The bot's suppressions after this run: one per tool problem, nothing else. */
function syncSuppressed(
  current: SuppressedClass[],
  problems: ToolProblem[],
  at: string
): SuppressedClass[] {
  const next: SuppressedClass[] = [];
  for (const p of problems) {
    const had = current.find((s) => s.classKey === p.classKey);
    next.push({
      classKey: p.classKey,
      reason: suppressionReason(p),
      since: had?.since ?? at,
      bots: p.bots.map((b) => b.id).sort(),
    });
  }
  return next;
}

function countsOf(file: LessonsFile | undefined, nowMs: number): BotLessonCounts {
  const out: BotLessonCounts = { active: 0, proven: 0, retired: 0, unproven: 0, borrowed: 0 };
  for (const l of file?.lessons ?? []) {
    if (l.status in out) out[l.status as keyof BotLessonCounts]++;
    const created = Date.parse(l.createdAt);
    if (
      l.source === 'borrowed' &&
      Number.isFinite(created) &&
      nowMs - created < FLEET_WINDOW_DAYS * DAY_MS
    ) {
      out.borrowed++;
    }
  }
  return out;
}

/** A lesson of `classKey` in the prompt, or created inside the window: no borrow. */
function hasRecentOrLive(file: LessonsFile, classKey: string, nowMs: number): boolean {
  return file.lessons.some((l) => {
    if (l.classKey !== classKey) return false;
    if (isLessonInPrompt(l)) return true;
    const created = Date.parse(l.createdAt);
    return Number.isFinite(created) && nowMs - created < FLEET_WINDOW_DAYS * DAY_MS;
  });
}

/**
 * One run of the fleet loop. Never throws: a bot whose audit or lessons
 * cannot be read, or whose file cannot be written, gets a
 * `self-improve:error` row and the rest of the fleet goes on.
 */
export async function runFleetSelfImprove(
  deps: FleetSelfImproveDeps
): Promise<FleetSelfImproveResult> {
  const { nowMs } = deps;
  const at = new Date(nowMs).toISOString();
  const sinceMs = nowMs - FLEET_WINDOW_DAYS * DAY_MS;
  const say = (op: string, text: string) => {
    try {
      deps.log({ op, text });
    } catch {
      // a log that throws never stops the run
    }
  };
  const failed = (b: FleetSelfImproveBot, what: string, err: unknown) =>
    say('self-improve:error', `I could not ${what} for ${b.name} (${b.id}): ${errText(err)}.`);

  // 1. Fleet view.
  const views: BotView[] = [];
  for (const bot of deps.bots) {
    const view: BotView = { bot, entries: [], failures: new Map() };
    try {
      view.entries = deps.readAudit(bot.id, sinceMs, nowMs) ?? [];
    } catch (err) {
      failed(bot, 'read the tool audit', err);
    }
    for (const e of view.entries) {
      const cls = classifyFailure(e);
      if (!cls) continue;
      const row = view.failures.get(cls.key) ?? { cls, entries: [] };
      row.entries.push(e);
      view.failures.set(cls.key, row);
    }
    for (const row of view.failures.values()) {
      row.entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }
    try {
      view.store = deps.storeFor(bot.soulDir);
      view.file = view.store.read();
    } catch (err) {
      view.store = undefined;
      view.file = undefined;
      failed(bot, 'read the lessons', err);
    }
    views.push(view);
  }
  const present = (v: BotView, key: string) =>
    (v.failures.get(key)?.entries.length ?? 0) >= PRESENT_MIN_FAILURES;

  // 2. Tool problems.
  const byClass = new Map<string, Array<{ id: string; failures: number }>>();
  for (const v of views) {
    for (const [key, row] of v.failures) {
      if (!isNamed(row.cls) || !present(v, key)) continue;
      const list = byClass.get(key) ?? [];
      list.push({ id: v.bot.id, failures: row.entries.length });
      byClass.set(key, list);
    }
  }
  const toolProblems: ToolProblem[] = [];
  for (const [classKey, bots] of byClass) {
    if (bots.length < deps.cfg.toolProblemBots) continue;
    let dismissed = false;
    try {
      dismissed = deps.isDismissed(classKey);
    } catch {
      dismissed = false;
    }
    if (dismissed) continue;
    bots.sort((a, b) => b.failures - a.failures || a.id.localeCompare(b.id));
    toolProblems.push({ classKey, bots });
  }
  toolProblems.sort((a, b) => a.classKey.localeCompare(b.classKey));
  const previous = new Set(deps.previousToolProblems ?? []);
  const nameOf = (id: string) => views.find((v) => v.bot.id === id)?.bot.name ?? id;
  for (const p of toolProblems) {
    if (previous.has(p.classKey)) continue;
    const counts = p.bots.map((b) => `${nameOf(b.id)} ${b.failures}`).join(', ');
    say(
      'self-improve:tool-problem',
      `${p.classKey} shows up in ${p.bots.length} bots this week (${counts}). That is a tool problem, not a habit: no bot gets a lesson for it until you dismiss it.`
    );
  }
  const problemKeys = new Set(toolProblems.map((p) => p.classKey));

  // 3. Propagation: what each loop-on bot gets this run.
  const lenders: Array<{ from: BotView; lesson: Lesson }> = [];
  for (const v of views) {
    for (const l of v.file?.lessons ?? []) {
      if (l.source === 'own' && l.status === 'proven') lenders.push({ from: v, lesson: l });
    }
  }
  // Newest proven first: with two lenders for one class, the most recent proof wins.
  lenders.sort((a, b) => b.lesson.updatedAt.localeCompare(a.lesson.updatedAt));

  const borrowed: BorrowRecord[] = [];
  for (const v of views) {
    if (!v.bot.loopOn || !v.store || !v.file) continue;
    const file = v.file;
    const suppressed = syncSuppressed(file.suppressed, toolProblems, at);
    const nextLessons = [...file.lessons];
    const mine: Array<{ lesson: Lesson; from: BotView }> = [];
    const taken = new Set<string>();
    for (const { from, lesson } of lenders) {
      if (from.bot.id === v.bot.id) continue;
      const key = lesson.classKey;
      if (taken.has(key) || problemKeys.has(key) || !present(v, key)) continue;
      if (suppressed.some((s) => s.classKey === key)) continue;
      if (hasRecentOrLive({ ...file, lessons: nextLessons }, key, nowMs)) continue;
      const row = v.failures.get(key);
      if (!row) continue;
      const ids = new Set(nextLessons.map((l) => l.id));
      let id = deps.newId?.() ?? newLessonId();
      while (ids.has(id)) id = newLessonId();
      const lent: Lesson = {
        id,
        classKey: key,
        tool: lesson.tool,
        errorClass: lesson.errorClass,
        text: lesson.text,
        textSource: lesson.textSource,
        evidence: row.entries.slice(0, EVIDENCE_MAX).map(auditRowRef),
        source: 'borrowed',
        borrowedFrom: { botId: from.bot.id, lessonId: lesson.id },
        status: 'active',
        createdAt: at,
        updatedAt: at,
        baseline: baselineFor(v.entries, row.cls, nowMs),
      };
      nextLessons.push(lent);
      mine.push({ lesson: lent, from });
      taken.add(key);
    }
    if (mine.length === 0 && sameSuppressed(file.suppressed, suppressed)) continue;
    const next: LessonsFile = { ...file, lessons: nextLessons, suppressed };
    try {
      v.store.write(next);
      v.file = next;
    } catch (err) {
      failed(v.bot, `write ${LESSONS_FILE}`, err);
      continue;
    }
    for (const { lesson, from } of mine) {
      borrowed.push({
        toBot: v.bot.id,
        fromBot: from.bot.id,
        classKey: lesson.classKey,
        lessonId: lesson.id,
      });
      appendSoulEvent(v.bot.soulDir, {
        file: LESSONS_FILE,
        op: 'lesson',
        actor: 'system',
        summary: `Borrowed a lesson from ${from.bot.name}: ${soulEventHead(lesson.text, 120)}`,
        detail: [lesson.classKey],
        now: () => new Date(nowMs),
      });
      say(
        'self-improve:borrowed',
        `${from.bot.name}'s lesson on ${lesson.classKey} worked, and ${v.bot.name} keeps making the same mistake, so I lent it.`
      );
    }
  }

  const perBot: Record<string, BotLessonCounts> = {};
  for (const v of views) perBot[v.bot.id] = countsOf(v.file, nowMs);
  return { ranAt: at, toolProblems, borrowed, perBot };
}

/** Remove one class's suppression from a loop-on bot's file. True when it wrote. Throws on I/O. */
export function removeSuppression(store: LessonStoreLike, classKey: string): boolean {
  const file = store.read();
  if (!file.suppressed.some((s) => s.classKey === classKey)) return false;
  store.write({ ...file, suppressed: file.suppressed.filter((s) => s.classKey !== classKey) });
  return true;
}

// ── state file ──────────────────────────────────────────────────────────

export interface SelfImproveState {
  /** Class keys the operator dismissed: never a tool problem again. */
  dismissed: string[];
  /** The last run's result. */
  last?: FleetSelfImproveResult;
}

export function selfImproveStateFile(watcherDir: string): string {
  return join(watcherDir, 'self-improve.json');
}

function isResult(v: unknown): v is FleetSelfImproveResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.ranAt === 'string' &&
    Array.isArray(r.toolProblems) &&
    Array.isArray(r.borrowed) &&
    !!r.perBot &&
    typeof r.perBot === 'object'
  );
}

/** The state file, or `{ dismissed: [] }` when missing or unreadable. Never throws. */
export function readSelfImproveState(watcherDir: string): SelfImproveState {
  try {
    const path = selfImproveStateFile(watcherDir);
    if (!existsSync(path)) return { dismissed: [] };
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const dismissed = Array.isArray(raw?.dismissed)
      ? raw.dismissed.filter((k): k is string => typeof k === 'string')
      : [];
    return { dismissed, ...(isResult(raw?.last) ? { last: raw.last } : {}) };
  } catch {
    return { dismissed: [] };
  }
}

/** Atomic write. Throws on I/O failure. */
export function writeSelfImproveState(watcherDir: string, state: SelfImproveState): void {
  mkdirSync(watcherDir, { recursive: true });
  writeJsonFileAtomic(selfImproveStateFile(watcherDir), state);
}

// ── the watcher's runner ────────────────────────────────────────────────

export interface WatcherSelfImproveSettings {
  enabled: boolean;
  toolProblemBots: number;
  everyHours: number;
}

/** `watcher.selfImprove` with the defaults for anything missing. */
export function watcherSelfImproveSettings(watcher: unknown): WatcherSelfImproveSettings {
  const raw = (watcher as { selfImprove?: Record<string, unknown> } | undefined)?.selfImprove;
  const d = WATCHER_SELF_IMPROVE_DEFAULTS;
  const n = (v: unknown, def: number, min: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min ? v : def;
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : d.enabled,
    toolProblemBots: Math.floor(n(raw?.toolProblemBots, d.toolProblemBots, 2)),
    everyHours: n(raw?.everyHours, d.everyHours, 1),
  };
}

export interface SelfImproveRunnerDeps {
  watcherDir: string;
  /** `watcher.selfImprove` of the live config. */
  settings: () => WatcherSelfImproveSettings;
  /** The fleet now: enabled, non-tenant bots. */
  bots: () => FleetSelfImproveBot[];
  readAudit: FleetSelfImproveDeps['readAudit'];
  storeFor: FleetSelfImproveDeps['storeFor'];
  log: (row: SelfImproveLogRow) => void;
  /** Running and not stopping. */
  running: () => boolean;
  killed: () => boolean;
  now?: () => number;
  logger?: { warn: (obj: object, msg: string) => void };
}

export type SelfImproveRunResult =
  | { status: 'unavailable'; reason: string }
  | { status: 'ran'; result: FleetSelfImproveResult };

export interface SelfImproveStatus {
  enabled: boolean;
  running: boolean;
  ranAt: string | null;
  nextRunAt: string | null;
  last: FleetSelfImproveResult | null;
  dismissed: string[];
}

export type DismissResult = { ok: true; dismissed: string[] } | { ok: false; error: string };

/** A class key a dismissal accepts: `tool:class`, code characters only. */
const CLASS_KEY = /^[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.:-]{1,120}$/;

export class SelfImproveRunner {
  private inFlight: Promise<SelfImproveRunResult> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SelfImproveRunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private settings(): WatcherSelfImproveSettings {
    try {
      return this.deps.settings();
    } catch {
      return { ...WATCHER_SELF_IMPROVE_DEFAULTS };
    }
  }

  private unavailable(): string | undefined {
    if (!this.deps.running()) return 'The watcher is asleep';
    if (this.deps.killed()) return 'The hard kill is on';
    if (!this.settings().enabled) return 'Self-improvement is off (watcher.selfImprove.enabled)';
    if (this.inFlight) return 'A self-improvement run is already running';
    return undefined;
  }

  private nextAt(state: SelfImproveState): number {
    const ran = state.last ? Date.parse(state.last.ranAt) : Number.NaN;
    if (!Number.isFinite(ran)) return this.now();
    return ran + this.settings().everyHours * HOUR_MS;
  }

  status(): SelfImproveStatus {
    const state = readSelfImproveState(this.deps.watcherDir);
    const enabled = this.settings().enabled;
    return {
      enabled,
      running: this.inFlight !== null,
      ranAt: state.last?.ranAt ?? null,
      nextRunAt: enabled && this.deps.running() ? new Date(this.nextAt(state)).toISOString() : null,
      last: state.last ?? null,
      dismissed: state.dismissed,
    };
  }

  /** The run in flight, if any. */
  current(): Promise<SelfImproveRunResult> | null {
    return this.inFlight;
  }

  /** The timer's check: starts a run when one is due. True when it started one. */
  tick(nowMs: number = this.now()): boolean {
    if (this.unavailable()) return false;
    if (nowMs < this.nextAt(readSelfImproveState(this.deps.watcherDir))) return false;
    void this.run();
    return true;
  }

  /** Run now. Never throws. */
  run(): Promise<SelfImproveRunResult> {
    const why = this.unavailable();
    if (why) return Promise.resolve({ status: 'unavailable', reason: why });
    const run = Promise.resolve()
      .then(() => this.execute())
      .catch((err): SelfImproveRunResult => {
        this.deps.logger?.warn({ err }, 'Watcher: self-improve run failed');
        return { status: 'unavailable', reason: 'The self-improvement run failed unexpectedly' };
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  private async execute(): Promise<SelfImproveRunResult> {
    const state = readSelfImproveState(this.deps.watcherDir);
    const dismissed = new Set(state.dismissed);
    let bots: FleetSelfImproveBot[] = [];
    try {
      bots = this.deps.bots();
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher: self-improve could not list the bots');
    }
    const result = await runFleetSelfImprove({
      bots,
      readAudit: this.deps.readAudit,
      cfg: { toolProblemBots: this.settings().toolProblemBots },
      nowMs: this.now(),
      storeFor: this.deps.storeFor,
      log: this.deps.log,
      isDismissed: (k) => dismissed.has(k),
      previousToolProblems: state.last?.toolProblems.map((p) => p.classKey) ?? [],
    });
    try {
      // Re-read: a dismissal while the run read the fleet is kept.
      const fresh = readSelfImproveState(this.deps.watcherDir);
      writeSelfImproveState(this.deps.watcherDir, { dismissed: fresh.dismissed, last: result });
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher: could not write self-improve.json');
    }
    return { status: 'ran', result };
  }

  /**
   * The operator dismisses a tool problem: it is never one again, its
   * suppression leaves every loop-on bot's file (lessons may be written for
   * it), and one row says so. Never throws.
   */
  dismiss(classKey: string): DismissResult {
    if (typeof classKey !== 'string' || !CLASS_KEY.test(classKey)) {
      return { ok: false, error: 'Not a failure class key' };
    }
    const state = readSelfImproveState(this.deps.watcherDir);
    const dismissed = state.dismissed.includes(classKey)
      ? state.dismissed
      : [...state.dismissed, classKey];
    const last = state.last
      ? {
          ...state.last,
          toolProblems: state.last.toolProblems.filter((p) => p.classKey !== classKey),
        }
      : undefined;
    try {
      writeSelfImproveState(this.deps.watcherDir, { dismissed, ...(last ? { last } : {}) });
    } catch (err) {
      this.deps.logger?.warn({ err }, 'Watcher: could not write self-improve.json');
      return { ok: false, error: 'Could not save the dismissal' };
    }
    let bots: FleetSelfImproveBot[] = [];
    try {
      bots = this.deps.bots();
    } catch {
      bots = [];
    }
    for (const b of bots) {
      if (!b.loopOn) continue;
      try {
        removeSuppression(this.deps.storeFor(b.soulDir), classKey);
      } catch (err) {
        this.safeLog({
          op: 'self-improve:error',
          text: `I could not lift the ${classKey} suppression for ${b.name} (${b.id}): ${errText(err)}.`,
        });
      }
    }
    this.safeLog({
      op: 'self-improve:dismissed',
      text: `You dismissed ${classKey} as a tool problem; bots may learn lessons for it again.`,
    });
    return { ok: true, dismissed };
  }

  private safeLog(row: SelfImproveLogRow): void {
    try {
      this.deps.log(row);
    } catch {
      // never throws
    }
  }
}
