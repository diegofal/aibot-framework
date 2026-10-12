import { describe, expect, it } from 'bun:test';
import type { Dispatch } from '../../../src/bot/curiosity/types';
import { dispatchOutcome, dispatchToWhy } from '../../../src/why/builders/dispatch';
import { WhySchema } from '../../../src/why/types';

const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'd1',
  botId: 'b1',
  createdAt: '2026-10-11T12:01:00Z',
  kind: 'insight',
  topic: 't',
  hook: 'Reranking beats bigger embeddings',
  whyCare: 'w',
  evidence: 'e',
  action: 'a',
  body: 'b',
  editorScore: 0.82,
  status: 'sent',
  ...over,
});

const origin = {
  trigger: 'insight' as const,
  cycleId: 'c-1',
  goalId: 'g-1',
  goalTitle: 'Find remote roles',
  plan: 'Search FDE roles',
  mode: 'exploit' as const,
  modeReason: 'default',
};

describe('dispatchToWhy', () => {
  it('names what produced it, the cycle, the goal and the outcome', () => {
    const why = dispatchToWhy(dispatch({ origin, deliveredVia: 'telegram' }));
    expect(why).toEqual({
      what: 'A finding from one of its work cycles',
      by: 'curiosity',
      cycle: { id: 'c-1', botId: 'b1', plan: 'Search FDE roles', mode: 'exploit' },
      goal: { id: 'g-1', title: 'Find remote roles' },
      outcome: 'Sent to you on Telegram (editor score 0.82).',
    });
    expect(WhySchema.safeParse(why).success).toBe(true);
  });

  it('an explore cycle carries its reason in words and the question it chased', () => {
    const why = dispatchToWhy(
      dispatch({
        origin: { ...origin, mode: 'explore', modeReason: 'no-surprise', frontierQuestion: 'Q?' },
      })
    );
    expect(why.cycle).toMatchObject({ mode: 'explore', chasing: 'Q?' });
    expect(why.cycle?.modeReason).toContain('nothing had surprised it');
  });

  it('a cycle matched by time stays marked inferred', () => {
    expect(dispatchToWhy(dispatch({ origin: { ...origin, inferred: true } })).cycle?.inferred).toBe(
      true
    );
  });

  it('a digest lists what it was built from, and says when that was reconstructed', () => {
    const why = dispatchToWhy({
      ...dispatch({ kind: 'digest', origin: { trigger: 'digest' } }),
      sources: {
        inferred: true,
        items: [
          { id: 'h1', hook: 'Motum is open', createdAt: '2026-10-05T00:00:00Z', editorScore: 0.57 },
        ],
      },
    });
    expect(why.what).toBe('A digest of findings that were held back');
    expect(why.related).toEqual({
      label: 'Built from',
      items: [{ text: 'Motum is open', at: '2026-10-05T00:00:00Z', detail: 'score 0.57' }],
      note: 'Reconstructed from what was held at the time.',
    });
    expect(why.missing).toBeUndefined();
  });

  it('keeps the editor notes and the agent draft, not the internal cadence marker', () => {
    const why = dispatchToWhy(
      dispatch({ origin: { ...origin, draftHook: 'Two findings' }, editorNotes: 'Partly backed' })
    );
    expect(why.notes).toEqual([
      { label: 'Draft', text: 'The editor rewrote the headline. The agent wrote: “Two findings”' },
      { label: 'Editor', text: 'Partly backed' },
    ]);
    expect(
      dispatchToWhy(
        dispatch({ origin, status: 'held', editorNotes: 'held: cadence closed, not edited' })
      ).notes
    ).toBeUndefined();
  });

  it('says so when no cycle record exists', () => {
    const why = dispatchToWhy(dispatch());
    expect(why.cycle).toBeUndefined();
    expect(why.missing).toContain('No record of the cycle');
    expect(WhySchema.safeParse(why).success).toBe(true);
  });
});

describe('dispatchOutcome', () => {
  it('editor hold: the score against the bar', () => {
    expect(
      dispatchOutcome(
        dispatch({ status: 'held', heldReason: 'editor', editorScore: 0.49, heldBar: 0.5 })
      )
    ).toBe('Held: the editor scored it 0.49; it needed 0.50 to reach you.');
  });

  it('every hold reason reads differently', () => {
    const reasons = [
      'cadence-closed',
      'editor-failed',
      'fleet-cap',
      'delivery-failed',
      'disabled',
    ] as const;
    const texts = reasons.map((heldReason) =>
      dispatchOutcome(dispatch({ status: 'held', heldReason }))
    );
    expect(new Set(texts).size).toBe(reasons.length);
    expect(texts[0]).toContain('messaged you recently');
  });

  it('older held dispatches: the cadence marker, else the bare score', () => {
    expect(
      dispatchOutcome(dispatch({ status: 'held', editorNotes: 'held: cadence closed, not edited' }))
    ).toContain('messaged you recently');
    expect(dispatchOutcome(dispatch({ status: 'held', editorScore: 0.57 }))).toBe(
      'Held: the editor scored it 0.57, below what it takes to reach you.'
    );
  });

  it('sent to the feed, and dropped', () => {
    expect(dispatchOutcome(dispatch({ deliveredVia: 'inbox' }))).toBe(
      'Sent to you in your dashboard feed (editor score 0.82).'
    );
    expect(dispatchOutcome(dispatch({ status: 'dropped' }))).toContain('Dropped');
  });
});
