import { describe, expect, it } from 'bun:test';
import type { Lesson } from '../../../src/bot/self-improve/types';
import { lessonEntryToWhy, lessonToWhy } from '../../../src/why/builders/lesson';
import { WhySchema } from '../../../src/why/types';

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  id: 'l-0000abcd',
  classKey: 'file_read:file-not-found',
  tool: 'file_read',
  errorClass: 'file-not-found',
  text: 'Use the full productions path, not a bare filename.',
  textSource: 'model',
  evidence: ['2026-10-26T10:00:00.000Z|file_read', '2026-10-26T11:00:00.000Z|file_read'],
  source: 'own',
  status: 'active',
  createdAt: '2026-10-26T12:00:00.000Z',
  updatedAt: '2026-10-26T12:00:00.000Z',
  baseline: { failures: 12, calls: 30, rate: 0.4, sinceMs: 0, untilMs: 1 },
  ...over,
});

const valid = (why: unknown) => {
  const parsed = WhySchema.safeParse(why);
  expect(parsed.success ? null : parsed.error.issues).toBeNull();
};

describe('lessonToWhy', () => {
  it('own lesson: what, by the agent, reason from the baseline, the rule, the evidence', () => {
    const why = lessonToWhy(lesson(), { botId: 'b1' });
    valid(why);
    expect(why.what).toBe('Lesson: Use the full productions path, not a bare filename.');
    expect(why.by).toBe('agent');
    expect(why.reason).toEqual({
      text: 'file_read failed the same way (file-not-found) 12 times in 30 calls in the 7 days before the lesson.',
      source: 'Self-improvement',
    });
    expect(why.rule).toBe(
      'Kept only if the file-not-found failure rate of file_read drops by at least 50% after the lesson.'
    );
    expect(why.related?.label).toBe('Calls that failed');
    expect(why.related?.items).toEqual([
      { text: 'file_read failed (file-not-found)', at: '2026-10-26T10:00:00.000Z' },
      { text: 'file_read failed (file-not-found)', at: '2026-10-26T11:00:00.000Z' },
    ]);
    expect(why.outcome).toBe(
      'Active: in the prompt, being measured. Before: 40% (12 of 30 calls).'
    );
    expect(why.notes).toBeUndefined();
  });

  it('minDrop from the caller sets the percentage in the rule', () => {
    const why = lessonToWhy(lesson(), { botId: 'b1', minDrop: 0.3 });
    expect(why.rule).toContain('by at least 30%');
  });

  it('measured lesson: status words, its reason, baseline and now as percentages', () => {
    const why = lessonToWhy(
      lesson({
        status: 'proven',
        statusReason: 'The rate fell from 40% to 5%.',
        measure: { failures: 1, calls: 20, rate: 0.05, sinceMs: 1, untilMs: 2 },
      }),
      { botId: 'b1' }
    );
    valid(why);
    expect(why.outcome).toBe(
      'Proven: it worked, kept in the prompt. The rate fell from 40% to 5%. Before: 40% (12 of 30 calls) → now 5% (1 of 20 calls).'
    );
  });

  it('retired and unproven read in words', () => {
    expect(lessonToWhy(lesson({ status: 'retired' }), { botId: 'b1' }).outcome).toStartWith(
      'Retired: it did not help, out of the prompt.'
    );
    expect(lessonToWhy(lesson({ status: 'unproven' }), { botId: 'b1' }).outcome).toStartWith(
      'Unproven: too few calls to tell, out of the prompt.'
    );
  });

  it('borrowed lesson: by the watcher, the source bot in the notes', () => {
    const why = lessonToWhy(
      lesson({ source: 'borrowed', borrowedFrom: { botId: 'b2', lessonId: 'l-11112222' } }),
      { botId: 'b1', sourceBotName: 'Scout' }
    );
    valid(why);
    expect(why.by).toBe('watcher');
    expect(why.notes).toContainEqual({
      label: 'Borrowed from',
      text: 'Scout (lesson l-11112222)',
    });
  });

  it('borrowed without a name falls back to the bot id', () => {
    const why = lessonToWhy(
      lesson({ source: 'borrowed', borrowedFrom: { botId: 'b2', lessonId: 'l-11112222' } }),
      { botId: 'b1' }
    );
    expect(why.notes).toContainEqual({ label: 'Borrowed from', text: 'b2 (lesson l-11112222)' });
  });

  it('fallback text is noted', () => {
    const why = lessonToWhy(lesson({ textSource: 'fallback' }), { botId: 'b1' });
    expect(why.notes).toContainEqual({
      label: 'Fixed text',
      text: "the model's answer was not usable or not asked",
    });
  });

  it('a second measurement window is noted', () => {
    const why = lessonToWhy(lesson({ extended: true }), { botId: 'b1' });
    expect(why.notes).toContainEqual({
      label: 'Measured twice',
      text: 'the first window had too few calls',
    });
  });

  it('no evidence → no related; a cycle with its row → plan; without → just the id', () => {
    const bare = lessonToWhy(lesson({ evidence: [], cycleId: 'c1' }), { botId: 'b1' });
    valid(bare);
    expect(bare.related).toBeUndefined();
    expect(bare.cycle).toEqual({ id: 'c1', botId: 'b1' });
    const full = lessonToWhy(lesson({ cycleId: 'c1' }), {
      botId: 'b1',
      cycle: { cycleId: 'c1', startedAt: '2026-10-26T11:59:00.000Z', planSummary: 'P' },
    });
    expect(full.cycle).toEqual({
      id: 'c1',
      botId: 'b1',
      startedAt: '2026-10-26T11:59:00.000Z',
      plan: 'P',
    });
  });

  it('a baseline with no calls reads 0%', () => {
    const why = lessonToWhy(
      lesson({ baseline: { failures: 0, calls: 0, rate: 0, sinceMs: 0, untilMs: 1 } }),
      { botId: 'b1' }
    );
    expect(why.outcome).toContain('Before: 0% (0 of 0 calls)');
  });

  it('lessonEntryToWhy is the single-argument form the registry uses', () => {
    const l = lesson();
    expect(lessonEntryToWhy({ lesson: l, botId: 'b1' })).toEqual(lessonToWhy(l, { botId: 'b1' }));
  });
});
