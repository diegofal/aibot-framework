import { beforeEach, describe, expect, test, vi } from 'bun:test';
import {
  type GoalOperation,
  applyGoalOperations,
  computeCyclesUntilStrategist,
  parseStrategistResult,
  shouldRunStrategist,
} from '../../src/bot/agent-strategist';
import { parseGoals, serializeGoals } from '../../src/tools/goals';

// ---------- helpers ----------

const mockLogger = {
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
};

function resetLogger() {
  mockLogger.warn.mockReset();
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.error.mockReset();
}

// ---------- parseStrategistResult ----------

describe('parseStrategistResult', () => {
  beforeEach(resetLogger);

  test('valid JSON with focus and reflection', () => {
    const raw = JSON.stringify({
      focus: 'Write a poem',
      reflection: 'I should be creative',
      goal_operations: [],
    });
    const result = parseStrategistResult(raw, mockLogger);
    expect(result).not.toBeNull();
    expect(result?.single_deliverable).toBe('Write a poem');
    expect(result?.focus).toBe('Write a poem');
    expect(result?.reflection).toBe('I should be creative');
    expect(result?.goal_operations).toEqual([]);
  });

  test('valid JSON with single_deliverable', () => {
    const raw = JSON.stringify({
      single_deliverable: 'Deploy new feature',
      reflection: 'Deployment is key',
      goal_operations: [{ action: 'add', goal: 'Deploy feature X', priority: 'high' }],
    });
    const result = parseStrategistResult(raw, mockLogger);
    expect(result).not.toBeNull();
    expect(result?.single_deliverable).toBe('Deploy new feature');
    expect(result?.focus).toBe('Deploy new feature');
    expect(result?.reflection).toBe('Deployment is key');
    expect(result?.goal_operations).toHaveLength(1);
    expect(result?.goal_operations[0].action).toBe('add');
  });

  test('goal_operations parsed correctly', () => {
    const ops: GoalOperation[] = [
      { action: 'add', goal: 'Learn Rust', priority: 'medium' },
      { action: 'complete', goal: 'Learn Go', outcome: 'Done' },
      { action: 'update', goal: 'Learn TS', status: 'in_progress' },
      { action: 'remove', goal: 'Old goal' },
    ];
    const raw = JSON.stringify({
      single_deliverable: 'Study languages',
      reflection: 'Diversify skills',
      goal_operations: ops,
    });
    const result = parseStrategistResult(raw, mockLogger);
    expect(result).not.toBeNull();
    expect(result?.goal_operations).toHaveLength(4);
    expect(result?.goal_operations[0]).toEqual(ops[0]);
    expect(result?.goal_operations[1]).toEqual(ops[1]);
    expect(result?.goal_operations[2]).toEqual(ops[2]);
    expect(result?.goal_operations[3]).toEqual(ops[3]);
  });

  test('invalid JSON returns null', () => {
    const result = parseStrategistResult('this is not json at all', mockLogger);
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('missing reflection returns null', () => {
    const raw = JSON.stringify({
      single_deliverable: 'Do something',
      goal_operations: [],
    });
    const result = parseStrategistResult(raw, mockLogger);
    expect(result).toBeNull();
  });

  test('missing both focus and single_deliverable returns null', () => {
    const raw = JSON.stringify({
      reflection: 'Some thought',
      goal_operations: [],
    });
    const result = parseStrategistResult(raw, mockLogger);
    expect(result).toBeNull();
  });

  test('handles next_strategy_in field', () => {
    const raw = JSON.stringify({
      single_deliverable: 'Work on X',
      reflection: 'Planning ahead',
      goal_operations: [],
      next_strategy_in: '2h',
    });
    const result = parseStrategistResult(raw, mockLogger);
    expect(result).not.toBeNull();
    expect(result?.next_strategy_in).toBe('2h');
  });

  test('non-array goal_operations defaults to empty array', () => {
    const raw = JSON.stringify({
      single_deliverable: 'Do things',
      reflection: 'Reflect on it',
      goal_operations: 'not an array',
    });
    const result = parseStrategistResult(raw, mockLogger);
    expect(result).not.toBeNull();
    expect(result?.goal_operations).toEqual([]);
  });

  test('JSON wrapped in markdown code fence is parsed', () => {
    const inner = JSON.stringify({
      focus: 'Build API',
      reflection: 'API first approach',
      goal_operations: [],
    });
    const raw = `\`\`\`json\n${inner}\n\`\`\``;
    const result = parseStrategistResult(raw, mockLogger);
    expect(result).not.toBeNull();
    expect(result?.single_deliverable).toBe('Build API');
  });
});

// ---------- shouldRunStrategist ----------

describe('shouldRunStrategist', () => {
  const botId = 'test-bot';

  const baseBotConfig = {
    name: 'TestBot',
    token: 'x',
    soul: 'test',
  } as any;

  const globalConfig = {
    enabled: true,
    everyCycles: 4,
    minInterval: '4h',
  };

  test('returns false when disabled globally', () => {
    const disabledConfig = { ...globalConfig, enabled: false };
    expect(shouldRunStrategist(botId, baseBotConfig, disabledConfig)).toBe(false);
  });

  test('returns false when disabled by bot override', () => {
    const botConfigWithOverride = {
      ...baseBotConfig,
      agentLoop: { strategist: { enabled: false } },
    } as any;
    expect(shouldRunStrategist(botId, botConfigWithOverride, globalConfig)).toBe(false);
  });

  test('first run (no schedule) always returns true', () => {
    expect(shouldRunStrategist(botId, baseBotConfig, globalConfig)).toBe(true);
    expect(shouldRunStrategist(botId, baseBotConfig, globalConfig, undefined)).toBe(true);
  });

  test('cycle count condition met and interval met returns true', () => {
    const schedule = {
      strategistCycleCount: 4,
      lastStrategistAt: Date.now() - 5 * 3_600_000, // 5 hours ago
    };
    expect(shouldRunStrategist(botId, baseBotConfig, globalConfig, schedule)).toBe(true);
  });

  test('cycle count not met returns false', () => {
    const schedule = {
      strategistCycleCount: 2,
      lastStrategistAt: Date.now() - 5 * 3_600_000, // 5 hours ago (interval met)
    };
    expect(shouldRunStrategist(botId, baseBotConfig, globalConfig, schedule)).toBe(false);
  });

  test('interval not met returns false', () => {
    const schedule = {
      strategistCycleCount: 10, // cycles met
      lastStrategistAt: Date.now() - 1_000, // 1 second ago (interval not met)
    };
    expect(shouldRunStrategist(botId, baseBotConfig, globalConfig, schedule)).toBe(false);
  });

  test('both conditions must be met', () => {
    // cycles not met, interval not met
    const schedule = {
      strategistCycleCount: 1,
      lastStrategistAt: Date.now() - 1_000,
    };
    expect(shouldRunStrategist(botId, baseBotConfig, globalConfig, schedule)).toBe(false);
  });

  test('lastStrategistAt null means interval is always met', () => {
    const schedule = {
      strategistCycleCount: 4,
      lastStrategistAt: null,
    };
    expect(shouldRunStrategist(botId, baseBotConfig, globalConfig, schedule)).toBe(true);
  });

  test('per-bot override for everyCycles', () => {
    const botConfigWithOverride = {
      ...baseBotConfig,
      agentLoop: { strategist: { everyCycles: 2 } },
    } as any;
    const schedule = {
      strategistCycleCount: 2,
      lastStrategistAt: Date.now() - 5 * 3_600_000,
    };
    expect(shouldRunStrategist(botId, botConfigWithOverride, globalConfig, schedule)).toBe(true);

    // Would fail with global everyCycles=4 but passes with bot override=2
    const scheduleNotEnough = {
      strategistCycleCount: 3,
      lastStrategistAt: Date.now() - 5 * 3_600_000,
    };
    expect(shouldRunStrategist(botId, botConfigWithOverride, globalConfig, scheduleNotEnough)).toBe(
      true
    );
  });

  test('per-bot override for minInterval', () => {
    const botConfigWithOverride = {
      ...baseBotConfig,
      agentLoop: { strategist: { minInterval: '1m' } },
    } as any;
    const schedule = {
      strategistCycleCount: 4,
      lastStrategistAt: Date.now() - 2 * 60_000, // 2 minutes ago
    };
    // With bot override of 1m, 2 minutes ago is enough
    expect(shouldRunStrategist(botId, botConfigWithOverride, globalConfig, schedule)).toBe(true);
  });
});

// ---------- computeCyclesUntilStrategist ----------

describe('computeCyclesUntilStrategist', () => {
  const globalConfig = { everyCycles: 4 };

  test('basic computation', () => {
    const result = computeCyclesUntilStrategist(undefined, globalConfig, {
      strategistCycleCount: 1,
    });
    expect(result).toBe(3); // 4 - 1
  });

  test('returns 0 when cycle count meets threshold', () => {
    const result = computeCyclesUntilStrategist(undefined, globalConfig, {
      strategistCycleCount: 4,
    });
    expect(result).toBe(0);
  });

  test('returns 0 when cycle count exceeds threshold', () => {
    const result = computeCyclesUntilStrategist(undefined, globalConfig, {
      strategistCycleCount: 10,
    });
    expect(result).toBe(0);
  });

  test('uses bot override everyCycles', () => {
    const botConfig = {
      agentLoop: { strategist: { everyCycles: 2 } },
    } as any;
    const result = computeCyclesUntilStrategist(botConfig, globalConfig, {
      strategistCycleCount: 1,
    });
    expect(result).toBe(1); // 2 - 1
  });

  test('bot override takes priority over global', () => {
    const botConfig = {
      agentLoop: { strategist: { everyCycles: 10 } },
    } as any;
    const result = computeCyclesUntilStrategist(botConfig, globalConfig, {
      strategistCycleCount: 3,
    });
    expect(result).toBe(7); // 10 - 3
  });

  test('already at 0 with no bot config', () => {
    const result = computeCyclesUntilStrategist(undefined, globalConfig, {
      strategistCycleCount: 5,
    });
    expect(result).toBe(0);
  });
});

// ---------- applyGoalOperations ----------

describe('applyGoalOperations', () => {
  const botId = 'test-bot';

  let mockSoulLoader: {
    readGoals: ReturnType<typeof vi.fn>;
    writeGoals: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    resetLogger();
    mockSoulLoader = {
      readGoals: vi.fn().mockReturnValue(''),
      writeGoals: vi.fn(),
    };
  });

  test('add operation creates a new goal', () => {
    const ops: GoalOperation[] = [
      { action: 'add', goal: 'Learn TypeScript', priority: 'high', notes: 'Start today' },
    ];

    applyGoalOperations(botId, ops, mockLogger as any, mockSoulLoader as any);

    expect(mockSoulLoader.writeGoals).toHaveBeenCalledTimes(1);
    const written = mockSoulLoader.writeGoals.mock.calls[0][0] as string;
    const parsed = parseGoals(written);
    expect(parsed.active).toHaveLength(1);
    expect(parsed.active[0].text).toBe('Learn TypeScript');
    expect(parsed.active[0].priority).toBe('high');
    expect(parsed.active[0].notes).toBe('Start today');
    expect(parsed.active[0].status).toBe('pending');
  });

  test('add operation defaults priority to medium', () => {
    const ops: GoalOperation[] = [{ action: 'add', goal: 'Default priority goal' }];

    applyGoalOperations(botId, ops, mockLogger as any, mockSoulLoader as any);

    const written = mockSoulLoader.writeGoals.mock.calls[0][0] as string;
    const parsed = parseGoals(written);
    expect(parsed.active[0].priority).toBe('medium');
  });

  test('complete operation moves goal from active to completed', () => {
    const existingGoals = serializeGoals(
      [
        { text: 'Finish the report', status: 'in_progress', priority: 'high' },
        { text: 'Review PR', status: 'pending', priority: 'medium' },
      ],
      []
    );
    mockSoulLoader.readGoals.mockReturnValue(existingGoals);

    const ops: GoalOperation[] = [
      { action: 'complete', goal: 'finish the report', outcome: 'Report submitted' },
    ];

    applyGoalOperations(botId, ops, mockLogger as any, mockSoulLoader as any);

    const written = mockSoulLoader.writeGoals.mock.calls[0][0] as string;
    const parsed = parseGoals(written);
    expect(parsed.active).toHaveLength(1);
    expect(parsed.active[0].text).toBe('Review PR');
    expect(parsed.completed).toHaveLength(1);
    expect(parsed.completed[0].text).toBe('Finish the report');
    expect(parsed.completed[0].status).toBe('completed');
    expect(parsed.completed[0].outcome).toBe('Report submitted');
  });

  test('update operation modifies an existing goal', () => {
    const existingGoals = serializeGoals(
      [{ text: 'Build the dashboard', status: 'pending', priority: 'medium' }],
      []
    );
    mockSoulLoader.readGoals.mockReturnValue(existingGoals);

    const ops: GoalOperation[] = [
      {
        action: 'update',
        goal: 'build the dashboard',
        status: 'in_progress',
        priority: 'high',
        notes: 'Started work',
      },
    ];

    applyGoalOperations(botId, ops, mockLogger as any, mockSoulLoader as any);

    const written = mockSoulLoader.writeGoals.mock.calls[0][0] as string;
    const parsed = parseGoals(written);
    expect(parsed.active).toHaveLength(1);
    expect(parsed.active[0].status).toBe('in_progress');
    expect(parsed.active[0].priority).toBe('high');
    expect(parsed.active[0].notes).toBe('Started work');
  });

  test('remove operation deletes a goal', () => {
    const existingGoals = serializeGoals(
      [
        { text: 'Obsolete task', status: 'pending', priority: 'low' },
        { text: 'Keep this one', status: 'pending', priority: 'medium' },
      ],
      []
    );
    mockSoulLoader.readGoals.mockReturnValue(existingGoals);

    const ops: GoalOperation[] = [{ action: 'remove', goal: 'obsolete task' }];

    applyGoalOperations(botId, ops, mockLogger as any, mockSoulLoader as any);

    const written = mockSoulLoader.writeGoals.mock.calls[0][0] as string;
    const parsed = parseGoals(written);
    expect(parsed.active).toHaveLength(1);
    expect(parsed.active[0].text).toBe('Keep this one');
  });

  test('complete with goal not found logs debug and skips', () => {
    mockSoulLoader.readGoals.mockReturnValue('');

    const ops: GoalOperation[] = [{ action: 'complete', goal: 'nonexistent goal' }];

    applyGoalOperations(botId, ops, mockLogger as any, mockSoulLoader as any);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      { goal: 'nonexistent goal' },
      'Strategist: goal to complete not found, skipping'
    );
  });

  test('update with goal not found logs debug and skips', () => {
    mockSoulLoader.readGoals.mockReturnValue('');

    const ops: GoalOperation[] = [{ action: 'update', goal: 'ghost goal', status: 'in_progress' }];

    applyGoalOperations(botId, ops, mockLogger as any, mockSoulLoader as any);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      { goal: 'ghost goal' },
      'Strategist: goal to update not found, skipping'
    );
  });

  test('remove with goal not found logs debug and skips', () => {
    mockSoulLoader.readGoals.mockReturnValue('');

    const ops: GoalOperation[] = [{ action: 'remove', goal: 'missing goal' }];

    applyGoalOperations(botId, ops, mockLogger as any, mockSoulLoader as any);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      { goal: 'missing goal' },
      'Strategist: goal to remove not found, skipping'
    );
  });

  test('readGoals returning null is handled gracefully', () => {
    mockSoulLoader.readGoals.mockReturnValue(null);

    const ops: GoalOperation[] = [{ action: 'add', goal: 'First goal ever' }];

    applyGoalOperations(botId, ops, mockLogger as any, mockSoulLoader as any);

    const written = mockSoulLoader.writeGoals.mock.calls[0][0] as string;
    const parsed = parseGoals(written);
    expect(parsed.active).toHaveLength(1);
    expect(parsed.active[0].text).toBe('First goal ever');
  });

  test('multiple operations applied in sequence', () => {
    const existingGoals = serializeGoals(
      [
        { text: 'Task A', status: 'pending', priority: 'medium' },
        { text: 'Task B', status: 'pending', priority: 'low' },
      ],
      []
    );
    mockSoulLoader.readGoals.mockReturnValue(existingGoals);

    const ops: GoalOperation[] = [
      { action: 'add', goal: 'Task C', priority: 'high' },
      { action: 'complete', goal: 'task a', outcome: 'Done' },
      { action: 'remove', goal: 'task b' },
    ];

    applyGoalOperations(botId, ops, mockLogger as any, mockSoulLoader as any);

    const written = mockSoulLoader.writeGoals.mock.calls[0][0] as string;
    const parsed = parseGoals(written);
    expect(parsed.active).toHaveLength(1);
    expect(parsed.active[0].text).toBe('Task C');
    expect(parsed.completed).toHaveLength(1);
    expect(parsed.completed[0].text).toBe('Task A');
  });
});
