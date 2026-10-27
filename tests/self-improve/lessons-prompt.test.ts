import { describe, expect, test } from 'bun:test';
import {
  buildContinuousPlannerPrompt,
  buildExecutorPrompt,
  buildLessonsSection,
  buildPlannerPrompt,
} from '../../src/bot/agent-loop-prompts';

const HEADING = '## Lessons from your own mistakes';

const planner = {
  identity: 'TestBot',
  soul: 'A bot',
  motivations: 'Be helpful',
  goals: '## Goals\n- Goal 1',
  recentMemory: 'Did stuff',
  datetime: '2026-03-08T12:00:00Z',
  availableTools: ['web_search'],
  hasCreateTool: false,
  directives: ['Monitor RSS feeds daily'],
};

const executor = {
  plan: ['Step 1'],
  identity: 'TestBot',
  soul: 'A bot',
  motivations: 'Be helpful',
  goals: '## Goals\n- Goal 1',
  datetime: '2026-03-08T12:00:00Z',
  hasCreateTool: false,
  workDir: '/tmp/test',
  directives: ['Monitor RSS feeds daily'],
};

const lessons = [
  { text: 'List the folder before reading a file.', status: 'active' as const },
  { text: 'Only fetch URLs from search results.', status: 'proven' as const },
];

describe('buildLessonsSection', () => {
  test('empty without lessons', () => {
    expect(buildLessonsSection()).toBe('');
    expect(buildLessonsSection([])).toBe('');
  });

  test('heading, an explaining line and one bullet per lesson', () => {
    const text = buildLessonsSection(lessons);
    expect(text).toContain(HEADING);
    expect(text).toContain('kept failing the same way');
    expect(text).toContain('measured');
    expect(text).toContain('- List the folder before reading a file.\n');
    expect(text).not.toContain('reading a file. (proven)');
  });

  test('a proven lesson is marked', () => {
    expect(buildLessonsSection(lessons)).toContain(
      '- Only fetch URLs from search results. (proven)'
    );
  });

  test('retired and unproven lessons are left out', () => {
    const text = buildLessonsSection([
      { text: 'Retired one.', status: 'retired' },
      { text: 'Unproven one.', status: 'unproven' },
    ]);
    expect(text).toBe('');
  });

  test('a lesson with newlines stays one bullet', () => {
    const text = buildLessonsSection([{ text: 'First line\nsecond line', status: 'active' }]);
    expect(text).toContain('- First line second line');
  });
});

describe('lessons in the prompts', () => {
  test('absent without lessons', () => {
    expect(buildPlannerPrompt(planner).system).not.toContain(HEADING);
    expect(buildContinuousPlannerPrompt(planner).system).not.toContain(HEADING);
    expect(buildExecutorPrompt(executor)).not.toContain(HEADING);
  });

  test('without lessons the prompts are byte-identical to an empty list', () => {
    expect(buildPlannerPrompt({ ...planner, lessons: [] })).toEqual(buildPlannerPrompt(planner));
    expect(buildContinuousPlannerPrompt({ ...planner, lessons: [] })).toEqual(
      buildContinuousPlannerPrompt(planner)
    );
    expect(buildExecutorPrompt({ ...executor, lessons: [] })).toBe(buildExecutorPrompt(executor));
  });

  test('planner, continuous planner and executor carry them right after the directives', () => {
    const texts = [
      buildPlannerPrompt({ ...planner, lessons }).system,
      buildContinuousPlannerPrompt({ ...planner, lessons }).system,
      buildExecutorPrompt({ ...executor, lessons }),
    ];
    for (const text of texts) {
      expect(text).toContain(HEADING);
      expect(text).toContain('Only fetch URLs from search results. (proven)');
      const directives = text.indexOf('Monitor RSS feeds daily');
      const lessonsAt = text.indexOf(HEADING);
      expect(directives).toBeGreaterThan(-1);
      expect(lessonsAt).toBeGreaterThan(directives);
      expect(text.slice(directives, lessonsAt)).not.toContain('\n## ');
    }
  });
});
