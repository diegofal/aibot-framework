import { describe, expect, it } from 'bun:test';
import { workerRunToWhy } from '../../../src/why/builders/worker-run';
import { WhySchema } from '../../../src/why/types';
import type { JournalEntry, WorkerRunView } from '../../../src/workers/types';
import { whyPanel } from '../../../web/pages/why-helpers.js';

const run = (over: Partial<WorkerRunView> = {}): WorkerRunView => ({
  runId: 'run-1',
  botId: 'b1',
  taskId: 't-abc123',
  goalId: 'g-1',
  dispatchCycleId: 'c1',
  taskText: 'Summarise the findings',
  goalTitle: 'Research dark factories',
  status: 'done',
  attempt: 1,
  step: 2,
  budget: { steps: 8, toolCalls: 40, wallMs: 3_600_000 },
  used: { steps: 2, toolCalls: 5, wallMs: 840_000 },
  createdAt: '2026-10-12T10:00:00Z',
  startedAt: '2026-10-12T10:00:05Z',
  endedAt: '2026-10-12T10:14:05Z',
  lastReport: { kind: 'done', note: 'Summary saved to 03_summary.md' },
  outcome: { kind: 'done', note: 'Summary saved to 03_summary.md' },
  ...over,
});

const journal: JournalEntry[] = [
  { ts: '2026-10-12T10:00:05Z', runId: 'run-1', kind: 'run-start', attempt: 1 },
  { ts: '2026-10-12T10:00:06Z', runId: 'run-1', kind: 'step-start', n: 1 },
  { ts: '2026-10-12T10:07:00Z', runId: 'run-1', kind: 'step-end', n: 1, summary: 'Read 3 sources' },
  { ts: '2026-10-12T10:07:01Z', runId: 'run-1', kind: 'step-start', n: 2 },
  {
    ts: '2026-10-12T10:14:00Z',
    runId: 'run-1',
    kind: 'step-end',
    n: 2,
    summary: 'Wrote summary',
    error: 'one tool failed',
  },
];

describe('workerRunToWhy', () => {
  it('dispatching cycle, task and goal, steps, last report, outcome, budget', () => {
    const why = workerRunToWhy({
      run: run(),
      journal,
      cycle: {
        cycleId: 'c1',
        startedAt: '2026-10-12T09:59:00Z',
        planSummary: 'Dispatch summary task',
      },
    });
    expect(WhySchema.safeParse(why).success).toBe(true);
    expect(why.what).toBe('A worker run on "Summarise the findings"');
    expect(why.by).toBe('agent');
    expect(why.cycle).toMatchObject({ id: 'c1', plan: 'Dispatch summary task' });
    expect(why.goal).toEqual({ id: 'g-1', title: 'Research dark factories' });
    expect(why.related?.label).toBe('Steps');
    expect(why.related?.items.map((i) => i.text)).toEqual([
      'Step 1: Read 3 sources',
      'Step 2: Wrote summary',
    ]);
    expect(why.related?.items[1].detail).toBe('one tool failed');
    expect(why.outcome).toBe('Done: Summary saved to 03_summary.md');
    expect(why.notes).toContainEqual({
      label: 'Budget used',
      text: '2 of 8 steps · 5 of 40 tool calls · 14 of 60 min',
    });
    expect(why.notes).toContainEqual({ label: 'Task', text: 't-abc123' });
    expect(why.notes).toContainEqual({ label: 'Run', text: 'run-1 (attempt 1)' });
    expect(whyPanel(why)).toContain('data-open-cycle');
  });

  it('operator retry: no dispatching cycle, by you; running run shows where it is', () => {
    const why = workerRunToWhy({
      run: run({
        dispatchCycleId: null,
        status: 'waiting',
        attempt: 2,
        outcome: undefined,
        endedAt: undefined,
        lastReport: { kind: 'progress', note: 'Found 2 of 3' },
        wait: { kind: 'ask', id: 'q1', question: 'Which region?', since: '2026-10-12T10:10:00Z' },
      }),
    });
    expect(why.by).toBe('operator');
    expect(why.cycle).toBeUndefined();
    expect(why.rule).toContain('You started this run');
    expect(why.outcome).toBe('Waiting for your answer: Which region?');
    expect(why.notes).toContainEqual({ label: 'Last report', text: 'Progress: Found 2 of 3' });
    expect(why.related).toBeUndefined();
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('a dispatching cycle the log lost is said; a budget stop reads as such', () => {
    const why = workerRunToWhy({
      run: run({ status: 'stopped', outcome: { kind: 'budget', note: 'Steps used up' } }),
    });
    expect(why.cycle).toEqual({ id: 'c1', botId: 'b1' });
    expect(why.missing).toContain('no record of this cycle');
    expect(why.outcome).toBe('Stopped at its budget: Steps used up');
  });
});
