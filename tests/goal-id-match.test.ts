import { describe, expect, test } from 'bun:test';
import { findGoalIndex } from '../src/tools/goals';

describe('findGoalIndex by goal id', () => {
  const goals = [
    {
      text: 'Read at least 2 demand sources per cycle',
      status: 'pending',
      priority: 'high',
      id: 'g-11111111',
    },
    { text: 'Ship the landing page', status: 'in_progress', priority: 'medium', id: 'g-5ba5ff60' },
  ];

  test('an exact goal id (as shown in the goals view) resolves to that goal', () => {
    expect(findGoalIndex(goals, 'g-5ba5ff60')).toBe(1);
    expect(findGoalIndex(goals, ' G-5BA5FF60 ')).toBe(1);
  });

  test('an unknown id does not fuzzy-match another goal', () => {
    expect(findGoalIndex(goals, 'g-deadbeef')).toBe(-1);
  });
});
