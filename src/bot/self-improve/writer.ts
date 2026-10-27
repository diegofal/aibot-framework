/**
 * Self-improvement, step 2 (`docs/plans/self-improve-plan.md`): word a lesson
 * for a failure class. One small LLM call over a code-built digest; code
 * rejects any answer that cites a row it was not shown, and a fixed sentence
 * per class stands in when there is no usable answer.
 */

import { parseLLMJson } from '../llm-json-parser';
import type { ToolAuditEntry } from '../tool-audit-log';
import type { Candidate, FailureClass } from './types';
import { EVIDENCE_MAX, LESSON_TEXT_MAX, auditRowRef } from './types';

/** Chars of a row's args (compact JSON) and of its result shown to the writer. */
const DIGEST_FIELD_MAX = 200;
/** Chars of a tool name / error class quoted in the generic fallback. */
const FALLBACK_NAME_MAX = 80;

const FALLBACK_BY_CLASS: Record<string, string> = {
  'file-not-found':
    'Get the exact path from read_production_log or the directory listing before calling file_read again. Never guess a path.',
  'read-a-directory':
    'file_read reads files only. When a path is a folder, list the directory first and read one of its files.',
  'guessed-url':
    'Only fetch URLs that appeared in web_search results or in pages you already read. Never build a URL by guessing.',
  'server-error':
    'The site failed on its side. Use the search snippet or another source instead of retrying the same URL.',
  'note-too-long': 'Keep manage_goals notes under the limit the error names: one short sentence.',
  'task-claimed': 'A worker owns that task. Leave it alone until its run ends.',
  'value-too-long':
    'Split the value into shorter entries instead of sending one value over the limit.',
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line: newlines and runs of whitespace collapse to a single space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The fixed sentence used when no model answer is usable. Always ≤ `LESSON_TEXT_MAX`. */
export function fallbackLesson(cls: FailureClass): string {
  const named = FALLBACK_BY_CLASS[cls.errorClass];
  if (named) return clip(named, LESSON_TEXT_MAX);
  const tool = clip(oneLine(cls.tool), FALLBACK_NAME_MAX);
  const errorClass = clip(oneLine(cls.errorClass), FALLBACK_NAME_MAX);
  return clip(
    `${tool} kept failing the same way (${errorClass}). Read the error before calling it again and change what you send instead of repeating the call.`,
    LESSON_TEXT_MAX
  );
}

const DIGEST_SYSTEM = `You write one lesson for an AI agent about a mistake it keeps making with one of its tools.

The lesson:
- at most ${LESSON_TEXT_MAX} characters;
- imperative and concrete: what to do differently next time;
- no blame, no apology, no restating the error.

Answer with JSON only:
{"lesson": string, "evidence": [refs]}
where every ref is copied exactly from a "ref" line shown in the calls below (at least one).`;

function digestValue(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  } catch {
    text = String(value);
  }
  return clip(oneLine(text), DIGEST_FIELD_MAX);
}

function digestRows(rows: ToolAuditEntry[], shownRefs: Set<string>): string {
  if (rows.length === 0) return '(none in the window)';
  return rows
    .map((row) => {
      const ref = auditRowRef(row);
      shownRefs.add(ref);
      return `- ref: ${ref}\n  args: ${digestValue(row.args)}\n  result: ${digestValue(row.result)}`;
    })
    .join('\n');
}

/** The writer's prompt: the class, ≤ `EVIDENCE_MAX` failures and ≤ `EVIDENCE_MAX` successes. */
export function buildLessonDigest(c: Candidate): {
  system: string;
  prompt: string;
  shownRefs: Set<string>;
} {
  const shownRefs = new Set<string>();
  const failures = digestRows(c.failures.slice(0, EVIDENCE_MAX), shownRefs);
  const successes = digestRows(c.successes.slice(0, EVIDENCE_MAX), shownRefs);
  const prompt = `Tool: ${c.cls.tool}
Error class: ${c.cls.errorClass}

Calls that failed this way (newest first):
${failures}

Calls of the same tool that worked (newest first):
${successes}`;
  return { system: DIGEST_SYSTEM, prompt, shownRefs };
}

const SILENT = { warn: () => {} };

/**
 * The model's answer, or null when it is unparseable, the lesson is missing,
 * empty or over `LESSON_TEXT_MAX` (never truncated), the evidence is missing
 * or empty, or it cites a row it was not shown. Duplicate refs collapse and
 * at most `EVIDENCE_MAX` are kept.
 */
export function parseLessonAnswer(
  text: string,
  shownRefs: ReadonlySet<string>
): { text: string; evidence: string[] } | null {
  return parseLLMJson(text, SILENT, {
    label: 'self-improve writer',
    extractPattern: /\{[\s\S]*"lesson"[\s\S]*\}/,
    validate: (parsed: unknown) => {
      if (!parsed || typeof parsed !== 'object') return null;
      const { lesson, evidence } = parsed as { lesson?: unknown; evidence?: unknown };
      if (typeof lesson !== 'string') return null;
      const lessonText = lesson.trim();
      if (!lessonText || lessonText.length > LESSON_TEXT_MAX) return null;
      if (!Array.isArray(evidence) || evidence.length === 0) return null;
      const refs: string[] = [];
      for (const ref of evidence) {
        if (typeof ref !== 'string' || !shownRefs.has(ref)) return null;
        if (!refs.includes(ref)) refs.push(ref);
      }
      return { text: lessonText, evidence: refs.slice(0, EVIDENCE_MAX) };
    },
  });
}

/**
 * Word the lesson for a candidate. Never throws: without `generate`, when it
 * throws, or when its answer is not usable, the class's fixed sentence is used
 * with the newest `EVIDENCE_MAX` failures as evidence.
 */
export async function writeLesson(
  c: Candidate,
  deps: { generate?: (system: string, prompt: string) => Promise<string> }
): Promise<{ text: string; textSource: 'model' | 'fallback'; evidence: string[] }> {
  try {
    if (deps.generate) {
      const { system, prompt, shownRefs } = buildLessonDigest(c);
      const answer = await deps.generate(system, prompt);
      const parsed = typeof answer === 'string' ? parseLessonAnswer(answer, shownRefs) : null;
      if (parsed) return { text: parsed.text, textSource: 'model', evidence: parsed.evidence };
    }
  } catch {
    // fall through to the fixed sentence
  }
  return {
    text: fallbackLesson(c.cls),
    textSource: 'fallback',
    evidence: [...new Set(c.failures.slice(0, EVIDENCE_MAX).map(auditRowRef))],
  };
}
