import { describe, expect, mock, test } from 'bun:test';
import {
  type GoalEntry,
  createGoalsTool,
  findGoalIndex,
  resolveGoalParam,
} from '../src/tools/goals';

const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
} as any;

function mockSoulLoader(goalsContent: string | null = null) {
  let stored = goalsContent;
  return {
    readGoals: () => stored,
    writeGoals: (content: string) => {
      stored = content;
    },
  };
}

describe('resolveGoalParam', () => {
  test('returns goal when present', () => {
    expect(resolveGoalParam({ goal: 'My goal' })).toBe('My goal');
  });

  test('returns goalId as fallback (most common LLM mistake)', () => {
    expect(resolveGoalParam({ goalId: '1' })).toBe('1');
  });

  test('returns name as fallback', () => {
    expect(resolveGoalParam({ name: 'Track leads' })).toBe('Track leads');
  });

  test('returns title as fallback', () => {
    expect(resolveGoalParam({ title: 'Deploy app' })).toBe('Deploy app');
  });

  test('returns text as fallback', () => {
    expect(resolveGoalParam({ text: 'Some goal' })).toBe('Some goal');
  });

  test('returns description as fallback', () => {
    expect(resolveGoalParam({ description: 'Described goal' })).toBe('Described goal');
  });

  test('goal takes priority over aliases', () => {
    expect(resolveGoalParam({ goal: 'primary', goalId: '1', name: 'alias' })).toBe('primary');
  });

  test('returns empty for no matching key', () => {
    expect(resolveGoalParam({ action: 'update', notes: 'some note' })).toBe('');
  });

  test('trims whitespace', () => {
    expect(resolveGoalParam({ goal: '  hello  ' })).toBe('hello');
    expect(resolveGoalParam({ goalId: '  2  ' })).toBe('2');
  });

  test('skips empty string aliases', () => {
    expect(resolveGoalParam({ goalId: '', name: '', title: 'found' })).toBe('found');
  });
});

describe('findGoalIndex', () => {
  const goals: GoalEntry[] = [
    { text: 'Track monthly revenue', status: 'pending', priority: 'high' },
    { text: 'Establish autonomy loop for idle periods', status: 'in_progress', priority: 'medium' },
    {
      text: 'Geographic diversification — broaden scanning beyond US/Argentina to India, Brazil, Southeast Asia, Europe',
      status: 'in_progress',
      priority: 'medium',
    },
  ];

  test('direct substring match', () => {
    expect(findGoalIndex(goals, 'monthly revenue')).toBe(0);
    expect(findGoalIndex(goals, 'autonomy loop')).toBe(1);
  });

  test('numeric ID (1-based)', () => {
    expect(findGoalIndex(goals, '1')).toBe(0);
    expect(findGoalIndex(goals, '2')).toBe(1);
    expect(findGoalIndex(goals, '3')).toBe(2);
  });

  test('numeric ID out of range returns -1', () => {
    expect(findGoalIndex(goals, '0')).toBe(-1);
    expect(findGoalIndex(goals, '4')).toBe(-1);
    expect(findGoalIndex(goals, '99')).toBe(-1);
  });

  test('slug-style ID (dashes → spaces)', () => {
    expect(findGoalIndex(goals, 'establish-autonomy-loop-for-idle-periods')).toBe(1);
    expect(findGoalIndex(goals, 'track-monthly-revenue')).toBe(0);
  });

  test('underscore-style ID', () => {
    expect(findGoalIndex(goals, 'establish_autonomy_loop_for_idle_periods')).toBe(1);
  });

  test('word-based fallback matches when substring fails', () => {
    expect(findGoalIndex(goals, 'geographic diversification broaden scanning argentina')).toBe(2);
  });

  test('returns -1 for empty search or empty array', () => {
    expect(findGoalIndex(goals, '')).toBe(-1);
    expect(findGoalIndex([], 'anything')).toBe(-1);
  });

  test('returns -1 for unrelated search', () => {
    expect(findGoalIndex(goals, 'deploy kubernetes cluster')).toBe(-1);
  });

  test('case insensitive', () => {
    expect(findGoalIndex(goals, 'TRACK MONTHLY REVENUE')).toBe(0);
    expect(findGoalIndex(goals, 'Establish-Autonomy-Loop')).toBe(1);
  });
});

