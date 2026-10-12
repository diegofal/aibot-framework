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

describe('goalEventToWhy: the stated reason (why-everywhere row 12)', () => {
  it('a recorded reason is the Reason row, sourced from who wrote it', () => {
    const cases: Array<[string, string]> = [
      ['strategist', 'Strategist'],
      ['curiosity', 'Navigator'],
      ['lint', 'Goal lint'],
      ['reflection', 'Reflection'],
      ['operator', 'You'],
      ['agent', 'Agent'],
    ];
    for (const [actor, source] of cases) {
      const why = goalEventToWhy(input({ actor, reason: 'Because.' }, { cycle: row }));
      expect(why.reason).toEqual({ text: 'Because.', source });
      expect(WhySchema.safeParse(why).success).toBe(true);
    }
  });

  it('a hygiene run id is a note', () => {
    const why = goalEventToWhy(
      input({ actor: 'lint', cycleId: null, reason: '"X" moved to Completed', runId: 'run-1' })
    );
    expect(why.notes).toEqual([{ label: 'Hygiene run', text: 'run-1' }]);
  });

  it('a strategist change without a reason says so plainly', () => {
    const why = goalEventToWhy(input({ actor: 'strategist' }, { cycle: row }));
    expect(why.reason).toBeUndefined();
    expect(why.missing).toContain('No reason was recorded');
  });
});

describe('goalEventToWhy: task-store rows', () => {
  it('a task move reads as a task move with the lanes, the task and its note', () => {
    const why = goalEventToWhy(
      input({
        op: 'task-move',
        from: 'todo',
        to: 'done',
        task: 'Draft the intro',
        note: 'sent to Ana',
      })
    );
    expect(why.what).toBe('Task moved to Done');
    expect(why.outcome).toBe('To do → Done');
    expect(why.notes).toEqual([
      { label: 'Task', text: 'Draft the intro' },
      { label: 'Notes', text: 'sent to Ana' },
    ]);
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('every task op has words, and a worker run is a note', () => {
    const ops = [
      'task-add',
      'task-edit',
      'task-note',
      'task-remove',
      'task-reorder',
      'task-claim',
      'task-release',
    ];
    for (const op of ops) {
      const why = goalEventToWhy(
        input({ op, from: null, to: null, runId: 'r-1', actor: 'system' })
      );
      expect(why.what).not.toContain('Changed (');
      expect(why.by).toBe('system');
      expect(why.notes).toContainEqual({ label: 'Worker run', text: 'r-1' });
      expect(WhySchema.safeParse(why).success).toBe(true);
    }
  });

  it('a task rename shows old → new text', () => {
    const why = goalEventToWhy(input({ op: 'task-edit', from: 'Draft', to: 'Draft v2' }));
    expect(why.outcome).toBe('Draft → Draft v2');
  });
});
