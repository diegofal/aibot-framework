import { describe, expect, test } from 'bun:test';
import { KarmaConfigSchema } from '../../src/config';
import { DEFAULT_KARMA_REWARDS, KARMA_KIND_SOURCE } from '../../src/karma/types';
import { createWorkerKarmaListener } from '../../src/workers/karma';
import type { WorkerEvent, WorkerOutcomeKind } from '../../src/workers/types';

function ended(kind: WorkerOutcomeKind, note = 'n', type: WorkerEvent['type'] = 'worker:ended') {
  return {
    type,
    botId: 'b1',
    timestamp: 1,
    data: {
      runId: 'r-1',
      taskId: 't-1',
      goalId: 'g-1',
      status: 'done',
      step: 2,
      budget: { steps: 8, toolCalls: 40, wallMs: 1 },
      used: { steps: 2, toolCalls: 3, wallMs: 1 },
      outcome: { kind, note },
    },
  } as WorkerEvent;
}

function karma() {
  const calls: Array<[string, string, string, Record<string, unknown> | undefined]> = [];
  return {
    calls,
    svc: {
      recordOutcome: (
        botId: string,
        kind: string,
        reason: string,
        meta?: Record<string, unknown>
      ) => {
        calls.push([botId, kind, reason, meta]);
        return null;
      },
    },
  };
}

describe('worker karma kinds', () => {
  test('workerProtocol costs like a tool error; workerDone is 0 and configurable', () => {
    expect(DEFAULT_KARMA_REWARDS.workerProtocol).toBe(-1);
    expect(DEFAULT_KARMA_REWARDS.workerDone).toBe(0);
    expect(KARMA_KIND_SOURCE.workerProtocol).toBe('tool');
    expect(KARMA_KIND_SOURCE.workerDone).toBe('agent-loop');
    const cfg = KarmaConfigSchema.parse({ rewards: { workerDone: 2 } });
    expect(cfg.rewards.workerDone).toBe(2);
    expect(cfg.rewards.workerProtocol).toBe(-1);
  });
});

describe('createWorkerKarmaListener', () => {
  test('protocol → workerProtocol with run, task and goal in the metadata', () => {
    const { svc, calls } = karma();
    createWorkerKarmaListener(svc)(ended('protocol', 'Step ended without a report tool'));
    expect(calls).toEqual([
      [
        'b1',
        'workerProtocol',
        'Worker broke the step protocol: Step ended without a report tool',
        { runId: 'r-1', taskId: 't-1', goalId: 'g-1' },
      ],
    ]);
  });

  test('done with a note → workerDone; done without a note → nothing', () => {
    const { svc, calls } = karma();
    const listen = createWorkerKarmaListener(svc);
    listen(ended('done', 'Published the summary'));
    listen(ended('done', '   '));
    expect(calls.map((c) => [c[1], c[2]])).toEqual([
      ['workerDone', 'Task done: Published the summary'],
    ]);
  });

  test('failed, blocked, budget, stopped and non-ended events record nothing', () => {
    const { svc, calls } = karma();
    const listen = createWorkerKarmaListener(svc);
    for (const k of ['failed', 'blocked', 'budget', 'stopped', 'interrupted'] as const)
      listen(ended(k));
    listen(ended('protocol', 'x', 'worker:step'));
    expect(calls).toEqual([]);
  });

  test('a throwing karma service never escapes', () => {
    const listen = createWorkerKarmaListener({
      recordOutcome: () => {
        throw new Error('disk full');
      },
    });
    expect(() => listen(ended('protocol'))).not.toThrow();
  });
});
