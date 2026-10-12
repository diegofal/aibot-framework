/**
 * Why for a curiosity dispatch: what produced it (`Dispatch.origin`, recorded
 * or inferred by `src/bot/curiosity/origin.ts`), the digest's sources, and
 * why it reached the operator or did not.
 */
import type { DigestSource } from '../../bot/curiosity/origin';
import type { Dispatch, DispatchTrigger } from '../../bot/curiosity/types';
import { describeModeReason } from '../cycle-index';
import type { Why, WhyCycle } from '../types';

/** Written by the runner when it holds an insight without an editor pass. */
const CADENCE_MARKER = 'held: cadence closed, not edited';

const TRIGGER_TEXT: Record<DispatchTrigger, string> = {
  insight: 'A finding from one of its work cycles',
  digest: 'A digest of findings that were held back',
  frontier: 'A question it wants your permission to explore',
  interest: 'An interest it thinks it is growing into',
};

const HELD_TEXT: Record<string, string> = {
  'cadence-closed':
    'Held without editing: it had messaged you recently, so this waits for a digest.',
  'editor-failed': 'Held: the editor call failed, so it was never scored.',
  'fleet-cap': "Held: the fleet's daily message cap was already used up.",
  'delivery-failed': 'Held: the editor approved it, but delivery failed.',
  disabled: 'Held: dispatches are turned off for this agent.',
};

const score = (x: unknown) => (Number(x) || 0).toFixed(2);

export type ExplainedDispatch = Dispatch & {
  sources?: { inferred: boolean; items: DigestSource[] };
};

/** One sentence: why this dispatch reached the operator, or why it did not. */
export function dispatchOutcome(d: Dispatch): string {
  if (d.status === 'dropped') {
    return 'Dropped: the editor judged it not worth sending, or a digest already covered it.';
  }
  if (d.status !== 'held') {
    const via = d.deliveredVia === 'telegram' ? 'on Telegram' : 'in your dashboard feed';
    return `Sent to you ${via} (editor score ${score(d.editorScore)}).`;
  }
  if (d.heldReason === 'editor' && typeof d.heldBar === 'number') {
    return `Held: the editor scored it ${score(d.editorScore)}; it needed ${score(d.heldBar)} to reach you.`;
  }
  const reason = d.heldReason ?? (d.editorNotes === CADENCE_MARKER ? 'cadence-closed' : null);
  if (reason && HELD_TEXT[reason]) return HELD_TEXT[reason];
  return `Held: the editor scored it ${score(d.editorScore)}, below what it takes to reach you.`;
}

function triggerOf(d: Dispatch): DispatchTrigger {
  if (d.origin?.trigger) return d.origin.trigger;
  if (d.kind === 'digest') return 'digest';
  if (d.kind === 'proposal') return d.interest ? 'interest' : 'frontier';
  return 'insight';
}

export function dispatchToWhy(d: ExplainedDispatch): Why {
  const o = d.origin;
  const trigger = triggerOf(d);
  const why: Why = { what: TRIGGER_TEXT[trigger], by: 'curiosity' };
  if (o?.cycleId) {
    const cycle: WhyCycle = { id: o.cycleId, botId: d.botId };
    if (o.plan) cycle.plan = o.plan;
    if (o.mode) cycle.mode = o.mode;
    const modeReason = o.mode === 'explore' ? describeModeReason(o.modeReason) : undefined;
    if (modeReason) cycle.modeReason = modeReason;
    if (o.frontierQuestion) cycle.chasing = o.frontierQuestion;
    if (o.inferred) cycle.inferred = true;
    why.cycle = cycle;
  } else if (trigger !== 'digest') {
    why.missing = 'No record of the cycle that produced it (written before cycles were logged).';
  }
  if (o?.goalTitle) why.goal = { ...(o.goalId ? { id: o.goalId } : {}), title: o.goalTitle };
  const items = d.sources?.items ?? [];
  if (items.length > 0) {
    why.related = {
      label: 'Built from',
      items: items.map((s) => ({
        text: s.hook,
        at: s.createdAt,
        detail: `score ${score(s.editorScore)}`,
      })),
      ...(d.sources?.inferred ? { note: 'Reconstructed from what was held at the time.' } : {}),
    };
  }
  why.outcome = dispatchOutcome(d);
  const notes: Array<{ label: string; text: string }> = [];
  if (o?.draftHook) {
    notes.push({
      label: 'Draft',
      text: `The editor rewrote the headline. The agent wrote: “${o.draftHook}”`,
    });
  }
  if (d.editorNotes && d.editorNotes !== CADENCE_MARKER) {
    notes.push({ label: 'Editor', text: d.editorNotes });
  }
  if (notes.length > 0) why.notes = notes;
  return why;
}
