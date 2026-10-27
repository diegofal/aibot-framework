import { describe, expect, it } from 'bun:test';
import type { SoulEvent } from '../../../src/bot/soul-events';
import { soulEventToWhy } from '../../../src/why/builders/soul-event';
import { WhySchema } from '../../../src/why/types';

const base = (over: Partial<SoulEvent> = {}): SoulEvent => ({
  ts: '2026-10-11T12:00:00.000Z',
  file: 'MEMORY.md',
  op: 'consolidate',
  actor: 'system',
  summary: 'Merged 2 daily logs into MEMORY.md: 1 line added, 1 dropped; 2 logs archived.',
  ...over,
});

const valid = (why: unknown) => {
  const parsed = WhySchema.safeParse(why);
  expect(parsed.success ? null : parsed.error.issues).toBeNull();
};

describe('soulEventToWhy', () => {
  it('consolidation: what merged and what was dropped, the logs and the backup', () => {
    const why = soulEventToWhy({
      botId: 'b1',
      event: base({
        added: ['- synthetic new line'],
        removed: ['- synthetic old line'],
        addedCount: 1,
        removedCount: 1,
        detail: ['2026-10-09.md', '2026-10-10.md'],
        backup: '.versions/MEMORY.md.2026-10-11T12-00-00.bak',
      }),
    });
    valid(why);
    expect(why.what).toBe('Memory consolidated');
    expect(why.by).toBe('system');
    expect(why.rule).toContain('Daily logs older than today');
    expect(why.related?.items).toEqual([
      { text: '- synthetic new line', detail: 'added' },
      { text: '- synthetic old line', detail: 'dropped' },
    ]);
    expect(why.outcome).toBe(base().summary);
    expect(why.notes).toContainEqual({
      label: 'Daily logs',
      text: '2026-10-09.md, 2026-10-10.md',
    });
    expect(why.notes).toContainEqual({
      label: 'Backup',
      text: '.versions/MEMORY.md.2026-10-11T12-00-00.bak',
    });
  });

  it('says when the lists were capped', () => {
    const why = soulEventToWhy({
      botId: 'b1',
      event: base({ added: ['a'], addedCount: 12, removed: ['b'], removedCount: 1 }),
    });
    expect(why.related?.note).toBe('Showing 1 of 12 added and 1 of 1 dropped lines.');
  });

  it('facts saved: the facts, the conversation, the trigger as the rule', () => {
    const why = soulEventToWhy({
      botId: 'b1',
      event: base({
        op: 'facts-saved',
        file: 'core-memory',
        summary: 'Saved 1 fact from a conversation when the conversation ended.',
        added: ['[preferences] synthetic fact'],
        conversation: 'bot:b1:private:1',
        trigger: 'conversation-end',
        endReason: 'daily',
        observedAt: '2026-10-10T12:00:00.000Z',
      }),
    });
    valid(why);
    expect(why.what).toBe('Facts saved from a conversation');
    expect(why.rule).toContain('daily reset');
    expect(why.related).toEqual({
      label: 'Facts saved',
      items: [{ text: '[preferences] synthetic fact' }],
    });
    expect(why.notes).toContainEqual({ label: 'Conversation', text: 'bot:b1:private:1' });
    expect(why.notes).toContainEqual({ label: 'Said on', text: '2026-10-10T12:00:00.000Z' });
  });

  it('facts saved without a source says it cannot know the conversation', () => {
    const why = soulEventToWhy({
      botId: 'b1',
      event: base({ op: 'facts-saved', file: 'core-memory', summary: 's' }),
    });
    valid(why);
    expect(why.missing).toContain('conversation');
  });

  it('hygiene fix: by hygiene, the run id and the fix lines', () => {
    const why = soulEventToWhy({
      botId: 'b1',
      event: base({
        op: 'hygiene-fix',
        actor: 'hygiene',
        file: 'GOALS.md',
        runId: 'run-1',
        summary: 'goal-lint applied 1 fix to GOALS.md.',
        detail: ['"X" moved to Completed'],
      }),
    });
    valid(why);
    expect(why.what).toBe('Hygiene fix');
    expect(why.by).toBe('hygiene');
    expect(why.related).toEqual({ label: 'Fixes', items: [{ text: '"X" moved to Completed' }] });
    expect(why.notes).toContainEqual({ label: 'Hygiene run', text: 'run-1' });
  });

  it('rejected consolidation and a known cycle', () => {
    const why = soulEventToWhy({
      botId: 'b1',
      event: base({ op: 'consolidate-rejected', cycleId: 'c1' }),
      cycle: { cycleId: 'c1', startedAt: '2026-10-11T11:59:00Z', planSummary: 'P' },
    });
    valid(why);
    expect(why.what).toBe('Memory consolidation rejected');
    expect(why.cycle).toEqual({
      id: 'c1',
      botId: 'b1',
      startedAt: '2026-10-11T11:59:00Z',
      plan: 'P',
    });
  });

  it('an unknown op still renders', () => {
    const why = soulEventToWhy({
      botId: 'b1',
      event: base({ op: 'other' as SoulEvent['op'], actor: 'weird' as SoulEvent['actor'] }),
    });
    valid(why);
    expect(why.what).toBe('Memory edited (other)');
    expect(why.by).toBeUndefined();
  });

  it('lesson: a self-improvement lesson, the measurement rule, details not read as daily logs', () => {
    const why = soulEventToWhy({
      botId: 'b1',
      event: base({
        file: 'LESSONS.json',
        op: 'lesson',
        actor: 'agent',
        summary: 'Lesson created for file_read file-not-found.',
        detail: ['l-0000abcd'],
        cycleId: 'c1',
      }),
    });
    valid(why);
    expect(why.what).toBe('Self-improvement lesson');
    expect(why.by).toBe('agent');
    expect(why.rule).toContain('fails the same way');
    expect(why.rule).toContain('kept only if');
    expect(why.outcome).toBe('Lesson created for file_read file-not-found.');
    expect(why.notes).toContainEqual({ label: 'File', text: 'LESSONS.json' });
    expect(why.notes).toContainEqual({ label: 'Details', text: 'l-0000abcd' });
    expect(why.notes?.some((n) => n.label === 'Daily logs')).toBe(false);
  });
});
