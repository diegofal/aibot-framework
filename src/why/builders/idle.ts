/**
 * Why for an idle cycle in the fleet feed (`agent:idle`): the planner's own
 * reasoning, and the engagement gate when it was the gate that held the plan
 * back. Built in the agent loop when the event is published, since the
 * activity stream lives in memory and has no endpoint of its own.
 */
import type { Why } from '../types';

export interface IdleWhyInput {
  botId: string;
  cycleId?: string;
  /** What the planner said. */
  reasoning?: string;
  /** Set when the hard engagement gate downgraded a content plan. */
  gate?: { outputCount: number; feedbackCount: number; plan: string[] };
}

const REASON_CHARS = 600;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function idleToWhy(input: IdleWhyInput): Why {
  const why: Why = { what: 'Idle cycle', by: input.gate ? 'system' : 'agent' };
  if (input.cycleId) why.cycle = { id: input.cycleId, botId: input.botId };
  const reasoning = input.reasoning?.replace(/\s+/g, ' ').trim();
  if (reasoning) why.reason = { text: clip(reasoning, REASON_CHARS), source: 'Planner' };
  if (input.gate) {
    const { outputCount, feedbackCount, plan } = input.gate;
    why.rule = `Engagement gate: ${outputCount} outputs and ${feedbackCount} feedback since your last response, so content plans wait until you react.`;
    why.outcome = 'The planned content was not run.';
    const held = plan.map((s) => s.trim()).filter(Boolean);
    if (held.length > 0) why.notes = [{ label: 'Held back', text: clip(held.join('; '), 300) }];
  } else {
    why.outcome = 'Nothing was run this cycle.';
  }
  const missing = [
    reasoning ? '' : 'The planner gave no reason.',
    input.cycleId ? '' : 'No cycle id was recorded with this event.',
  ].filter(Boolean);
  if (missing.length > 0) why.missing = missing.join(' ');
  return why;
}
