import { describe, expect, it } from 'bun:test';
import { cleanedByBot, cleanupHeadline, openFindings } from '../../web/pages/hygiene-helpers.js';

const finding = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'orphan-reference',
  severity: 'warn',
  file: `${id}.md`,
  line: null,
  message: `msg ${id}`,
  fixable: true,
  ...extra,
});

describe('openFindings', () => {
  it('is the findings of a preview', () => {
    const run = { dryRun: true, findings: [finding('a')] };
    expect(openFindings(run)).toEqual(run.findings);
  });
  it('is the post-apply `remaining` of an apply run, not the pre-apply findings', () => {
    const run = {
      dryRun: false,
      findings: [finding('a'), finding('b')],
      remaining: [finding('b')],
    };
    expect(openFindings(run).map((f: any) => f.id)).toEqual(['b']);
  });
  it('falls back to findings for apply runs recorded before `remaining` existed', () => {
    const run = { dryRun: false, findings: [finding('a')] };
    expect(openFindings(run)).toEqual(run.findings);
  });
  it('tolerates a missing run', () => {
    expect(openFindings(null)).toEqual([]);
  });
});

describe('cleanedByBot', () => {
  it('groups applied fixes by bot, joined with the finding they fixed', () => {
    const run = {
      findings: [
        finding('bot1:productions-triage:orphan-reference:x', { botId: 'bot1', file: 'x.md' }),
        finding('fleet:data-cleanup:orphan-karma-dir:ghost', { file: 'karma/ghost' }),
      ],
      applied: [
        {
          findingId: 'bot1:productions-triage:orphan-reference:x',
          action: 'prune-changelog',
          result: '1 entry removed',
        },
        {
          findingId: 'fleet:data-cleanup:orphan-karma-dir:ghost',
          action: 'trash',
          result: 'moved',
        },
      ],
    };
    expect(cleanedByBot(run)).toEqual([
      {
        botId: 'bot1',
        items: [
          {
            action: 'prune-changelog',
            result: '1 entry removed',
            file: 'x.md',
            kind: 'orphan-reference',
            message: 'msg bot1:productions-triage:orphan-reference:x',
          },
        ],
      },
      {
        botId: 'fleet',
        items: [
          {
            action: 'trash',
            result: 'moved',
            file: 'karma/ghost',
            kind: 'orphan-reference',
            message: 'msg fleet:data-cleanup:orphan-karma-dir:ghost',
          },
        ],
      },
    ]);
  });
  it('uses the run bot for single-routine runs whose ids carry no bot prefix', () => {
    const run = {
      botId: 'bot9',
      findings: [finding('goal-lint:archived-in-active:0')],
      applied: [{ findingId: 'goal-lint:archived-in-active:0', action: 'move', result: 'ok' }],
    };
    expect(cleanedByBot(run).map((g: any) => g.botId)).toEqual(['bot9']);
  });
  it('is empty when nothing was applied', () => {
    expect(cleanedByBot({ findings: [], applied: [] })).toEqual([]);
  });
});

describe('cleanupHeadline', () => {
  it('says what was cleaned and what is left', () => {
    expect(cleanupHeadline({ applied: [{}, {}], remaining: [finding('a')], findings: [] })).toBe(
      'Cleaned up 2 items · 1 still needs you'
    );
  });
  it('says so when there was nothing to clean', () => {
    expect(cleanupHeadline({ applied: [], remaining: [], findings: [] })).toBe(
      'Nothing to clean up — everything is tidy'
    );
  });
  it('handles nothing cleaned but something left', () => {
    expect(cleanupHeadline({ applied: [], remaining: [finding('a'), finding('b')] })).toBe(
      'Nothing to clean up · 2 still need you'
    );
  });
});
