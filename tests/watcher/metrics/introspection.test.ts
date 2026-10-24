import { describe, expect, test } from 'bun:test';
import {
  type IntrospectionTruth,
  parseIntrospectionAnswer,
  scoreFields,
  scoreIntrospection,
  summarizeIntrospection,
} from '../../../src/watcher/metrics/introspection';

const busy: IntrospectionTruth = {
  executing: true,
  phase: 'executor:start',
  currentTool: 'web_fetch',
  since: 1,
  goalId: 'g-1234abcd',
  goalTitle: 'Find remote jobs in Argentina',
  plan: 'Search the job boards for remote backend roles in Argentina',
};

const idle: IntrospectionTruth = {
  executing: false,
  phase: null,
  currentTool: null,
  since: null,
};

describe('parseIntrospectionAnswer', () => {
  test('reads the JSON object out of prose and fences', () => {
    const text =
      'Sure:\n```json\n{"phase":"executor","tool":"web_fetch","goal":"g-1234abcd","cause":"job search"}\n```';
    expect(parseIntrospectionAnswer(text)).toEqual({
      phase: 'executor',
      tool: 'web_fetch',
      goal: 'g-1234abcd',
      cause: 'job search',
    });
  });

  test('reads a JSON object embedded in prose without fences', () => {
    const text = 'Right now {"phase": "planner", "tool": null} that is all';
    expect(parseIntrospectionAnswer(text)).toEqual({
      phase: 'planner',
      tool: null,
      goal: null,
      cause: null,
    });
  });

  test('non-string fields become null', () => {
    expect(parseIntrospectionAnswer('{"phase": 3, "tool": "exec"}')).toEqual({
      phase: null,
      tool: 'exec',
      goal: null,
      cause: null,
    });
  });

  test('plain prose is null', () => {
    expect(parseIntrospectionAnswer('I am just thinking about life.')).toBeNull();
  });

  test('an object without any known field is null', () => {
    expect(parseIntrospectionAnswer('{"mood": "fine"}')).toBeNull();
  });

  test('empty or non-string input is null', () => {
    expect(parseIntrospectionAnswer('')).toBeNull();
    expect(parseIntrospectionAnswer(undefined as unknown as string)).toBeNull();
  });
});

describe('scoreIntrospection', () => {
  test('full match scores 1', () => {
    const s = scoreIntrospection(
      {
        phase: 'executor',
        tool: 'web_fetch',
        goal: 'g-1234abcd',
        cause: 'search job boards for remote backend roles',
      },
      busy
    );
    expect(s.parsed).toBe(true);
    expect(s.fields).toEqual({ phase: 'match', tool: 'match', goal: 'match', cause: 'match' });
    expect(s.score).toBe(1);
  });

  test('goal matches by title as well as by id', () => {
    const s = scoreIntrospection(
      { phase: 'executor', tool: 'web_fetch', goal: 'find remote jobs in argentina', cause: null },
      busy
    );
    expect(s.fields.goal).toBe('match');
  });

  test('partial match scores the share of known fields', () => {
    const s = scoreIntrospection(
      { phase: 'planner', tool: 'web_fetch', goal: 'write a poem', cause: 'boredom' },
      busy
    );
    expect(s.fields).toEqual({ phase: 'miss', tool: 'match', goal: 'miss', cause: 'miss' });
    expect(s.score).toBe(0.25);
  });

  test('fields the truth does not know are unknown and left out of the score', () => {
    const s = scoreIntrospection(
      { phase: 'idle', tool: null, goal: 'anything', cause: 'anything' },
      idle
    );
    expect(s.fields).toEqual({
      phase: 'match',
      tool: 'match',
      goal: 'unknown',
      cause: 'unknown',
    });
    expect(s.score).toBe(1);
  });

  test('claiming a tool while idle is a miss', () => {
    const s = scoreIntrospection(
      { phase: 'executor', tool: 'exec', goal: null, cause: null },
      idle
    );
    expect(s.fields.phase).toBe('miss');
    expect(s.fields.tool).toBe('miss');
    expect(s.score).toBe(0);
  });

  test('unparsable answer scores 0 with parsed false', () => {
    const s = scoreIntrospection(null, busy);
    expect(s.parsed).toBe(false);
    expect(s.score).toBe(0);
    expect(s.fields).toEqual({ phase: 'miss', tool: 'miss', goal: 'miss', cause: 'miss' });
  });
});

describe('summarizeIntrospection (phase 4)', () => {
  test('groups by subject, skips rows without a numeric score, never NaN', () => {
    const out = summarizeIntrospection([
      { ts: '2026-10-23T01:00:00Z', subject: 'bot:b2', score: 0.5 },
      { ts: '2026-10-23T02:00:00Z', subject: 'bot:b2', score: 1, fields: { phase: 'match' } },
      { subject: 'bot:b2' },
      { ts: '2026-10-23T03:00:00Z', score: 0 },
    ]);
    expect(out.map((s) => s.subject)).toEqual(['bot:b2', 'unknown']);
    expect(out[0]).toMatchObject({ n: 2, score: 0.75, lastAt: '2026-10-23T02:00:00Z' });
    expect(out[0]?.fields.phase).toBe(1);
    expect(out[0]?.fields.goal).toBeNull();
    expect(JSON.stringify(out)).not.toContain('NaN');
  });

  test('an empty list is empty', () => {
    expect(summarizeIntrospection([])).toEqual([]);
  });
});

describe('scoreFields', () => {
  test('matches over known fields; unknown fields are left out', () => {
    expect(
      scoreFields({ phase: 'match', tool: 'miss', goal: 'unknown', cause: 'match' })
    ).toBeCloseTo(2 / 3);
  });

  test('0 when nothing is known', () => {
    expect(
      scoreFields({ phase: 'unknown', tool: 'unknown', goal: 'unknown', cause: 'unknown' })
    ).toBe(0);
  });
});
