import { describe, expect, mock, test } from 'bun:test';
import {
  type GoalEntry,
  appendGoal,
  createGoalsTool,
  editGoal,
  findGoalIndex,
  goalBucket,
  isOperatorGoal,
  parseGoals,
  removeGoal,
  resolveGoalParam,
  serializeGoals,
  setGoalStatus,
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

describe('setGoalStatus (board moves)', () => {
  const md = `## Active Goals
- [ ] Write brief
  - status: pending
  - priority: high
  - source: operator
- [ ] Map skills
  - status: in_progress
  - priority: medium

## Completed
- [x] Old thing
  - completed: 2026-10-01
  - outcome: shipped
`;

  test('moves an active goal between todo, in progress and blocked', () => {
    const out = setGoalStatus(md, 'Write brief', 'in_progress');
    expect(out).not.toBeNull();
    const g = parseGoals(out as string).active.find((x) => x.text === 'Write brief');
    expect(g?.status).toBe('in_progress');
    expect(g?.source).toBe('operator');
    const blocked = parseGoals(setGoalStatus(md, 'Map skills', 'blocked') as string);
    expect(blocked.active.find((x) => x.text === 'Map skills')?.status).toBe('blocked');
  });

  test('done moves the goal to Completed with a date', () => {
    const { active, completed } = parseGoals(setGoalStatus(md, 'Write brief', 'done') as string);
    expect(active.map((g) => g.text)).toEqual(['Map skills']);
    const done = completed.find((g) => g.text === 'Write brief');
    expect(done?.completed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('reopening a completed goal puts it back in Active without the completion fields', () => {
    const { active, completed } = parseGoals(setGoalStatus(md, 'Old thing', 'pending') as string);
    expect(completed).toHaveLength(0);
    const g = active.find((x) => x.text === 'Old thing');
    expect(g?.status).toBe('pending');
    expect(g?.completed).toBeUndefined();
    expect(g?.outcome).toBeUndefined();
  });

  test('matches the exact title only, and returns null when nothing matches', () => {
    expect(setGoalStatus(md, 'Write', 'done')).toBeNull();
    expect(setGoalStatus(md, 'Nope', 'done')).toBeNull();
    expect(setGoalStatus(null, 'Write brief', 'done')).toBeNull();
  });
});

describe('goalBucket', () => {
  test('maps statuses to board columns', () => {
    expect(goalBucket('pending')).toBe('todo');
    expect(goalBucket(undefined)).toBe('todo');
    expect(goalBucket('in_progress')).toBe('inProgress');
    expect(goalBucket('In-Progress')).toBe('inProgress');
    expect(goalBucket('active')).toBe('inProgress');
    expect(goalBucket('blocked')).toBe('blocked');
  });
});

describe('appendGoal / setGoalStatus keep goal ids and times', () => {
  test('appendGoal assigns an id to the new goal and keeps existing ids', () => {
    const md = appendGoal('## Active Goals\n- [ ] Old\n  - id: g-00000001\n', {
      text: 'New',
      status: 'pending',
      priority: 'medium',
    });
    const { active } = parseGoals(md);
    expect(active[0].id).toBe('g-00000001');
    expect(active[1].id).toMatch(/^g-[0-9a-f]{8}$/);
  });

  test('setGoalStatus keeps the id, stamps updated, and started only the first time', () => {
    const md = '## Active Goals\n- [ ] Work\n  - status: pending\n  - id: g-00000002\n';
    const t1 = new Date('2026-10-06T10:00:00.000Z');
    const started = parseGoals(setGoalStatus(md, 'Work', 'in_progress', () => t1) as string)
      .active[0];
    expect(started).toMatchObject({
      id: 'g-00000002',
      started: t1.toISOString(),
      updated: t1.toISOString(),
    });
    const t2 = new Date('2026-10-07T10:00:00.000Z');
    const again = serializeGoals([{ ...started, status: 'blocked' }], []);
    const back = parseGoals(setGoalStatus(again, 'Work', 'in_progress', () => t2) as string)
      .active[0];
    expect(back.started).toBe(t1.toISOString());
    expect(back.updated).toBe(t2.toISOString());
    const done = parseGoals(setGoalStatus(again, 'Work', 'done', () => t2) as string).completed[0];
    expect(done.id).toBe('g-00000002');
  });
});

describe('editGoal (operator edits from the drawer)', () => {
  const md = `## Active Goals
- [ ] Write brief
  - status: pending
  - priority: high
  - notes: old notes
  - id: g-aaaaaaaa

## Completed
- [x] Old thing
  - completed: 2026-10-01
  - id: g-cccccccc
`;
  test('renames and re-notes by id, keeping everything else', () => {
    const out = editGoal(md, 'g-aaaaaaaa', { text: 'Write the Monday brief', notes: 'new notes' });
    const g = parseGoals(out as string).active[0];
    expect(g.text).toBe('Write the Monday brief');
    expect(g.notes).toBe('new notes');
    expect(g.id).toBe('g-aaaaaaaa');
    expect(g.priority).toBe('high');
  });
  test('finds by exact title too, edits completed goals, and empty notes clear them', () => {
    expect(
      parseGoals(editGoal(md, 'Write brief', { notes: '' }) as string).active[0].notes
    ).toBeUndefined();
    expect(
      parseGoals(editGoal(md, 'g-cccccccc', { text: 'Older thing' }) as string).completed[0].text
    ).toBe('Older thing');
    expect(
      parseGoals(editGoal(md, 'g-aaaaaaaa', { priority: 'low' }) as string).active[0].priority
    ).toBe('low');
  });
  test('null for an unknown goal', () => {
    expect(editGoal(md, 'g-nope', { text: 'x' })).toBeNull();
  });
});

describe('goal subtasks (task: lines)', () => {
  const md = `## Active Goals
- [ ] Write brief
  - status: in_progress
  - priority: high
  - task: [x] Pick three sources
  - task: [ ] Draft 600 words
  - id: g-aaaaaaaa

## Completed
(none yet)
`;
  test('parse reads task lines in order, done or not', () => {
    expect(parseGoals(md).active[0].tasks).toEqual([
      { text: 'Pick three sources', done: true },
      { text: 'Draft 600 words', done: false },
    ]);
  });

  test('a task line is never mistaken for a new goal, and serialize round-trips', () => {
    const { active, completed } = parseGoals(md);
    expect(active).toHaveLength(1);
    const again = parseGoals(serializeGoals(active, completed));
    expect(again.active[0].tasks).toEqual(active[0].tasks);
    expect(serializeGoals(active, completed)).toContain('  - task: [ ] Draft 600 words');
  });

  test('goals without tasks serialize without task lines', () => {
    const out = serializeGoals([{ text: 'Plain', status: 'pending', priority: 'medium' }], []);
    expect(out).not.toContain('task:');
  });

  test('editGoal replaces the task list; an empty list clears it', () => {
    const out = editGoal(md, 'g-aaaaaaaa', {
      tasks: [
        { text: 'Pick three sources', done: true },
        { text: 'Draft 600 words', done: true },
        { text: 'Send to Diego', done: false },
      ],
    }) as string;
    expect(parseGoals(out).active[0].tasks?.map((t) => t.done)).toEqual([true, true, false]);
    const cleared = editGoal(md, 'g-aaaaaaaa', { tasks: [] }) as string;
    expect(parseGoals(cleared).active[0].tasks).toBeUndefined();
  });
});

describe('removeGoal', () => {
  const md = `## Active Goals
- [ ] Keep
  - status: pending
  - priority: medium
  - id: g-11111111
- [ ] Drop
  - status: pending
  - priority: medium
  - id: g-22222222

## Completed
- [x] Old
  - completed: 2026-10-01
  - id: g-33333333
`;
  test('removes an active or completed goal by id or exact title', () => {
    const a = parseGoals(removeGoal(md, 'g-22222222') as string);
    expect(a.active.map((g) => g.text)).toEqual(['Keep']);
    const b = parseGoals(removeGoal(md, 'old') as string);
    expect(b.completed).toHaveLength(0);
  });
  test('null for an unknown goal', () => {
    expect(removeGoal(md, 'g-nope')).toBeNull();
  });
});
