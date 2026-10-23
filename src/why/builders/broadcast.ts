/**
 * Why for a fleet-watcher broadcast (phase 3): what the watcher did to a bot
 * (woke it, gave it a directive, added a goal, asked the operator), the
 * insight it came from as the reason, and what became of it (delivered,
 * shown to a planner, served by a cycle — the serving cycle is the "Open
 * cycle" target). Built from `broadcasts.jsonl`, the graph and the cycle log.
 */
import type { Broadcast } from '../../watcher/broadcast';
import type { Neuron } from '../../watcher/types';
import { type CycleRow, cycleAttribution } from '../cycle-index';
import type { Why } from '../types';

export interface BroadcastWhyInput {
  broadcast: Broadcast;
  /** The insight neuron it came from, when the graph still has it. */
  insight?: Neuron;
  /** The cycle-log row of `servedByCycle`, when it was found. */
  servedCycle?: CycleRow;
  botName?: string;
}

const day = (iso: string) => iso.slice(0, 10);

export function broadcastOutcome(b: Broadcast): string {
  if (!b.deliveredAt && b.deferred) {
    return `Held by the proactive throttle (${b.deliveryError ?? 'throttled'}); it may be proposed again later.`;
  }
  if (!b.deliveredAt) return `Not delivered: ${b.deliveryError ?? 'unknown reason'}.`;
  if (b.servedByCycle) return `Served by a cycle on ${day(b.servedAt ?? b.deliveredAt)}.`;
  if (b.shownAt) return `Shown to the planner on ${day(b.shownAt)}; not acted on.`;
  return 'Delivered; no planner has seen it yet.';
}

function whatOf(b: Broadcast, bot: string): string {
  switch (b.kind) {
    case 'wake':
      return `Woke ${bot}`;
    case 'directive':
      return `Directive to ${bot}: "${b.text}"`;
    case 'goal':
      return `Goal for ${bot}: "${b.text}"`;
    case 'question':
      return `Asked you, through ${bot}: "${b.text}"`;
  }
}

export function broadcastToWhy(input: BroadcastWhyInput): Why {
  const b = input.broadcast;
  const why: Why = { what: whatOf(b, input.botName ?? b.botId), by: 'watcher' };
  if (input.insight) {
    why.reason = { text: input.insight.text, source: 'Fleet watcher insight' };
  } else {
    why.missing = 'The insight this broadcast came from is no longer in the graph.';
  }
  if (b.servedByCycle) {
    const attribution = cycleAttribution(b.botId, { cycleId: b.servedByCycle }, input.servedCycle);
    if (attribution.cycle) why.cycle = attribution.cycle;
    if (attribution.goal) why.goal = attribution.goal;
  }
  why.outcome = broadcastOutcome(b);
  const notes: Array<{ label: string; text: string }> = [{ label: 'Created', text: b.createdAt }];
  if (b.delivery) notes.push({ label: 'Delivery', text: b.delivery });
  if (b.shownInCycle) notes.push({ label: 'Shown in cycle', text: b.shownInCycle });
  if (b.signal) notes.push({ label: 'Your signal', text: b.signal === 'up' ? '👍' : '👎' });
  why.notes = notes;
  return why;
}
