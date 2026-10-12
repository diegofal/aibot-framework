import { describe, expect, it } from 'bun:test';
import { type TraitChangeWhyInput, traitChangeToWhy } from '../../../src/why/builders/trait-change';
import { WhySchema } from '../../../src/why/types';

const input = (
  change: Partial<TraitChangeWhyInput['change']> = {},
  over: Partial<TraitChangeWhyInput> = {}
): TraitChangeWhyInput => ({
  botId: 'b1',
  change: {
    ts: '2026-10-12T10:00:00.000Z',
    source: 'strategist',
    cycleId: 'c-1',
    changes: [{ trait: 'caution', from: 0.5, to: 0.53, requested: 0.03 }],
    rejected: [],
    reasons: { caution: 'web_fetch failed on the same host three times.' },
    derived: false,
    ...change,
  },
  ...over,
});

const row = { cycleId: 'c-1', startedAt: '2026-10-12T09:59:00.000Z', planSummary: 'Draft the lab' };

describe('traitChangeToWhy', () => {
  it('which trait moved by how much, the stated reason, the cycle', () => {
    const why = traitChangeToWhy(input({}, { cycle: row }));
    expect(why).toEqual({
      what: 'Trait adjusted: caution +0.03',
      by: 'strategist',
      cycle: { id: 'c-1', botId: 'b1', startedAt: row.startedAt, plan: 'Draft the lab' },
      reason: { text: 'web_fetch failed on the same host three times.', source: 'Strategist' },
      outcome: 'caution 0.50 → 0.53',
    });
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('several traits: each reason is named; a capped delta says the cap', () => {
    const why = traitChangeToWhy(
      input({
        changes: [
          { trait: 'caution', from: 0.5, to: 0.53, requested: 0.03 },
          { trait: 'depth', from: 0.5, to: 0.55, requested: 0.2 },
        ],
        reasons: { caution: 'Errors.', depth: 'Shallow work rejected.' },
      })
    );
    expect(why.what).toBe('Traits adjusted: caution +0.03, depth +0.05');
    expect(why.reason).toEqual({
      text: 'caution: Errors. · depth: Shallow work rejected.',
      source: 'Strategist',
    });
    expect(why.rule).toBe(
      'depth: asked +0.20, applied +0.05 (capped per pass or by the 0.1–0.9 range).'
    );
  });

  it('pinned and locked refusals are a rule, said as the operator policy', () => {
    const why = traitChangeToWhy(
      input({
        changes: [],
        rejected: [
          { trait: 'sociability', requested: 0.03, rule: 'locked' },
          { trait: 'depth', requested: -0.02, rule: 'pinned' },
        ],
        reasons: { sociability: 'More outreach.' },
      })
    );
    expect(why.what).toBe('Trait proposal refused: sociability, depth');
    expect(why.rule).toBe(
      'sociability is locked by you, so +0.03 was ignored. depth is pinned by you, so −0.02 was ignored.'
    );
    expect(why.outcome).toBe('Nothing changed.');
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('no reason, no cycle row, reconstructed from snapshots: said plainly', () => {
    const why = traitChangeToWhy(input({ reasons: {}, derived: true, cycleId: null }));
    expect(why.reason).toBeUndefined();
    expect(why.missing).toContain('No reason was recorded');
    expect(why.missing).toContain('Reconstructed from two consecutive trait snapshots');
    const noRow = traitChangeToWhy(input());
    expect(noRow.cycle).toEqual({ id: 'c-1', botId: 'b1' });
    expect(noRow.missing).toContain('cycle log has no record');
  });

  it('an operator pin applied on load reads as the operator', () => {
    const why = traitChangeToWhy(
      input({
        source: 'pinned',
        cycleId: null,
        reasons: {},
        changes: [{ trait: 'depth', from: 0.5, to: 0.8 }],
      })
    );
    expect(why.by).toBe('operator');
    expect(why.rule).toBe('Pinned by you in the agent config.');
    expect(why.missing).toBeUndefined();
  });
});
