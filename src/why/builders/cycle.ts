/**
 * Why for one agent-loop cycle (a group in the Agent Home timeline): the
 * cycle log row (`<data>/agent-cycles`) — plan, goal served, focus — and what
 * came of it. Idle/skipped/error cycles explain themselves with the `reason`
 * the row recorded (planner reasoning → Reason; engagement gate or circuit
 * breaker → Rule; error → note); a strategist pass adds its reflection and the
 * trait deltas it applied. "Open cycle" in the panel shows the rest.
 */
import type { AgentCycleRecord } from '../../stats/readers/agent-cycles';
import { toWhyCycle } from '../cycle-index';
import type { Why } from '../types';

export interface CycleWhyInput {
  botId: string;
  cycle: AgentCycleRecord;
}

function outcome(c: AgentCycleRecord): string {
  switch (c.status) {
    case 'idle':
      return 'Idle: it planned nothing to run.';
    case 'skipped':
      return 'Skipped before planning.';
    case 'error':
      return 'Ended with an error.';
    default: {
      const n = Number(c.toolCalls) || 0;
      if (n === 0) return 'Completed without tool calls.';
      const tools = Array.isArray(c.tools) && c.tools.length ? ` (${c.tools.join(', ')})` : '';
      return `Completed with ${n} tool call${n === 1 ? '' : 's'}${tools}.`;
    }
  }
}

/** A recorded rule-like reason (`circuit-open:<backend>`, gate verdict) in plain words. */
export function cycleRuleText(reason: string, source: string | undefined): string {
  if (source === 'circuit-breaker') {
    const backend = reason.startsWith('circuit-open:')
      ? reason.slice('circuit-open:'.length)
      : reason;
    return `The ${backend} circuit breaker was open after repeated quota/429 errors, so the cycle sat out.`;
  }
  return reason;
}

const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;

/** `caution +0.03, depth −0.02` */
export function traitDeltaText(deltas: Record<string, number>): string {
  return Object.entries(deltas)
    .filter(([, v]) => Number.isFinite(Number(v)) && Number(v) !== 0)
    .map(([k, v]) => `${k} ${signed(Number(v))}`)
    .join(', ');
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function cycleToWhy({ botId, cycle }: CycleWhyInput): Why {
  const why: Why = { what: 'Agent-loop cycle', by: 'agent', cycle: toWhyCycle(botId, cycle) };
  if (cycle.goalTitle) {
    why.goal = { ...(cycle.goalId ? { id: cycle.goalId } : {}), title: cycle.goalTitle };
  }
  const notes: Array<{ label: string; text: string }> = [];
  const focus = text(cycle.focus);
  const reason = text(cycle.reason);
  const source = cycle.reasonSource;
  if (reason && source === 'planner') {
    why.reason = { text: reason, source: 'Planner' };
    if (focus) notes.push({ label: 'Focus', text: focus });
  } else if (focus) {
    why.reason = { text: focus, source: 'Focus set for the cycle' };
  }
  if (reason && source === 'error') notes.unshift({ label: 'Error', text: reason });
  else if (reason && source !== 'planner') why.rule = cycleRuleText(reason, source);
  why.outcome = outcome(cycle);
  const reflection = text(cycle.reflection);
  if (reflection) notes.push({ label: 'Strategist reflection', text: reflection });
  const traits = cycle.traitAdjustments ? traitDeltaText(cycle.traitAdjustments) : '';
  if (traits) notes.push({ label: 'Traits adjusted', text: traits });
  if (notes.length > 0) why.notes = notes;
  if (!cycle.goalTitle && cycle.status === 'completed') {
    why.missing = 'The cycle did not name a goal it served.';
  } else if (!reason && (cycle.status === 'idle' || cycle.status === 'skipped')) {
    why.missing = `No reason was recorded for this ${cycle.status} cycle (rows before 2026-10-12 did not keep one).`;
  }
  return why;
}