describe('manage_goals tool with aliases', () => {
  test('add accepts goalId alias', async () => {
    const loader = mockSoulLoader();
    const tool = createGoalsTool(() => loader as any);

    const result = await tool.execute(
      { action: 'add', goalId: 'Track monthly revenue', _botId: 'test' },
      mockLogger
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Goal added: Track monthly revenue');
  });

  test('update accepts goalId alias', async () => {
    const loader = mockSoulLoader(
      '## Active Goals\n- [ ] Track monthly revenue\n  - status: pending\n  - priority: medium\n'
    );
    const tool = createGoalsTool(() => loader as any);

    const result = await tool.execute(
      { action: 'update', goalId: 'Track monthly', status: 'in_progress', _botId: 'test' },
      mockLogger
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Goal updated');
  });

  test('complete accepts goalId alias', async () => {
    const loader = mockSoulLoader(
      '## Active Goals\n- [ ] Track monthly revenue\n  - status: pending\n  - priority: medium\n'
    );
    const tool = createGoalsTool(() => loader as any);

    const result = await tool.execute(
      { action: 'complete', goalId: 'Track monthly', outcome: 'Done', _botId: 'test' },
      mockLogger
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Goal completed');
  });

  test('add with "name" alias', async () => {
    const loader = mockSoulLoader();
    const tool = createGoalsTool(() => loader as any);

    const result = await tool.execute(
      { action: 'add', name: 'Deploy landing page', _botId: 'test' },
      mockLogger
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Goal added: Deploy landing page');
  });

  test('rejects when no goal alias provided', async () => {
    const loader = mockSoulLoader();
    const tool = createGoalsTool(() => loader as any);

    const result = await tool.execute(
      { action: 'add', notes: 'some context', _botId: 'test' },
      mockLogger
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('Missing required parameter: goal');
  });

  test('update matches slug-style goalId', async () => {
    const loader = mockSoulLoader(
      '## Active Goals\n- [ ] Establish autonomy loop for idle periods\n  - status: pending\n  - priority: medium\n'
    );
    const tool = createGoalsTool(() => loader as any);

    const result = await tool.execute(
      {
        action: 'update',
        goalId: 'establish-autonomy-loop-for-idle-periods',
        status: 'in_progress',
        _botId: 'test',
      },
      mockLogger
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Goal updated');
  });

  test('update matches numeric goalId', async () => {
    const loader = mockSoulLoader(
      '## Active Goals\n- [ ] First goal\n  - status: pending\n  - priority: high\n- [ ] Second goal\n  - status: pending\n  - priority: medium\n'
    );
    const tool = createGoalsTool(() => loader as any);

    const result = await tool.execute(
      { action: 'update', goalId: '2', status: 'in_progress', _botId: 'test' },
      mockLogger
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Second goal');
  });

  test('complete matches numeric goalId', async () => {
    const loader = mockSoulLoader(
      '## Active Goals\n- [ ] First goal\n  - status: pending\n  - priority: high\n- [ ] Second goal\n  - status: pending\n  - priority: medium\n'
    );
    const tool = createGoalsTool(() => loader as any);

    const result = await tool.execute(
      { action: 'complete', goalId: '1', outcome: 'Done', _botId: 'test' },
      mockLogger
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('First goal');
  });

  test('update with status=completed moves goal to completed section', async () => {
    const loader = mockSoulLoader(
      '## Active Goals\n- [ ] Resolve filesystem bug\n  - status: pending\n  - priority: high\n'
    );
    const tool = createGoalsTool(() => loader as any);

    const result = await tool.execute(
      { action: 'update', goal: 'filesystem bug', status: 'completed', _botId: 'test' },
      mockLogger
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Goal completed (via update)');
    const stored = loader.readGoals()!;
    expect(stored).toContain('## Completed');
    expect(stored).toContain('[x] Resolve filesystem bug');
    const activeSection = stored.split('## Completed')[0];
    expect(activeSection).not.toContain('Resolve filesystem bug');
  });

  test('no-match error includes active goal list as hint', async () => {
    const loader = mockSoulLoader(
      '## Active Goals\n- [ ] Track monthly revenue\n  - status: pending\n  - priority: high\n'
    );
    const tool = createGoalsTool(() => loader as any);

    const result = await tool.execute(
      { action: 'update', goal: 'nonexistent goal', status: 'in_progress', _botId: 'test' },
      mockLogger
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('No active goal matching');
    expect(result.content).toContain('Track monthly revenue');
  });

  test('SoulLoader error is caught inside try/catch', async () => {
    const tool = createGoalsTool(() => {
      throw new Error('No SoulLoader registered for bot "ghost". Was startBot() called?');
    });

    const result = await tool.execute({ action: 'list', _botId: 'ghost' }, mockLogger);

    expect(result.success).toBe(false);
    expect(result.content).toContain('No SoulLoader registered');
  });
});
