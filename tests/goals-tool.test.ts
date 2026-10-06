import { describe, expect, mock, test } from 'bun:test';
import {
  type GoalEntry,
  appendGoal,
  createGoalsTool,
  findGoalIndex,
  isOperatorGoal,
  parseGoals,
  resolveGoalParam,
  serializeGoals,
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

  test('returns jobId as fallback', () => {
    expect(resolveGoalParam({ jobId: 'Generate weekly briefing' })).toBe(
      'Generate weekly briefing'
    );
  });

  test('returns job as fallback', () => {
    expect(resolveGoalParam({ job: 'Deploy app' })).toBe('Deploy app');
  });

  test('returns id as fallback', () => {
    expect(resolveGoalParam({ id: 'Execute cold outreach' })).toBe('Execute cold outreach');
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

  test('strips filler words from slug (goal-, task-)', () => {
    const g: GoalEntry[] = [
      { text: 'Auditar presencia digital completa', status: 'pending', priority: 'high' },
    ];
    expect(findGoalIndex(g, 'goal-auditar-presencia-digital')).toBe(0);
    expect(findGoalIndex(g, 'task_auditar_presencia_digital')).toBe(0);
  });

  test('Jaccard similarity matches paraphrased text', () => {
    const g: GoalEntry[] = [
      {
        text: 'Create launch-ready assets for MVP Phase 1: email template, landing page copy',
        status: 'in_progress',
        priority: 'high',
      },
    ];
    expect(
      findGoalIndex(g, 'Create launch ready assets MVP Phase email template landing page')
    ).toBe(0);
  });

  test('Jaccard similarity does NOT match completely unrelated text', () => {
    const g: GoalEntry[] = [
      { text: 'Track monthly revenue and expenses', status: 'pending', priority: 'high' },
    ];
    expect(findGoalIndex(g, 'deploy kubernetes cluster production')).toBe(-1);
  });

  test('Jaccard picks best match among multiple goals', () => {
    const g: GoalEntry[] = [
      {
        text: 'Implement circuit breaker pattern for tool failures',
        status: 'pending',
        priority: 'high',
      },
      { text: 'Deploy landing page for product launch', status: 'pending', priority: 'medium' },
    ];
    expect(findGoalIndex(g, 'circuit breaker tool failure implementation')).toBe(0);
    expect(findGoalIndex(g, 'landing page product launch deploy')).toBe(1);
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
    const stored = loader.readGoals() ?? '';
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

  test('add accepts goal_id alias', async () => {
    const loader = mockSoulLoader(null);
    const tool = createGoalsTool(() => loader as any);
    const result = await tool.execute(
      { action: 'add', goal_id: 'Setup CI pipeline', priority: 'high', _botId: 'test' },
      mockLogger
    );
    expect(result.success).toBe(true);
    expect(result.content).toContain('Setup CI pipeline');
  });

  test('add accepts key alias', async () => {
    const loader = mockSoulLoader(null);
    const tool = createGoalsTool(() => loader as any);
    const result = await tool.execute(
      { action: 'add', key: 'political_risk_pricing', _botId: 'test' },
      mockLogger
    );
    expect(result.success).toBe(true);
    expect(result.content).toContain('political_risk_pricing');
  });

  test('update accepts new_status and new_notes aliases', async () => {
    const loader = mockSoulLoader(
      '## Active Goals\n- [ ] Deploy v2\n  - status: pending\n  - priority: high\n'
    );
    const tool = createGoalsTool(() => loader as any);
    const result = await tool.execute(
      {
        action: 'update',
        goal: 'Deploy v2',
        new_status: 'blocked',
        new_notes: 'Waiting on infra',
        _botId: 'test',
      },
      mockLogger
    );
    expect(result.success).toBe(true);
    const stored = loader.readGoals() ?? '';
    expect(stored).toContain('status: blocked');
    expect(stored).toContain('notes: Waiting on infra');
  });
});

describe('GoalEntry source field', () => {
  test('parseGoals handles source metadata', () => {
    const content = `## Active Goals
- [ ] Improve emotional support
  - status: pending
  - priority: high
  - source: reflection:2026-03-23
- [ ] Learn new topics
  - status: pending
  - priority: medium
`;
    const { active } = parseGoals(content);
    expect(active).toHaveLength(2);
    expect(active[0].source).toBe('reflection:2026-03-23');
    expect(active[1].source).toBeUndefined();
  });

  test('serializeGoals emits source field', () => {
    const active: GoalEntry[] = [
      {
        text: 'Goal with source',
        status: 'pending',
        priority: 'high',
        source: 'strategist:2026-03-23',
      },
    ];
    const result = serializeGoals(active, []);
    expect(result).toContain('source: strategist:2026-03-23');
  });

  test('goals without source still parse and serialize correctly', () => {
    const active: GoalEntry[] = [{ text: 'Legacy goal', status: 'pending', priority: 'medium' }];
    const serialized = serializeGoals(active, []);
    expect(serialized).not.toContain('source:');

    const parsed = parseGoals(serialized);
    expect(parsed.active[0].text).toBe('Legacy goal');
    expect(parsed.active[0].source).toBeUndefined();
  });

  test('roundtrip preserves source through serialize/parse', () => {
    const active: GoalEntry[] = [
      {
        text: 'Tracked goal',
        status: 'in_progress',
        priority: 'high',
        source: 'reflection:2026-03-20',
        notes: 'important',
      },
      { text: 'Untracked goal', status: 'pending', priority: 'low' },
    ];
    const serialized = serializeGoals(active, []);
    const parsed = parseGoals(serialized);

    expect(parsed.active[0].source).toBe('reflection:2026-03-20');
    expect(parsed.active[0].notes).toBe('important');
    expect(parsed.active[1].source).toBeUndefined();
  });
});

describe('findGoalIndex — HTML entities', () => {
  test('matches a title with a literal & when the search came HTML-escaped', () => {
    const goals = [
      {
        // The live job-seeker goal (2026-10-02): long enough that the fuzzy
        // steps miss when the search carries `&amp;`.
        text: 'Write and deliver artifact 07: outreach & referral mechanics — how to get sourced by recruiters, warm intros, referral asks, and follow-up cadence with dated checkpoints',
        status: 'in_progress',
        priority: 'high',
      },
    ] as any;
    expect(findGoalIndex(goals, 'artifact 07: outreach &amp; referral mechanics')).toBe(0);
  });

  test('decodes &lt; &gt; &quot; &#39;', () => {
    const goals = [
      { text: 'Compare <A> vs "B" and Bob\'s list', status: 'pending', priority: 'low' },
    ] as any;
    expect(findGoalIndex(goals, 'compare &lt;a&gt; vs &quot;b&quot; and bob&#39;s list')).toBe(0);
  });
});

describe('operator goals', () => {
  test('created date round-trips through parse/serialize', () => {
    const serialized = serializeGoals(
      [{ text: 'Dated', status: 'pending', priority: 'high', created: '2026-10-06' }],
      []
    );
    expect(serialized).toContain('  - created: 2026-10-06');
    expect(parseGoals(serialized).active[0].created).toBe('2026-10-06');
  });

  test('appendGoal adds to the Active section and keeps everything else', () => {
    const before = `## Active Goals
- [ ] Existing
  - status: in_progress
  - priority: medium
  - source: agent

## Completed
- [x] Shipped
  - completed: 2026-10-01
`;
    const after = appendGoal(before, {
      text: 'Operator ask',
      status: 'pending',
      priority: 'high',
      source: 'operator',
      created: '2026-10-06',
    });
    const parsed = parseGoals(after);
    expect(parsed.active.map((g) => g.text)).toEqual(['Existing', 'Operator ask']);
    expect(parsed.active[1].source).toBe('operator');
    expect(parsed.active[1].created).toBe('2026-10-06');
    expect(parsed.completed.map((g) => g.text)).toEqual(['Shipped']);
  });

  test('appendGoal works on a missing GOALS.md', () => {
    const parsed = parseGoals(
      appendGoal(null, { text: 'First', status: 'pending', priority: 'medium' })
    );
    expect(parsed.active.map((g) => g.text)).toEqual(['First']);
  });

  test('isOperatorGoal recognises operator sources only', () => {
    expect(
      isOperatorGoal({ text: 'a', status: 'pending', priority: 'm', source: 'operator' })
    ).toBe(true);
    expect(
      isOperatorGoal({ text: 'a', status: 'pending', priority: 'm', source: 'operator:2026-10-06' })
    ).toBe(true);
    expect(isOperatorGoal({ text: 'a', status: 'pending', priority: 'm', source: 'agent' })).toBe(
      false
    );
    expect(isOperatorGoal({ text: 'a', status: 'pending', priority: 'm' })).toBe(false);
  });

  test("manage_goals add marks the goal as the agent's own", async () => {
    const loader = mockSoulLoader(
      '## Active Goals\n(no active goals)\n\n## Completed\n(none yet)\n'
    );
    const tool = createGoalsTool(() => loader as any);
    const result = await tool.execute(
      { action: 'add', goal: 'Self goal', _botId: 'b' },
      mockLogger
    );
    expect(result.success).toBe(true);
    const goal = parseGoals(loader.readGoals()).active[0];
    expect(goal.source).toBe('agent');
    expect(goal.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
