import { describe, expect, it } from 'bun:test';
import { collaborationToWhy } from '../../../src/why/builders/collaboration';
import { WhySchema } from '../../../src/why/types';

const base = {
  botId: 'b1',
  targetBotId: 'b2',
  targetName: 'Researcher',
  mode: 'internal' as const,
  cycleId: 'c1',
  goalId: 'g1',
  opening: 'Can you find the latest numbers on X?',
  openedAt: '2026-10-11T12:00:00.000Z',
};

describe('collaborationToWhy', () => {
  it('asked a peer during a cycle: the cycle, plan, goal and the opening message', () => {
    const w = collaborationToWhy({
      ...base,
      phase: 'start',
      cycle: { plan: 'Research X', goalTitle: 'Understand X' },
    });
    expect(w).toEqual({
      what: 'Asked Researcher for help',
      by: 'agent',
      cycle: { id: 'c1', botId: 'b1', plan: 'Research X' },
      goal: { id: 'g1', title: 'Understand X' },
      related: {
        label: 'Opening message',
        items: [{ text: 'Can you find the latest numbers on X?', at: '2026-10-11T12:00:00.000Z' }],
      },
      outcome: "Waiting for Researcher's answer.",
    });
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('how it ended: an answer, a visible post, a finished conversation', () => {
    expect(collaborationToWhy({ ...base, phase: 'end', responseLength: 420 }).outcome).toBe(
      'Researcher answered (420 characters).'
    );
    expect(collaborationToWhy({ ...base, phase: 'start', mode: 'visible' }).outcome).toBe(
      'Posted in the group chat; Researcher answers there.'
    );
    expect(collaborationToWhy({ ...base, phase: 'completed', turns: 3 }).outcome).toBe(
      'The conversation with Researcher finished after 3 turns.'
    );
    expect(collaborationToWhy({ ...base, phase: 'completed', turns: 1 }).outcome).toBe(
      'The conversation with Researcher finished after 1 turn.'
    );
  });

  it('outside a cycle and without an opening: says what is missing; peer id when no name', () => {
    const w = collaborationToWhy({
      botId: 'b1',
      targetBotId: 'b2',
      mode: 'mcp',
      phase: 'start',
    });
    expect(w.what).toBe('Asked b2 for help');
    expect(w.cycle).toBeUndefined();
    expect(w.related).toBeUndefined();
    expect(w.missing).toBe(
      'Not asked during a work cycle (a chat), or before collaborations recorded their cycle. The opening message was not recorded.'
    );
    expect(WhySchema.safeParse(w).success).toBe(true);
  });

  it('a goal id without a title is not shown as a goal', () => {
    const w = collaborationToWhy({ ...base, phase: 'start' });
    expect(w.goal).toBeUndefined();
    expect(w.cycle).toEqual({ id: 'c1', botId: 'b1' });
  });

  it('clips a long opening message', () => {
    const w = collaborationToWhy({ ...base, phase: 'start', opening: 'y'.repeat(900) });
    expect(w.related?.items[0].text.length).toBe(300);
    expect(w.related?.items[0].text).toEndWith('…');
  });
});
