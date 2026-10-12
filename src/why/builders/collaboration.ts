/**
 * Why for a collaboration line in the fleet feed (`collab:start` /
 * `collab:end`) and for the `collaborateCompleted` outcome: which peer the
 * agent asked, the cycle (and its plan and goal, when the running cycle is
 * known) that started it, the opening message, and how it ended. Built in
 * `CollaborationManager` when the event is published, since the activity
 * stream lives in memory and has no endpoint of its own.
 */
import type { Why } from '../types';

export type CollaborationPhase = 'start' | 'end' | 'completed';

export interface CollaborationWhyInput {
  botId: string;
  targetBotId: string;
  targetName?: string;
  mode: 'visible' | 'internal' | 'mcp';
  phase: CollaborationPhase;
  /** The cycle that started the collaboration (`_cycleId` of the tool call). */
  cycleId?: string;
  goalId?: string;
  /** What the running cycle set out to do and the goal it serves, when known. */
  cycle?: { plan?: string; goalTitle?: string };
  /** The first message of the collaboration. */
  opening?: string;
  openedAt?: string;
  /** `end`: length of the peer's answer. */
  responseLength?: number;
  /** `completed`: turns the conversation took. */
  turns?: number;
}

/** Opening messages are clipped to this on the event and in the fold. */
export const COLLAB_OPENING_CHARS = 300;

export function clipOpening(s: string | undefined): string | undefined {
  const flat = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return undefined;
  return flat.length > COLLAB_OPENING_CHARS ? `${flat.slice(0, COLLAB_OPENING_CHARS - 1)}…` : flat;
}

function outcome(input: CollaborationWhyInput, peer: string): string {
  if (input.phase === 'completed') {
    const n = input.turns ?? 0;
    return `The conversation with ${peer} finished after ${n} turn${n === 1 ? '' : 's'}.`;
  }
  if (input.phase === 'end') {
    return typeof input.responseLength === 'number'
      ? `${peer} answered (${input.responseLength} characters).`
      : `${peer} answered.`;
  }
  return input.mode === 'visible'
    ? `Posted in the group chat; ${peer} answers there.`
    : `Waiting for ${peer}'s answer.`;
}

export function collaborationToWhy(input: CollaborationWhyInput): Why {
  const peer = input.targetName || input.targetBotId;
  const why: Why = { what: `Asked ${peer} for help`, by: 'agent' };
  if (input.cycleId) {
    why.cycle = { id: input.cycleId, botId: input.botId };
    const plan = input.cycle?.plan?.trim();
    if (plan) why.cycle.plan = plan;
    const goalTitle = input.cycle?.goalTitle?.trim();
    if (goalTitle) why.goal = { ...(input.goalId ? { id: input.goalId } : {}), title: goalTitle };
  }
  const opening = clipOpening(input.opening);
  if (opening) {
    why.related = {
      label: 'Opening message',
      items: [{ text: opening, ...(input.openedAt ? { at: input.openedAt } : {}) }],
    };
  }
  why.outcome = outcome(input, peer);
  const missing = [
    input.cycleId
      ? ''
      : 'Not asked during a work cycle (a chat), or before collaborations recorded their cycle.',
    opening ? '' : 'The opening message was not recorded.',
  ].filter(Boolean);
  if (missing.length > 0) why.missing = missing.join(' ');
  return why;
}
