import { describe, expect, it } from 'bun:test';
import { evaluateFrontierItem } from '../../../src/bot/curiosity/config';
import type { FrontierItem, LimitDials } from '../../../src/bot/curiosity/types';
import { frontierItemToWhy } from '../../../src/why/builders/frontier';
import { WhySchema } from '../../../src/why/types';

const open: LimitDials = {
  topic: 'open',
  purpose: 'open',
  instructions: 'open',
  method: 'open',
  capability: 'open',
  identity: 'open',
};

const item = (over: Partial<FrontierItem> = {}): FrontierItem => ({
  id: 'f1',
  question: 'Do rerankers change the ranking of models?',
  whyInteresting: 'could flip the default advice',
  bridge: 'the operator picks models',
  distance: 1,
  surpriseScore: 0.7,
  createdAt: '2026-10-11T12:00:00.000Z',
  status: 'open',
  ...over,
});

const valid = (why: unknown) => {
  const r = WhySchema.safeParse(why);
  return r.success ? null : r.error.issues;
};

describe('frontierItemToWhy', () => {
  it('a navigator item: the run that added it and why it is interesting', () => {
    const it0 = item({
      createdBy: { by: 'navigator', runId: 'run-1', at: '2026-10-11T12:00:00.000Z' },
    });
    const why = frontierItemToWhy({
      botId: 'b1',
      item: it0,
      verdict: evaluateFrontierItem(it0, open),
      run: { runId: 'run-1', at: '2026-10-11T12:00:00.000Z', summary: 'Into reranker variance.' },
    });
    expect(valid(why)).toBeNull();
    expect(why.what).toBe('A question the navigator put on its frontier');
    expect(why.by).toBe('navigator');
    expect(why.reason).toEqual({ text: 'could flip the default advice', source: 'Navigator' });
    expect(why.related).toEqual({
      label: 'Added in the navigator run',
      items: [{ text: 'Into reranker variance.', at: '2026-10-11T12:00:00.000Z' }],
    });
    expect(why.rule).toBe(
      'Inside its limits: an adjacent topic, tied to its purpose (“the operator picks models”). Free to explore.'
    );
    expect(why.outcome).toBe('Open: waiting for an exploration cycle.');
    expect(why.missing).toBeUndefined();
  });

  it('an extractor item opens the cycle that produced it', () => {
    const why = frontierItemToWhy({
      botId: 'b1',
      item: item({
        createdBy: { by: 'extractor', cycleId: 'c-9', at: '2026-10-11T12:00:00.000Z' },
      }),
    });
    expect(valid(why)).toBeNull();
    expect(why.what).toBe('A question that came out of one of its work cycles');
    expect(why.by).toBe('curiosity');
    expect(why.cycle).toEqual({ id: 'c-9', botId: 'b1' });
    expect(why.reason?.source).toBe('Cycle extractor');
  });

  it('crossing dials: blocked or waiting for approval', () => {
    const far = item({ distance: 3, bridge: undefined });
    const closed = { ...open, topic: 'closed' as const, purpose: 'ask' as const };
    const why = frontierItemToWhy({
      botId: 'b1',
      item: far,
      verdict: evaluateFrontierItem(far, closed),
    });
    expect(why.rule).toBe(
      'Far from its topics (distance 3) crosses the topic dial; no bridge to its purpose crosses the purpose dial. Blocked by the topic dial; needs your approval on the purpose dial.'
    );
  });

  it('dropped: who dropped it', () => {
    const nav = frontierItemToWhy({
      botId: 'b1',
      item: item({
        status: 'dropped',
        droppedReason: { by: 'navigator', runId: 'run-2', at: '2026-10-12T12:00:00.000Z' },
      }),
    });
    expect(nav.outcome).toBe('Dropped by the navigator as stale or already answered.');
    const you = frontierItemToWhy({
      botId: 'b1',
      item: item({
        status: 'dropped',
        droppedReason: { by: 'operator', at: 'x', via: 'dispatch' },
      }),
    });
    expect(you.outcome).toBe('Dropped: you turned down the dispatch that proposed it.');
    const old = frontierItemToWhy({ botId: 'b1', item: item({ status: 'dropped' }) });
    expect(old.outcome).toBe('Dropped (no record of why).');
  });

  it('exploring and explored', () => {
    expect(frontierItemToWhy({ botId: 'b1', item: item({ status: 'exploring' }) }).outcome).toBe(
      'Being explored now.'
    );
    expect(
      frontierItemToWhy({
        botId: 'b1',
        item: item({ status: 'explored', exploredAt: '2026-10-12T08:00:00.000Z' }),
      }).outcome
    ).toBe('Explored on 2026-10-12.');
  });

  it('an old item without provenance says so', () => {
    const why = frontierItemToWhy({ botId: 'b1', item: item() });
    expect(valid(why)).toBeNull();
    expect(why.what).toBe('A question on its frontier');
    expect(why.by).toBe('curiosity');
    expect(why.missing).toBe(
      'No record of what added it (written before frontier provenance was kept).'
    );
  });

  it('a navigator item whose run fell out of the history still names the run date', () => {
    const why = frontierItemToWhy({
      botId: 'b1',
      item: item({ createdBy: { by: 'navigator', runId: 'gone', at: '2026-09-01T12:00:00.000Z' } }),
      run: null,
    });
    expect(why.related).toBeUndefined();
    expect(why.notes).toEqual([
      { label: 'Run', text: 'Added by the navigator run of 2026-09-01.' },
    ]);
  });
});
