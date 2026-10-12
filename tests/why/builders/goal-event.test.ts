import { describe, expect, it } from 'bun:test';
import {
  type GoalEventWhyInput,
  goalActorToWhy,
  goalEventToWhy,
} from '../../../src/why/builders/goal-event';
import { WhySchema } from '../../../src/why/types';

const input = (
  event: Partial<GoalEventWhyInput['event']> = {},
  over: Partial<GoalEventWhyInput> = {}
): GoalEventWhyInput => ({
  botId: 'b1',
  event: {
    ts: '2026-10-11T12:00:00Z',
    op: 'status',
    from: 'pending',
    to: 'in_progress',
    actor: 'agent',
    cycleId: 'c-1',
    inferred: false,
    note: null,
    ...event,
  },
  ...over,
});

const row = {
  cycleId: 'c-1',
  startedAt: '2026-10-11T11:59:00Z',
  endedAt: '2026-10-11T12:01:00Z',
  planSummary: 'Draft the October lab',
};

describe('goalEventToWhy', () => {
  it('says the op in words, who did it, the cycle with its plan and from → to', () => {
    const why = goalEventToWhy(input({}, { cycle: row }));
    expect(WhySchema.safeParse(why).success).toBe(true);
    expect(why.what).toBe('Moved to In progress');
    expect(why.by).toBe('agent');
    expect(why.cycle).toEqual({
      id: 'c-1',
      botId: 'b1',
      startedAt: row.startedAt,
      plan: 'Draft the October lab',
    });
    expect(why.outcome).toBe('To do → In progress');
    expect(why.reason).toBeUndefined();
    expect(why.missing).toBeUndefined();
  });

  it('names every op', () => {
    const what = (op: string, to?: string) =>
      goalEventToWhy(input({ op, to: to ?? null, from: null })).what;
    expect(what('add')).toBe('Goal added');
    expect(what('complete')).toBe('Completed');
    expect(what('reopen')).toBe('Reopened');
    expect(what('remove')).toBe('Removed');
    expect(what('priority')).toBe('Priority changed');
    expect(what('notes')).toBe('Notes edited');
    expect(what('title')).toBe('Renamed');
    expect(what('headline')).toBe('Short title changed');
    expect(what('tasks')).toBe('Subtasks updated');
    expect(what('status', 'blocked')).toBe('Moved to Blocked');
    expect(what('status')).toBe('Status changed');
    expect(what('frobnicate')).toBe('Changed (frobnicate)');
  });

  it('maps goal-event actors to Why actors; the wizard is the operator', () => {
    expect(goalActorToWhy('strategist')).toBe('strategist');
    expect(goalActorToWhy('curiosity')).toBe('curiosity');
    expect(goalActorToWhy('reflection')).toBe('reflection');
    expect(goalActorToWhy('lint')).toBe('lint');
    expect(goalActorToWhy('operator')).toBe('operator');
    expect(goalActorToWhy('wizard')).toBe('operator');
    expect(goalActorToWhy('tool')).toBe('agent');
    expect(goalActorToWhy('unknown')).toBeUndefined();
    expect(goalActorToWhy(null)).toBeUndefined();
  });

  it('keeps a recorded cycle the log no longer has, and says the plan is unknown', () => {
    const why = goalEventToWhy(input());
    expect(why.cycle).toEqual({ id: 'c-1', botId: 'b1' });
    expect(why.missing).toContain('cycle log has no record');
  });

  it('says plainly when a loop actor changed it with no cycle recorded', () => {
    const why = goalEventToWhy(input({ cycleId: null, actor: 'strategist' }));
    expect(why.cycle).toBeUndefined();
    expect(why.missing).toContain('No cycle was recorded');
  });

  it('an operator change needs no cycle', () => {
    const why = goalEventToWhy(
      input({ cycleId: null, actor: 'operator', op: 'add', to: 'pending', from: null })
    );
    expect(why.by).toBe('operator');
    expect(why.missing).toBeUndefined();
    expect(why.outcome).toBe('Added as To do');
  });

  it('labels events reconstructed from the tool audit, with their notes', () => {
    const why = goalEventToWhy(
      input({ inferred: true, cycleId: null, actor: 'tool', note: 'Halfway there' })
    );
    expect(why.by).toBe('agent');
    expect(why.missing).toContain('Reconstructed from a manage_goals call');
    expect(why.notes).toEqual([{ label: 'Notes', text: 'Halfway there' }]);
  });

  it('subtask tallies and priorities read as from → to', () => {
    expect(goalEventToWhy(input({ op: 'tasks', from: '1/3', to: '2/3' })).outcome).toBe(
      '1/3 → 2/3 subtasks done'
    );
    expect(goalEventToWhy(input({ op: 'priority', from: 'medium', to: 'high' })).outcome).toBe(
      'medium → high'
    );
    expect(goalEventToWhy(input({ op: 'notes', from: null, to: null })).outcome).toBeUndefined();
  });
});
