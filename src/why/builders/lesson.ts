/**
 * Why for one self-improvement lesson (`<soulDir>/LESSONS.json`,
 * `src/bot/self-improve/`): the failure class that made it, the calls it
 * cites, the measurement rule that keeps or retires it, and how it measured.
 * Everything comes from the lesson as code wrote it. Pure.
 */
import { SELF_IMPROVE_DEFAULTS } from '../../bot/self-improve/config';
import {
  BASELINE_DAYS,
  type Lesson,
  type LessonStatus,
  type RateWindow,
} from '../../bot/self-improve/types';
import { type CycleRow, toWhyCycle } from '../cycle-index';
import type { Why } from '../types';

export interface LessonWhyContext {
  /** The bot that holds the lesson. */
  botId: string;
  /** Fraction (0.5 = 50 %) the rate must drop by; the bot's resolved `minDrop`. */
  minDrop?: number;
  /** Display name of the bot a borrowed lesson came from. */
  sourceBotName?: string;
  /** The cycle-log row of `lesson.cycleId`, when the log still has it. */
  cycle?: CycleRow;
}

const STATUS_WORDS: Record<LessonStatus, string> = {
  active: 'Active: in the prompt, being measured.',
  proven: 'Proven: it worked, kept in the prompt.',
  retired: 'Retired: it did not help, out of the prompt.',
  unproven: 'Unproven: too few calls to tell, out of the prompt.',
};

function pct(rate: number): string {
  return `${Math.round((Number.isFinite(rate) ? rate : 0) * 100)}%`;
}

function rateText(w: RateWindow): string {
  return `${pct(w.rate)} (${w.failures} of ${w.calls} calls)`;
}

/** `<ISO>|<tool>` → its two halves; a ref without a bar is all timestamp. */
function splitRef(ref: string): { at: string; tool?: string } {
  const bar = ref.lastIndexOf('|');
  return bar < 0 ? { at: ref } : { at: ref.slice(0, bar), tool: ref.slice(bar + 1) || undefined };
}

export function lessonToWhy(lesson: Lesson, ctx: LessonWhyContext): Why {
  const why: Why = {
    what: `Lesson: ${lesson.text || lesson.classKey}`,
    by: lesson.source === 'borrowed' ? 'watcher' : 'agent',
  };
  if (lesson.cycleId) {
    why.cycle = ctx.cycle
      ? toWhyCycle(ctx.botId, ctx.cycle)
      : { id: lesson.cycleId, botId: ctx.botId };
  }

  const b = lesson.baseline;
  why.reason = {
    text: `${lesson.tool} failed the same way (${lesson.errorClass}) ${b.failures} times in ${b.calls} calls in the ${BASELINE_DAYS} days before the lesson.`,
    source: 'Self-improvement',
  };
  const minDrop = ctx.minDrop ?? SELF_IMPROVE_DEFAULTS.minDrop;
  why.rule = `Kept only if the ${lesson.errorClass} failure rate of ${lesson.tool} drops by at least ${pct(minDrop)} after the lesson.`;

  const items = lesson.evidence
    .filter((ref) => typeof ref === 'string' && ref.length > 0)
    .map((ref) => {
      const { at, tool } = splitRef(ref);
      return { text: `${tool ?? lesson.tool} failed (${lesson.errorClass})`, at };
    });
  if (items.length > 0) why.related = { label: 'Calls that failed', items };

  const outcome = [STATUS_WORDS[lesson.status] ?? `Status: ${lesson.status}.`];
  if (lesson.statusReason) outcome.push(lesson.statusReason);
  outcome.push(
    lesson.measure
      ? `Before: ${rateText(b)} → now ${rateText(lesson.measure)}.`
      : `Before: ${rateText(b)}.`
  );
  why.outcome = outcome.join(' ');

  const notes: Array<{ label: string; text: string }> = [];
  if (lesson.source === 'borrowed' && lesson.borrowedFrom) {
    const from = ctx.sourceBotName || lesson.borrowedFrom.botId;
    notes.push({
      label: 'Borrowed from',
      text: `${from} (lesson ${lesson.borrowedFrom.lessonId})`,
    });
  }
  if (lesson.textSource === 'fallback')
    notes.push({ label: 'Fixed text', text: "the model's answer was not usable or not asked" });
  if (lesson.extended)
    notes.push({ label: 'Measured twice', text: 'the first window had too few calls' });
  if (notes.length > 0) why.notes = notes;
  return why;
}

/** Single-argument form for `WHY_BUILDERS`. */
export function lessonEntryToWhy(input: LessonWhyContext & { lesson: Lesson }): Why {
  const { lesson, ...ctx } = input;
  return lessonToWhy(lesson, ctx);
}
