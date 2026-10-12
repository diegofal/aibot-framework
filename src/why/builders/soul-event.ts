/**
 * Why for one edit to a bot's memory or soul files (`soul-events.jsonl`,
 * `src/bot/soul-events.ts`): memory consolidation, facts saved by a memory
 * flush, hygiene fixes. Everything comes from the row written at the time:
 * the heads of what was added or dropped, the conversation, the hygiene run,
 * the backup. Pure.
 */
import type { SoulEvent } from '../../bot/soul-events';
import { type CycleRow, toWhyCycle } from '../cycle-index';
import type { Why, WhyActor, WhyRelatedItem } from '../types';

export interface SoulEventWhyInput {
  botId: string;
  event: SoulEvent;
  /** The cycle-log row of `event.cycleId`, when the log still has it. */
  cycle?: CycleRow;
}

const WHAT: Record<string, string> = {
  consolidate: 'Memory consolidated',
  'consolidate-rejected': 'Memory consolidation rejected',
  'facts-saved': 'Facts saved from a conversation',
  'hygiene-fix': 'Hygiene fix',
};

const ACTORS: Record<string, WhyActor> = {
  system: 'system',
  hygiene: 'hygiene',
  agent: 'agent',
};

const END_REASON: Record<string, string> = {
  idle: 'it went idle',
  daily: 'the daily reset',
  command: 'a /new, /reset or /clear command',
};

function flushRule(e: SoulEvent): string | undefined {
  if (e.trigger === 'proactive')
    return 'A conversation is flushed to memory each time enough new messages pile up.';
  if (e.trigger === 'compaction')
    return 'Older messages are flushed to memory before a long conversation is compacted.';
  if (e.trigger === 'conversation-end') {
    const why = e.endReason ? (END_REASON[e.endReason] ?? e.endReason) : undefined;
    return `What was not flushed yet is saved when a conversation ends${why ? ` (this one ended by ${why})` : ''}.`;
  }
  return undefined;
}

function ruleOf(e: SoulEvent): string | undefined {
  switch (e.op) {
    case 'consolidate':
      return 'Daily logs older than today are merged into MEMORY.md, then archived.';
    case 'consolidate-rejected':
      return 'A consolidation is refused when its output lacks the header or would shrink MEMORY.md by more than half.';
    case 'facts-saved':
      return flushRule(e);
    default:
      return undefined;
  }
}

function relatedOf(e: SoulEvent): Why['related'] | undefined {
  if (e.op === 'hygiene-fix') {
    return e.detail?.length
      ? { label: 'Fixes', items: e.detail.map((text) => ({ text })) }
      : undefined;
  }
  if (e.op === 'facts-saved') {
    return e.added?.length
      ? { label: 'Facts saved', items: e.added.map((text) => ({ text })) }
      : undefined;
  }
  const items: WhyRelatedItem[] = [
    ...(e.added ?? []).map((text) => ({ text, detail: 'added' })),
    ...(e.removed ?? []).map((text) => ({ text, detail: 'dropped' })),
  ];
  if (items.length === 0) return undefined;
  const related: NonNullable<Why['related']> = { label: 'What changed', items };
  const added = e.addedCount ?? e.added?.length ?? 0;
  const removed = e.removedCount ?? e.removed?.length ?? 0;
  if (added > (e.added?.length ?? 0) || removed > (e.removed?.length ?? 0)) {
    related.note = `Showing ${e.added?.length ?? 0} of ${added} added and ${e.removed?.length ?? 0} of ${removed} dropped lines.`;
  }
  return related;
}

export function soulEventToWhy(input: SoulEventWhyInput): Why {
  const { botId, event: e } = input;
  const why: Why = { what: WHAT[e.op] ?? `Memory edited (${e.op})` };
  const by = ACTORS[e.actor];
  if (by) why.by = by;
  if (e.cycleId) {
    why.cycle = input.cycle ? toWhyCycle(botId, input.cycle) : { id: e.cycleId, botId };
  }
  const rule = ruleOf(e);
  if (rule) why.rule = rule;
  const related = relatedOf(e);
  if (related) why.related = related;
  if (e.summary) why.outcome = e.summary;

  const notes: Array<{ label: string; text: string }> = [];
  if (e.file) notes.push({ label: 'File', text: e.file });
  if (e.op !== 'hygiene-fix' && e.detail?.length)
    notes.push({ label: 'Daily logs', text: e.detail.join(', ') });
  if (e.conversation) notes.push({ label: 'Conversation', text: e.conversation });
  if (e.observedAt) notes.push({ label: 'Said on', text: e.observedAt });
  if (e.runId) notes.push({ label: 'Hygiene run', text: e.runId });
  if (e.backup) notes.push({ label: 'Backup', text: e.backup });
  if (notes.length > 0) why.notes = notes;

  const missing: string[] = [];
  if (e.op === 'facts-saved' && !e.conversation)
    missing.push('No conversation was recorded with this flush.');
  if (e.cycleId && !input.cycle)
    missing.push('The cycle log has no record of this cycle, so its plan is unknown.');
  if (missing.length > 0) why.missing = missing.join(' ');
  return why;
}
