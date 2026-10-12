import { describe, expect, it } from 'bun:test';
import type { KarmaEvent } from '../../../src/karma/types';
import { karmaEventToWhy } from '../../../src/why/builders/karma';
import { WhySchema } from '../../../src/why/types';

const event = (over: Partial<KarmaEvent> = {}): KarmaEvent => ({
  id: 'k1',
  botId: 'b1',
  timestamp: '2026-10-11T12:00:30Z',
  delta: -1,
  reason: 'Tool error: web_fetch — 500',
  source: 'tool',
  kind: 'toolError',
  metadata: { cycleId: 'c-1', goalId: 'g-1' },
  ...over,
});

const row = {
  cycleId: 'c-1',
  startedAt: '2026-10-11T12:00:00Z',
  endedAt: '2026-10-11T12:01:00Z',
  planSummary: 'Fetch the job boards',
  goalId: 'g-1',
  goalTitle: 'Find remote roles',
};

describe('karmaEventToWhy', () => {
  it('says the kind in words, the cycle with plan and goal, and the delta as outcome', () => {
    const why = karmaEventToWhy({ event: event(), cycle: row });
    expect(WhySchema.safeParse(why).success).toBe(true);
    expect(why.what).toBe('A tool call failed');
    expect(why.by).toBe('agent');
    expect(why.cycle).toEqual({
      id: 'c-1',
      botId: 'b1',
      startedAt: row.startedAt,
      plan: 'Fetch the job boards',
    });
    expect(why.goal).toEqual({ id: 'g-1', title: 'Find remote roles' });
    expect(why.rule).toBeString();
    expect(why.outcome).toBe('−1 karma: Tool error: web_fetch — 500');
    expect(why.missing).toBeUndefined();
  });

  it('keeps the cycle id when the cycle log has no row for it', () => {
    const why = karmaEventToWhy({ event: event() });
    expect(why.cycle).toEqual({ id: 'c-1', botId: 'b1' });
    expect(why.goal).toBeUndefined();
    expect(why.missing).toContain('cycle log has no record');
  });

  it('a cycle kind without a cycle says so', () => {
    const why = karmaEventToWhy({
      event: event({ kind: 'novelAction', source: 'agent-loop', delta: 1, metadata: undefined }),
    });
    expect(why.what).toContain('cycle');
    expect(why.missing).toContain('No record of the cycle');
    expect(why.outcome).toStartWith('+1 karma');
  });

  it('a tool error outside a cycle says it may have come from a conversation', () => {
    const why = karmaEventToWhy({ event: event({ metadata: undefined }) });
    expect(why.missing).toContain('conversation');
  });

  it('kinds no cycle produces never claim a missing cycle', () => {
    const why = karmaEventToWhy({
      event: event({
        kind: 'humanReply',
        source: 'engagement',
        delta: 3,
        reason: 'Human replied',
        metadata: { feedbackSource: 'human_message' },
      }),
    });
    expect(why.missing).toBeUndefined();
    expect(why.cycle).toBeUndefined();
  });

  it('manual adjustments are by the operator', () => {
    const why = karmaEventToWhy({
      event: event({
        kind: undefined,
        source: 'manual',
        delta: 5,
        reason: 'Good week',
        metadata: undefined,
      }),
    });
    expect(why.what).toBe('Manual adjustment');
    expect(why.by).toBe('operator');
    expect(why.missing).toBeUndefined();
    expect(why.outcome).toBe('+5 karma: Good week');
  });

  it('a production verdict links the production', () => {
    const why = karmaEventToWhy({
      event: event({
        kind: 'productionApproved',
        source: 'production',
        delta: 3,
        reason: 'Production approved: "05_lab.md"',
        metadata: { path: '05_lab.md', rating: 5 },
      }),
    });
    expect(why.by).toBe('operator');
    expect(why.related).toEqual({
      label: 'Production',
      items: [{ text: '05_lab.md', href: '#/work/productions/b1?file=05_lab.md' }],
    });
  });

  it('productions archived unread list every path', () => {
    const why = karmaEventToWhy({
      event: event({
        kind: 'productionIgnored',
        source: 'production',
        reason: '2 production(s) archived unread',
        metadata: { count: 2, paths: ['a.md', 'b.md'] },
      }),
    });
    expect(why.related?.label).toBe('Productions');
    expect(why.related?.items.map((i) => i.text)).toEqual(['a.md', 'b.md']);
    expect(why.missing).toBeUndefined();
  });

  it('a repeated-action penalty (no kind) is a cycle event', () => {
    const why = karmaEventToWhy({
      event: event({
        kind: undefined,
        source: 'agent-loop',
        delta: -2,
        reason: 'Repeated action: search jobs',
      }),
      cycle: row,
    });
    expect(why.what).toBe('A cycle repeated a recent plan');
    expect(why.by).toBe('agent');
    expect(why.rule).toContain('repeats');
  });
});
