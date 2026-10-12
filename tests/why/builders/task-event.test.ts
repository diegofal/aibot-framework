import { describe, expect, it } from 'bun:test';
import { type TaskEventWhyInput, taskEventToWhy } from '../../../src/why/builders/task-event';
import { WhySchema } from '../../../src/why/types';

const base = (over: Partial<TaskEventWhyInput['event']> = {}): TaskEventWhyInput => ({
  botId: 'b1',
  event: {
    ts: '2026-10-12T10:00:00Z',
    op: 'task-move',
    from: 'in_progress',
    to: 'done',
    actor: 'agent',
    cycleId: null,
    runId: null,
    taskId: 't-abc123',
    task: 'Summarise the findings',
    note: null,
    ...over,
  },
});

describe('taskEventToWhy', () => {
  it('a move: what happened to which task, by whom, from → to', () => {
    const why = taskEventToWhy(base());
    expect(WhySchema.safeParse(why).success).toBe(true);
    expect(why.what).toBe('Task moved to Done: "Summarise the findings"');
    expect(why.by).toBe('agent');
    expect(why.outcome).toBe('In progress → Done');
    expect(why.notes).toEqual([{ label: 'Task', text: 't-abc123' }]);
  });

  it('a worker run: the run as a note and the dispatching cycle when recorded', () => {
    const why = taskEventToWhy({
      ...base({ actor: 'system', runId: 'run-9', note: 'Published: link', cycleId: 'c1' }),
      cycle: { cycleId: 'c1', startedAt: '2026-10-12T09:59:00Z', planSummary: 'Plan P' },
    });
    expect(why.by).toBe('agent');
    expect(why.cycle).toMatchObject({ id: 'c1', plan: 'Plan P' });
    expect(why.notes).toEqual([
      { label: 'Task', text: 't-abc123' },
      { label: 'Note', text: 'Published: link' },
      { label: 'Worker run', text: 'run-9' },
    ]);
    expect(why.missing).toBeUndefined();
  });

  it('claims and releases in words; the operator taking a task back says so', () => {
    expect(taskEventToWhy(base({ op: 'task-claim', actor: 'system', runId: 'r1' })).what).toBe(
      'A worker run picked up "Summarise the findings"'
    );
    const back = taskEventToWhy(
      base({ op: 'task-release', actor: 'operator', runId: 'r1', from: 'in_progress', to: 'todo' })
    );
    expect(back.what).toBe('You took "Summarise the findings" back from a worker run');
    expect(back.by).toBe('operator');
  });

  it('a cycle id with no log row says so; the goal is shown when given', () => {
    const why = taskEventToWhy({
      ...base({ op: 'task-add', from: null, to: 'todo', cycleId: 'c-gone' }),
      goal: { id: 'g-1', title: 'Research' },
    });
    expect(why.what).toBe('Task added: "Summarise the findings"');
    expect(why.goal).toEqual({ id: 'g-1', title: 'Research' });
    expect(why.cycle).toEqual({ id: 'c-gone', botId: 'b1' });
    expect(why.missing).toContain('no record of this cycle');
    expect(why.outcome).toBe('Added as To do');
  });

  it('system housekeeping (migration) reads as the system', () => {
    const why = taskEventToWhy(base({ op: 'task-add', actor: 'system', from: null, to: 'todo' }));
    expect(why.by).toBe('system');
    expect(WhySchema.safeParse(why).success).toBe(true);
  });
});
