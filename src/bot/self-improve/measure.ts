/**
 * Measure (`docs/plans/self-improve-plan.md`, bot loop step 4): a lesson's
 * failure class rate before it existed (baseline) and after (measure), and
 * the verdict once the measurement window closes. Code only, no LLM.
 */

import { isToolFailure } from '../../stats/readers/tool-audit';
import type { ToolAuditEntry } from '../tool-audit-log';
import { classifyFailure, isLoopCall } from './classes';
import type { FailureClass, Lesson, LessonStatus, RateWindow, ResolvedSelfImprove } from './types';
import { BASELINE_DAYS } from './types';

const DAY_MS = 86_400_000;

/** Fewer calls than this in a closed window is too few to tell. */
export const MIN_MEASURE_CALLS = 5;

export interface LessonEvaluation {
  status: LessonStatus;
  statusReason: string;
  measure: RateWindow;
  extended: boolean;
}

/**
 * The class's failures over its tool's calls in `[sinceMs, untilMs)`. Calls
 * that never counted as a failure (blocked, aborted, …) are on neither side.
 */
export function rateWindow(
  entries: ToolAuditEntry[],
  cls: FailureClass,
  sinceMs: number,
  untilMs: number
): RateWindow {
  let calls = 0;
  let failures = 0;
  for (const e of entries) {
    if (e.toolName !== cls.tool || !isLoopCall(e)) continue;
    const ms = Date.parse(e.timestamp);
    if (!Number.isFinite(ms) || ms < sinceMs || ms >= untilMs) continue;
    if (e.success === true) {
      calls++;
    } else if (isToolFailure(e)) {
      calls++;
      if (classifyFailure(e)?.key === cls.key) failures++;
    }
  }
  return { failures, calls, rate: calls > 0 ? failures / calls : 0, sinceMs, untilMs };
}

/** The class's rate over the `BASELINE_DAYS` before `nowMs`. */
export function baselineFor(
  entries: ToolAuditEntry[],
  cls: FailureClass,
  nowMs: number
): RateWindow {
  return rateWindow(entries, cls, nowMs - BASELINE_DAYS * DAY_MS, nowMs);
}

const pct = (rate: number) => `${Math.round(rate * 100)}%`;

/**
 * The verdict on an active lesson once its measurement window closed
 * (`measureCalls` calls of the tool or `measureDays` days, whichever first);
 * null while the window is open or for a lesson that is not active.
 */
export function evaluateLesson(
  lesson: Lesson,
  entries: ToolAuditEntry[],
  cfg: ResolvedSelfImprove,
  nowMs: number
): LessonEvaluation | null {
  if (lesson.status !== 'active') return null;
  const extended = lesson.extended === true;
  const startMs =
    extended && lesson.measure ? lesson.measure.untilMs : Date.parse(lesson.createdAt);
  if (!Number.isFinite(startMs)) return null;

  const cls: FailureClass = {
    key: lesson.classKey,
    tool: lesson.tool,
    errorClass: lesson.errorClass,
  };
  const measure = rateWindow(entries, cls, startMs, nowMs);
  const closed = measure.calls >= cfg.measureCalls || nowMs - startMs >= cfg.measureDays * DAY_MS;
  if (!closed) return null;

  if (measure.calls < MIN_MEASURE_CALLS) {
    if (!extended) {
      return {
        status: 'active',
        statusReason: `too few calls to tell (${measure.calls}); measuring once more`,
        measure,
        extended: true,
      };
    }
    return {
      status: 'unproven',
      statusReason: `too few calls to tell after two windows (${measure.calls})`,
      measure,
      extended,
    };
  }

  const change = `failure rate ${pct(lesson.baseline.rate)} → ${pct(measure.rate)} over ${measure.calls} calls`;
  if (measure.rate <= lesson.baseline.rate * (1 - cfg.minDrop)) {
    return { status: 'proven', statusReason: change, measure, extended };
  }
  return {
    status: 'retired',
    statusReason: `${change}, did not drop by ${pct(cfg.minDrop)}`,
    measure,
    extended,
  };
}
