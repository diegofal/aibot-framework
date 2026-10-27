/**
 * Detect (`docs/plans/self-improve-plan.md`, bot loop step 1): failure
 * classes that repeated in the detection window and have no lesson yet.
 * Code only, no LLM.
 */

import type { ToolAuditEntry } from '../tool-audit-log';
import { classifyFailure, isLoopCall } from './classes';
import type { Candidate, FailureClass } from './types';
import { DETECT_WINDOW_MS, EVIDENCE_MAX } from './types';

export interface FindCandidatesInput {
  entries: ToolAuditEntry[];
  nowMs: number;
  minRepeats: number;
  /** Classes that already have an active lesson. */
  activeClassKeys: ReadonlySet<string>;
  /** Classes the watcher marked as tool problems. */
  suppressedClassKeys: ReadonlySet<string>;
}

interface Timed {
  ms: number;
  entry: ToolAuditEntry;
}

const newestFirst = (a: Timed, b: Timed) => b.ms - a.ms;

/** Failure classes with ≥ `minRepeats` failures in the last `DETECT_WINDOW_MS`. */
export function findCandidates(input: FindCandidatesInput): Candidate[] {
  const { nowMs, minRepeats, activeClassKeys, suppressedClassKeys } = input;
  const sinceMs = nowMs - DETECT_WINDOW_MS;
  const inWindow: Timed[] = [];
  for (const entry of input.entries) {
    if (!isLoopCall(entry)) continue;
    const ms = Date.parse(entry.timestamp);
    if (Number.isFinite(ms) && ms >= sinceMs && ms <= nowMs) inWindow.push({ ms, entry });
  }

  const groups = new Map<string, { cls: FailureClass; failures: Timed[] }>();
  for (const t of inWindow) {
    const cls = classifyFailure(t.entry);
    if (!cls) continue;
    const group = groups.get(cls.key) ?? { cls, failures: [] };
    group.failures.push(t);
    groups.set(cls.key, group);
  }

  const candidates: Candidate[] = [];
  for (const { cls, failures } of groups.values()) {
    if (failures.length < minRepeats) continue;
    if (activeClassKeys.has(cls.key) || suppressedClassKeys.has(cls.key)) continue;
    const successes = inWindow
      .filter((t) => t.entry.success === true && t.entry.toolName === cls.tool)
      .sort(newestFirst)
      .slice(0, EVIDENCE_MAX);
    candidates.push({
      cls,
      failures: failures.sort(newestFirst).map((t) => t.entry),
      successes: successes.map((t) => t.entry),
    });
  }
  return candidates.sort(
    (a, b) =>
      b.failures.length - a.failures.length ||
      (a.cls.key < b.cls.key ? -1 : a.cls.key > b.cls.key ? 1 : 0)
  );
}
