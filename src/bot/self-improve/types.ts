/**
 * Self-improvement loops, the shared contract (`docs/plans/self-improve-plan.md`).
 *
 * A lesson is a short instruction a bot learned from its own repeated tool
 * failures, plus the measurement that proves it: the failure class's rate
 * before it existed (baseline) and after (measure). Code decides everything
 * except the lesson's wording.
 *
 * Add fields; never rename or remove one (LESSONS.json travels with exports).
 */

import type { ToolAuditEntry } from '../tool-audit-log';

/** `${tool}:${errorClass}`, e.g. `file_read:file-not-found`. */
export type FailureClassKey = string;

export interface FailureClass {
  key: FailureClassKey;
  tool: string;
  /** Code-normalised error class (`classifyFailure`). */
  errorClass: string;
}

/**
 * - `active`: in the prompt, being measured.
 * - `proven`: measured, the rate dropped ≥ `minDrop`; stays in the prompt.
 * - `retired`: measured, it did not help; out of the prompt.
 * - `unproven`: too few calls in two windows to tell; out of the prompt.
 */
export type LessonStatus = 'active' | 'proven' | 'retired' | 'unproven';

/** A rate of one failure class over the calls of its tool, in a time window. */
export interface RateWindow {
  failures: number;
  calls: number;
  /** failures / calls; 0 when calls is 0. */
  rate: number;
  sinceMs: number;
  untilMs: number;
}

export interface Lesson {
  /** `l-` + 8 hex. */
  id: string;
  classKey: FailureClassKey;
  tool: string;
  errorClass: string;
  /** ≤ `LESSON_TEXT_MAX` chars, shown to the bot verbatim. */
  text: string;
  /** Who wrote the text: the model, or the fixed sentence for the class. */
  textSource: 'model' | 'fallback';
  /** Audit rows the lesson cites: `auditRowRef(entry)`. */
  evidence: string[];
  source: 'own' | 'borrowed';
  /** Set when `source` is `borrowed`. */
  borrowedFrom?: { botId: string; lessonId: string };
  status: LessonStatus;
  /** Why the status is what it is, in words (written by code). */
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
  /** Cycle that created it, when created after a cycle. */
  cycleId?: string;
  /** The class's rate in the `BASELINE_DAYS` before the lesson. */
  baseline: RateWindow;
  /** The latest measurement window, once one closed. */
  measure?: RateWindow;
  /** The first window was too thin and a second one was opened. */
  extended?: boolean;
}

/** A failure class that crossed `minRepeats` in the detection window (`findCandidates`). */
export interface Candidate {
  cls: FailureClass;
  /** The class's failures in the window, newest first. */
  failures: ToolAuditEntry[];
  /** Successful calls of the same tool in the window, newest first, ≤ `EVIDENCE_MAX`. */
  successes: ToolAuditEntry[];
}

/** A class the watcher found in several bots: a tool problem, not a habit. */
export interface SuppressedClass {
  classKey: FailureClassKey;
  reason: string;
  since: string;
  /** Bots the watcher saw it in. */
  bots: string[];
}

export interface LessonsFile {
  version: 1;
  lessons: Lesson[];
  /** Written by the watcher; no lesson is created for these classes. */
  suppressed: SuppressedClass[];
}

/** Resolved per-bot config (`resolveSelfImprove`). */
export interface ResolvedSelfImprove {
  enabled: boolean;
  minRepeats: number;
  maxActive: number;
  measureCalls: number;
  measureDays: number;
  minDrop: number;
}

export const LESSONS_FILE = 'LESSONS.json';
export const LESSON_TEXT_MAX = 300;
/** Detection window: failures of a class inside it count toward `minRepeats`. */
export const DETECT_WINDOW_MS = 48 * 3_600_000;
/** Baseline window before a lesson. */
export const BASELINE_DAYS = 7;
/** Lessons kept in the file (oldest retired/unproven dropped first). */
export const LESSONS_KEEP = 100;
/** Evidence rows shown to the writer and stored on a lesson. */
export const EVIDENCE_MAX = 5;

/**
 * A stable reference to one audit row (the audit has no ids):
 * `<ISO timestamp>|<toolName>`.
 */
export function auditRowRef(e: { timestamp: string; toolName: string }): string {
  return `${e.timestamp}|${e.toolName}`;
}

/** Statuses that put a lesson in the prompt. */
export function isLessonInPrompt(l: Pick<Lesson, 'status'>): boolean {
  return l.status === 'active' || l.status === 'proven';
}
