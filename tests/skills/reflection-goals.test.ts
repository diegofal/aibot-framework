/**
 * Goals the reflection suggests land in GOALS.md through the goal-event log,
 * each event saying which day's reflection added it (why-everywhere row 12).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGoalEvents } from '../../src/bot/goal-events';
import { appendSuggestedGoals } from '../../src/skills/reflection';

const logger: any = { info: mock(() => {}), warn: mock(() => {}), debug: mock(() => {}) };
let soulDir: string;
beforeEach(() => {
  soulDir = mkdtempSync(join(tmpdir(), 'reflection-goals-'));
  writeFileSync(join(soulDir, 'GOALS.md'), '## Active Goals\n- [ ] Existing goal here\n');
});
afterEach(() => rmSync(soulDir, { recursive: true, force: true }));

describe('appendSuggestedGoals', () => {
  test('adds new goals with the reflection day as the reason; skips duplicates', () => {
    const added = appendSuggestedGoals(
      soulDir,
      [{ text: 'Existing goal here' }, { text: 'Learn the new API', priority: 'high' }],
      logger,
      '2026-10-11'
    );
    expect(added).toBe(1);
    const events = readGoalEvents(soulDir).filter((e) => e.op === 'add');
    expect(events.map((e) => [e.title, e.actor, e.reason])).toEqual([
      ['Learn the new API', 'reflection', 'Suggested by the reflection of 2026-10-11'],
    ]);
  });
});
