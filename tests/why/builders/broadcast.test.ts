import { describe, expect, it } from 'bun:test';
import { broadcastOutcome, broadcastToWhy } from '../../../src/why/builders/broadcast';
import { WhySchema } from '../../../src/why/types';

const base = {
  id: 'b-11111111',
  botId: 'b1',
  kind: 'directive' as const,
  text: 'Coordinate with Scout on Acme',
  insightId: 'n-1',
  createdAt: '2026-10-23T10:00:00.000Z',
  deliveredAt: '2026-10-23T10:00:00.000Z',
};
const insight = {
  id: 'n-1',
  kind: 'insight' as const,
  text: 'Jarvis and Scout chase the same lead',
  support: { bots: ['b1', 'b2'] },
  createdBy: 'watcher' as const,
  createdAt: '2026-10-23T09:59:00.000Z',
  lastActivatedAt: '2026-10-23T09:59:00.000Z',
  activations: 1,
};

describe('broadcastToWhy', () => {
  it('names the kind, the watcher, and the insight as the reason', () => {
    const why = broadcastToWhy({ broadcast: base, insight, botName: 'Jarvis' });
    expect(why.what).toBe('Directive to Jarvis: "Coordinate with Scout on Acme"');
    expect(why.by).toBe('watcher');
    expect(why.reason).toEqual({ text: insight.text, source: 'Fleet watcher insight' });
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('every kind has its own line', () => {
    const what = (kind: 'wake' | 'goal' | 'question') =>
      broadcastToWhy({ broadcast: { ...base, kind }, botName: 'Jarvis' }).what;
    expect(what('wake')).toBe('Woke Jarvis');
    expect(what('goal')).toBe('Goal for Jarvis: "Coordinate with Scout on Acme"');
    expect(what('question')).toBe('Asked you, through Jarvis: "Coordinate with Scout on Acme"');
  });

  it('a missing insight is said, not invented', () => {
    const why = broadcastToWhy({ broadcast: base });
    expect(why.reason).toBeUndefined();
    expect(why.missing).toContain('insight');
  });

  it('the serving cycle is the Open cycle target', () => {
    const why = broadcastToWhy({
      broadcast: { ...base, servedByCycle: 'c-9', servedAt: '2026-10-23T11:00:00.000Z' },
      servedCycle: {
        cycleId: 'c-9',
        startedAt: '2026-10-23T10:30:00Z',
        planSummary: 'Talk to Scout',
      },
    });
    expect(why.cycle).toMatchObject({ id: 'c-9', botId: 'b1', plan: 'Talk to Scout' });
    expect(why.outcome).toBe('Served by a cycle on 2026-10-23.');
  });
});

describe('broadcastOutcome', () => {
  it('in words, from the record', () => {
    expect(broadcastOutcome({ ...base, deliveredAt: undefined, deliveryError: 'throttled' })).toBe(
      'Not delivered: throttled.'
    );
    expect(broadcastOutcome(base)).toBe('Delivered; no planner has seen it yet.');
    expect(broadcastOutcome({ ...base, shownAt: '2026-10-23T10:05:00.000Z' })).toBe(
      'Shown to the planner on 2026-10-23; not acted on.'
    );
    expect(
      broadcastOutcome({ ...base, servedByCycle: 'c', servedAt: '2026-10-24T01:00:00.000Z' })
    ).toBe('Served by a cycle on 2026-10-24.');
  });
});
