/**
 * Why for one agent-loop cycle (a group in the Agent Home timeline): the
 * cycle log row (`<data>/agent-cycles`) — plan, goal served, focus — and what
 * came of it. "Open cycle" in the panel shows the rest.
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

export function cycleToWhy({ botId, cycle }: CycleWhyInput): Why {
  const why: Why = { what: 'Agent-loop cycle', by: 'agent', cycle: toWhyCycle(botId, cycle) };
  if (cycle.goalTitle) {
    why.goal = { ...(cycle.goalId ? { id: cycle.goalId } : {}), title: cycle.goalTitle };
  }
  const focus = typeof cycle.focus === 'string' ? cycle.focus.trim() : '';
  if (focus) why.reason = { text: focus, source: 'Focus set for the cycle' };
  why.outcome = outcome(cycle);
  if (!cycle.goalTitle && cycle.status === 'completed') {
    why.missing = 'The cycle did not name a goal it served.';
  }
  return why;
}
