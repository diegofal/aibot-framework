/**
 * Failure classes (`docs/plans/self-improve-plan.md`, bot loop step 1): a
 * charged tool failure reduced to `${tool}:${errorClass}` by code, so the
 * same mistake made twice lands in the same class.
 */

import { isToolFailure } from '../../stats/readers/tool-audit';
import type { ToolAuditEntry } from '../tool-audit-log';
import type { FailureClass } from './types';

/** The error classes with a name; everything else is `other:<slug>`. */
export const FAILURE_CLASSES = [
  'file-not-found',
  'read-a-directory',
  'guessed-url',
  'server-error',
  'note-too-long',
  'task-claimed',
  'value-too-long',
] as const;

export type NamedFailureClass = (typeof FAILURE_CLASSES)[number];

/** Chars of the result head that name an unnamed class. */
const SLUG_HEAD_CHARS = 40;

function namedClass(
  result: string,
  failureKind: ToolAuditEntry['failureKind']
): NamedFailureClass | null {
  if (result.startsWith('File not found')) return 'file-not-found';
  if (result.includes('Directories cannot be read')) return 'read-a-directory';
  if (failureKind === 'not-found' || result.includes('does not exist (4')) return 'guessed-url';
  if (
    (/\b5\d\d\b/.test(result) && result.includes('Server Error')) ||
    result.includes('Fetch failed: 5')
  ) {
    return 'server-error';
  }
  if (result.includes('note is longer than')) return 'note-too-long';
  if (result.includes('is being worked on by run')) return 'task-claimed';
  if (/value is \d+ characters, the limit is/.test(result)) return 'value-too-long';
  return null;
}

function otherClass(result: string): string {
  // Digits go before the cut: a longer number must not push different text
  // into the slug and split one failure into two classes.
  const slug = result
    .replace(/\d/g, '')
    .slice(0, SLUG_HEAD_CHARS)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `other:${slug || 'empty'}`;
}

/** The failure class of an audited call, or null when the call is not a charged failure. */
export function classifyFailure(
  e: Pick<ToolAuditEntry, 'toolName' | 'result' | 'success' | 'failureKind'>
): FailureClass | null {
  if (!isToolFailure(e)) return null;
  const result = e.result ?? '';
  const errorClass = namedClass(result, e.failureKind) ?? otherClass(result);
  return { key: `${e.toolName}:${errorClass}`, tool: e.toolName, errorClass };
}

/**
 * A call made inside an agent-loop cycle (`cycleId`, not a worker run): the
 * only calls a lesson can reach, since lessons live in the planner and
 * executor prompts. Conversation and worker calls never count, for detection
 * or measurement.
 */
export function isLoopCall(e: Pick<ToolAuditEntry, 'cycleId' | 'runId'>): boolean {
  return !!e.cycleId && !e.runId;
}
