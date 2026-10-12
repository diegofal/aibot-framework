import { describe, expect, it } from 'bun:test';
import type { ProductionEntry } from '../../../src/productions/types';
import {
  fileHistory,
  productionOutcome,
  productionToWhy,
} from '../../../src/why/builders/production';
import type { CycleRow } from '../../../src/why/cycle-index';
import { WhySchema } from '../../../src/why/types';

const entry = (over: Partial<ProductionEntry> = {}): ProductionEntry => ({
  id: 'e1',
  timestamp: '2026-10-11T12:01:00.000Z',
  botId: 'b1',
  tool: 'file_write',
  path: 'reports/01_market.md',
  action: 'create',
  description: 'Market scan',
  size: 120,
  trackOnly: false,
  ...over,
});

const cycle: CycleRow = {
  cycleId: 'c-1',
  startedAt: '2026-10-11T12:00:00.000Z',
  endedAt: '2026-10-11T12:05:00.000Z',
  planSummary: 'Scan the market',
  goalId: 'g-1',
  goalTitle: 'Map the market',
};

describe('productionToWhy', () => {
  it('names the tool, the cycle, its plan and goal, and the review state', () => {
    const why = productionToWhy({ entry: entry({ cycleId: 'c-1', goalId: 'g-1' }), cycle });
    expect(why).toEqual({
      what: 'Created with file_write',
      by: 'agent',
      cycle: {
        id: 'c-1',
        botId: 'b1',
        startedAt: '2026-10-11T12:00:00.000Z',
        plan: 'Scan the market',
      },
      goal: { id: 'g-1', title: 'Map the market' },
      outcome: 'Waiting for your review.',
    });
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('for an edited file, lists when and how it was created', () => {
    const created = entry({ id: 'e0', timestamp: '2026-10-10T09:00:00.000Z', cycleId: 'c-0' });
    const createdCycle: CycleRow = { ...cycle, cycleId: 'c-0', planSummary: 'First draft' };
    const why = productionToWhy({
      entry: entry({ action: 'edit', tool: 'file_edit', cycleId: 'c-1' }),
      cycle,
      created,
      createdCycle,
      edits: 3,
    });
    expect(why.what).toBe('Last edited with file_edit');
    expect(why.related).toEqual({
      label: 'History',
      items: [
        { text: 'Created with file_write', at: '2026-10-10T09:00:00.000Z', detail: 'First draft' },
      ],
      note: 'Edited 3 times since.',
    });
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('says plainly when no cycle was recorded', () => {
    const why = productionToWhy({ entry: entry() });
    expect(why.cycle).toBeUndefined();
    expect(why.missing).toContain('No record of a work cycle');
  });

  it('keeps a recorded cycle the log has no row for', () => {
    const why = productionToWhy({ entry: entry({ cycleId: 'c-9' }) });
    expect(why.cycle).toEqual({ id: 'c-9', botId: 'b1' });
    expect(why.missing).toContain('cycle log has no row');
  });
});

describe('productionOutcome', () => {
  it('reports the verdict, a stale verdict, or the wait', () => {
    expect(
      productionOutcome(
        entry({ evaluation: { status: 'approved', evaluatedAt: '2026-10-11T13:00:00.000Z' } })
      )
    ).toBe('You approved it on 2026-10-11.');
    expect(
      productionOutcome(
        entry({ evaluation: { status: 'rejected', evaluatedAt: '2026-10-11T13:00:00.000Z' } })
      )
    ).toBe('You rejected it on 2026-10-11.');
    expect(
      productionOutcome(entry({ action: 'edit' }), {
        status: 'approved',
        at: '2026-10-09T08:00:00.000Z',
      })
    ).toBe(
      'You approved an earlier version on 2026-10-09; it edited the file since, so it waits for your review again.'
    );
    expect(productionOutcome(entry())).toBe('Waiting for your review.');
  });
});

describe('fileHistory', () => {
  const norm = (p: string) => p.replace(/^\/abs\//, '');
  it('finds the latest creation before the entry and counts the edits since', () => {
    const rows = [
      entry({ id: 'old', timestamp: '2026-10-01T00:00:00Z' }),
      entry({ id: 'arch', action: 'archive', timestamp: '2026-10-02T00:00:00Z' }),
      entry({ id: 'c', path: '/abs/reports/01_market.md', timestamp: '2026-10-03T00:00:00Z' }),
      entry({ id: 'e1', action: 'edit', timestamp: '2026-10-04T00:00:00Z' }),
      entry({ id: 'e2', action: 'edit', timestamp: '2026-10-05T00:00:00Z' }),
      entry({ id: 'other', path: 'x.md', action: 'edit', timestamp: '2026-10-05T00:00:00Z' }),
    ];
    const latest = rows[4];
    const h = fileHistory(rows, latest, norm);
    expect(h.created?.id).toBe('c');
    expect(h.edits).toBe(2);
  });
  it('a creation row is its own history', () => {
    const e = entry();
    expect(fileHistory([e], e)).toEqual({ created: undefined, edits: 0, priorVerdict: null });
  });
  it('remembers the verdict an earlier version got', () => {
    const first = entry({
      evaluation: { status: 'rejected', evaluatedAt: '2026-10-11T12:30:00.000Z' },
    });
    const edit = entry({ id: 'e2', action: 'edit', timestamp: '2026-10-11T13:00:00.000Z' });
    expect(fileHistory([first, edit], edit).priorVerdict).toEqual({
      status: 'rejected',
      at: '2026-10-11T12:30:00.000Z',
    });
  });
});
