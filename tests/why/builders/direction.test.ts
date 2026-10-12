import { describe, expect, it } from 'bun:test';
import type { DirectionRecord } from '../../../src/bot/curiosity/types';
import { directionToWhy } from '../../../src/why/builders/direction';
import { WhySchema } from '../../../src/why/types';

const record = (over: Partial<DirectionRecord> = {}): DirectionRecord => ({
  runId: 'run-1',
  at: '2026-10-11T12:00:00.000Z',
  summary: 'From harness noise to reranker variance.',
  retrospective: 'Two notes landed, one went nowhere.',
  bets: [
    { id: 'b1', title: 'Rerankers', kind: 'explore', rationale: 'could invert rankings' },
    { id: 'b2', title: 'Finish the harness note', kind: 'exploit', rationale: 'it landed' },
  ],
  learned: ['retries inflate pass@1'],
  surprised: ['k=8 beats a stronger model'],
  trigger: { kind: 'due', everyHours: 24, lastRunAt: '2026-10-10T11:00:00.000Z' },
  ...over,
});

describe('directionToWhy', () => {
  it('the navigator set it; the retrospective is the reason; the bets are the outcome', () => {
    const why = directionToWhy({ botId: 'b1', direction: record() });
    expect(WhySchema.safeParse(why).success).toBe(true);
    expect(why.what).toBe('A new direction for its exploration');
    expect(why.by).toBe('navigator');
    expect(why.reason).toEqual({
      text: 'Two notes landed, one went nowhere.',
      source: 'Navigator retrospective',
    });
    expect(why.related?.items).toEqual([
      { text: 'retries inflate pass@1', detail: 'learned' },
      { text: 'k=8 beats a stronger model', detail: 'surprised it' },
    ]);
    expect(why.outcome).toBe('Bets: explore “Rerankers”; exploit “Finish the harness note”.');
    expect(why.missing).toBeUndefined();
  });

  it('says what triggered the run', () => {
    expect(directionToWhy({ botId: 'b1', direction: record() }).rule).toBe(
      'Due: the navigator runs every 24 h; the previous direction was set 2026-10-10 11:00 UTC.'
    );
    expect(
      directionToWhy({
        botId: 'b1',
        direction: record({ trigger: { kind: 'first', everyHours: 24 } }),
      }).rule
    ).toBe('First run: it had never set a direction.');
    expect(
      directionToWhy({
        botId: 'b1',
        direction: record({
          trigger: { kind: 'retry', everyHours: 24, failedAttemptAt: '2026-10-11T09:30:00.000Z' },
        }),
      }).rule
    ).toBe('Retry: the attempt at 2026-10-11 09:30 UTC failed, so it ran again after the backoff.');
  });

  it('no trigger, nothing learned: no rule, no related, says so', () => {
    const why = directionToWhy({
      botId: 'b1',
      direction: record({ trigger: undefined, learned: [], surprised: [], bets: [] }),
    });
    expect(WhySchema.safeParse(why).success).toBe(true);
    expect(why.rule).toBeUndefined();
    expect(why.related).toBeUndefined();
    expect(why.outcome).toBeUndefined();
    expect(why.missing).toBe('No record of what triggered this run.');
  });

  it("notes the operator's verdict and the frontier it changed", () => {
    const why = directionToWhy({
      botId: 'b1',
      direction: {
        ...record({ frontierAdded: ['a', 'b'], frontierDropped: ['c'] }),
        operatorSignal: 'down',
      },
    });
    expect(why.notes).toEqual([
      { label: 'Frontier', text: 'Added 2 questions, dropped 1.' },
      { label: 'Your verdict', text: 'You asked it to rethink this direction.' },
    ]);
  });
});
