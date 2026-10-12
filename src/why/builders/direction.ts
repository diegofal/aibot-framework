/**
 * Why for a navigator direction (one line of DIRECTIONS.jsonl): what
 * triggered the run, the retrospective it wrote, what it learned and what
 * surprised it, and the bets it made. All of it is what the navigator wrote
 * at the time.
 */
import type { DirectionRecord, NavigatorRunTrigger } from '../../bot/curiosity/types';
import type { Why, WhyRelatedItem } from '../types';

export interface DirectionWhyInput {
  botId: string;
  /** A DIRECTIONS.jsonl row; `operatorSignal` when it is the current direction. */
  direction: DirectionRecord & { operatorSignal?: 'up' | 'down' };
}

/** `2026-10-11T09:30:00.000Z` → `2026-10-11 09:30 UTC`. */
const stamp = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function triggerRule(t: NavigatorRunTrigger): string {
  if (t.kind === 'first') return 'First run: it had never set a direction.';
  if (t.kind === 'retry') {
    return t.failedAttemptAt
      ? `Retry: the attempt at ${stamp(t.failedAttemptAt)} failed, so it ran again after the backoff.`
      : 'Retry: the previous attempt failed, so it ran again after the backoff.';
  }
  const last = t.lastRunAt ? `; the previous direction was set ${stamp(t.lastRunAt)}` : '';
  return `Due: the navigator runs every ${t.everyHours} h${last}.`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function directionToWhy({ direction: d }: DirectionWhyInput): Why {
  const why: Why = { what: 'A new direction for its exploration', by: 'navigator' };
  const retro = (d.retrospective ?? '').trim();
  if (retro) why.reason = { text: retro, source: 'Navigator retrospective' };
  if (d.trigger) why.rule = triggerRule(d.trigger);
  const items: WhyRelatedItem[] = [
    ...(d.learned ?? []).filter(Boolean).map((text) => ({ text, detail: 'learned' })),
    ...(d.surprised ?? []).filter(Boolean).map((text) => ({ text, detail: 'surprised it' })),
  ];
  if (items.length > 0) why.related = { label: 'Learned and surprised by', items };
  const bets = (d.bets ?? []).filter((b) => b?.title);
  if (bets.length > 0) {
    why.outcome = `Bets: ${bets.map((b) => `${b.kind} “${b.title}”`).join('; ')}.`;
  }
  const notes: Array<{ label: string; text: string }> = [];
  const added = d.frontierAdded?.length ?? 0;
  const dropped = d.frontierDropped?.length ?? 0;
  if (added + dropped > 0) {
    notes.push({
      label: 'Frontier',
      text: `Added ${plural(added, 'question')}, dropped ${dropped}.`,
    });
  }
  if (d.operatorSignal === 'up') {
    notes.push({ label: 'Your verdict', text: 'You marked it a good direction.' });
  } else if (d.operatorSignal === 'down') {
    notes.push({ label: 'Your verdict', text: 'You asked it to rethink this direction.' });
  }
  if (notes.length > 0) why.notes = notes;
  if (!d.trigger) why.missing = 'No record of what triggered this run.';
  return why;
}
