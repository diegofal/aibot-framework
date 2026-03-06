import { describe, expect, test } from 'bun:test';
import {
  computeRetryDelay,
  isRetryableError,
  parseDurationMs,
  parseStrategistResult,
} from '../src/bot/agent-loop';
import {
  buildContinuousPlannerPrompt,
  buildExecutorPrompt,
  buildPlannerPrompt,
  buildStrategistPrompt,
} from '../src/bot/agent-loop-prompts';
import {
  AgentLoopRetryConfigSchema,
  BotAgentLoopOverrideSchema,
  GlobalAgentLoopConfigSchema,
} from '../src/config';
import { parseGoals, serializeGoals } from '../src/tools/goals';

describe('parseDurationMs', () => {
  test('parses milliseconds', () => {
    expect(parseDurationMs('500ms')).toBe(500);
  });

  test('parses seconds', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
  });

  test('parses minutes', () => {
    expect(parseDurationMs('1m')).toBe(60_000);
  });

  test('parses hours', () => {
    expect(parseDurationMs('6h')).toBe(21_600_000);
  });

  test('parses days', () => {
    expect(parseDurationMs('1d')).toBe(86_400_000);
  });

  test('is case-insensitive', () => {
    expect(parseDurationMs('5M')).toBe(300_000);
    expect(parseDurationMs('2H')).toBe(7_200_000);
  });

  test('throws on invalid format', () => {
    expect(() => parseDurationMs('abc')).toThrow('Invalid duration');
    expect(() => parseDurationMs('')).toThrow('Invalid duration');
    expect(() => parseDurationMs('10x')).toThrow('Invalid duration');
  });

  test('throws on missing unit', () => {
    expect(() => parseDurationMs('100')).toThrow('Invalid duration');
  });

  test('throws on missing value', () => {
    expect(() => parseDurationMs('ms')).toThrow('Invalid duration');
  });
});

describe('error backoff formula', () => {
  test('uses 5-minute floor when normal interval is shorter', () => {
    const normalMs = parseDurationMs('1m'); // 60_000
    const errorFloorMs = 5 * 60_000;
    expect(Math.max(normalMs, errorFloorMs)).toBe(300_000);
  });

  test('uses normal interval when longer than 5 minutes', () => {
    const normalMs = parseDurationMs('6h'); // 21_600_000
    const errorFloorMs = 5 * 60_000;
    expect(Math.max(normalMs, errorFloorMs)).toBe(21_600_000);
  });

  test('uses exactly 5 minutes when normal interval is 5m', () => {
    const normalMs = parseDurationMs('5m'); // 300_000
    const errorFloorMs = 5 * 60_000;
    expect(Math.max(normalMs, errorFloorMs)).toBe(300_000);
  });
});

describe('planner prompt — novelty imperative', () => {
  const baseInput = {
    identity: 'test',
    soul: 'test',
    motivations: 'test',
    goals: '',
    recentMemory: '',
    datetime: '2026-01-01',
    availableTools: ['ask_human', 'save_memory', 'manage_goals'],
    hasCreateTool: false,
  };

  test('does NOT contain should_act or skip_reason', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).not.toContain('should_act');
    expect(system).not.toContain('skip_reason');
    expect(system).not.toContain('next_check_in');
  });

  test('contains NOVELTY IMPERATIVE (not SURVIVAL IMPERATIVE)', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain('NOVELTY IMPERATIVE');
    expect(system).not.toContain('SURVIVAL IMPERATIVE');
    expect(system).not.toContain('eliminated');
  });

  test('includes priority with "none" option in the JSON schema', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain('"priority"');
    expect(system).toContain('"high" | "medium" | "low" | "none"');
  });

  test('contains anti-patterns instead of self-improvement', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain('ANTI-PATTERNS');
    expect(system).toContain('Reviewing goals just to review them');
    expect(system).toContain('Saving "reflections" to memory');
    expect(system).toContain('Verifying documents you already verified');
    expect(system).not.toContain('self-improvement');
  });

  test('suggests boundary-pushing activities', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain('Push into unfamiliar territory');
    expect(system).toContain('Challenge your own assumptions');
    expect(system).toContain('Find blind spots');
  });

  test('includes ask_human guidance with HUMAN COLLABORATION block', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain('HUMAN COLLABORATION');
    expect(system).toContain('ask_human');
    expect(system).toContain('NON-BLOCKING');
    expect(system).toContain('Do NOT return priority "none" when you could ask the human instead');
  });

  test('HUMAN COLLABORATION uses proactive language, not "cannot determine on your own"', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain("proactively ask when the human's preference matters");
    expect(system).not.toContain('you cannot determine on your own');
    expect(system).toContain(
      'When unsure between two approaches, ask the human instead of guessing'
    );
  });

  test('priority "none" definition requires having already called ask_human', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain('Return this ONLY after you have already called ask_human');
    expect(system).toContain('your priority is at least "low" with a plan that includes ask_human');
    expect(system).not.toContain('genuinely impossible to start AND you cannot make progress');
  });

  test('prompt instructs to do something different on repetition', () => {
    const { prompt } = buildPlannerPrompt(baseInput);
    expect(prompt).toContain('repetition');
    expect(prompt).toContain('MUST do something different');
  });

  test('examples show ask_human for decisions, not just blocked deliverables', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain('asking operator for preference');
    expect(system).toContain('"priority":"medium"');
    expect(system).not.toContain('"reasoning":"Deliverable blocked — waiting for human approval');
  });

  test('injects recentActionsDigest when provided', () => {
    const { system } = buildPlannerPrompt({
      ...baseInput,
      recentActionsDigest: '## Recent Actions (last 24h)\n- 2h ago: Reviewed goals',
    });
    expect(system).toContain('## Recent Actions (last 24h)');
    expect(system).toContain('Reviewed goals');
  });

  test('injects karmaBlock when provided', () => {
    const { system } = buildPlannerPrompt({
      ...baseInput,
      karmaBlock: '## Your Karma: 65/100 (rising ↑)',
    });
    expect(system).toContain('65/100');
    expect(system).toContain('rising');
  });

  test('omits recentActionsDigest when not provided', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).not.toContain('## Recent Actions');
  });

  test('injects autonomousCyclesNote when provided', () => {
    const { system } = buildPlannerPrompt({
      ...baseInput,
      autonomousCyclesNote:
        '## Autonomous Run Notice\n\nYou have been running autonomously for 7 cycles without checking in with your human operator.',
    });
    expect(system).toContain('## Autonomous Run Notice');
    expect(system).toContain('7 cycles');
    expect(system).toContain('checking in with your human operator');
  });

  test('omits autonomousCyclesNote when not provided', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).not.toContain('Autonomous Run Notice');
  });
});

describe('planner prompt — goals bootstrap', () => {
  test('includes bootstrap instruction when goals are empty', () => {
    const { system } = buildPlannerPrompt({
      identity: 'test',
      soul: 'test',
      motivations: 'test',
      goals: '',
      recentMemory: '',
      datetime: '2026-01-01',
      availableTools: ['manage_goals'],
      hasCreateTool: false,
    });
    expect(system).toContain('No goals yet');
    expect(system).toContain('manage_goals');
    expect(system).toContain('FIRST priority');
  });

  test('shows actual goals when goals are provided', () => {
    const { system } = buildPlannerPrompt({
      identity: 'test',
      soul: 'test',
      motivations: 'test',
      goals: '- Goal 1: Ship feature X',
      recentMemory: '',
      datetime: '2026-01-01',
      availableTools: ['manage_goals'],
      hasCreateTool: false,
    });
    expect(system).toContain('Goal 1: Ship feature X');
    expect(system).not.toContain('No goals yet');
  });
});

describe('executor prompt — goals bootstrap', () => {
  test('includes bootstrap instruction when goals are empty', () => {
    const { buildExecutorPrompt } = require('../src/bot/agent-loop-prompts');
    const result = buildExecutorPrompt({
      plan: ['Create initial goals'],
      identity: 'test',
      soul: 'test',
      motivations: 'test',
      goals: '',
      datetime: '2026-01-01',
      hasCreateTool: false,
    });
    expect(result).toContain('No goals yet');
    expect(result).toContain('manage_goals');
  });

  test('shows actual goals when goals are provided', () => {
    const { buildExecutorPrompt } = require('../src/bot/agent-loop-prompts');
    const result = buildExecutorPrompt({
      plan: ['Update goals'],
      identity: 'test',
      soul: 'test',
      motivations: 'test',
      goals: '- Goal 1: Ship feature X',
      datetime: '2026-01-01',
      hasCreateTool: false,
    });
    expect(result).toContain('Goal 1: Ship feature X');
    expect(result).not.toContain('No goals yet');
  });

  test('includes ask_human guidance in executor prompt', () => {
    const { buildExecutorPrompt } = require('../src/bot/agent-loop-prompts');
    const result = buildExecutorPrompt({
      plan: ['Gather requirements from operator'],
      identity: 'test',
      soul: 'test',
      motivations: 'test',
      goals: '- [ ] Goal A',
      datetime: '2026-01-01',
      hasCreateTool: false,
      workDir: './productions/test-bot',
    });
    expect(result).toContain('ask_human');
    expect(result).toContain('non-blocking');
    expect(result).toContain('human inbox');
  });
});

describe('buildStrategistPrompt', () => {
  test('generates prompt with goals and identity', () => {
    const { system, prompt } = buildStrategistPrompt({
      identity: 'I am cryptik, a crypto analyst',
      soul: 'Deep thinker',
      motivations: 'Track DeFi trends',
      goals: '- [ ] Monitor Ethereum\n  - status: in_progress',
      recentMemory: '### 2026-02-19\nChecked ETH price',
      datetime: '2026-02-20T10:00:00Z',
    });
    expect(system).toContain('cryptik');
    expect(system).toContain('Monitor Ethereum');
    expect(system).toContain('Checked ETH price');
    expect(system).toContain('Staleness');
    expect(system).toContain('goal_operations');
    expect(prompt).toContain('strategic review');
  });

  test('handles empty goals', () => {
    const { system } = buildStrategistPrompt({
      identity: 'test bot',
      soul: '',
      motivations: 'be helpful',
      goals: '',
      recentMemory: '',
      datetime: '2026-02-20T10:00:00Z',
    });
    expect(system).toContain('(no goals set)');
  });

  test('deliverable sizing allows ask_human as alternative to no-dependencies', () => {
    const { system } = buildStrategistPrompt({
      identity: 'test bot',
      soul: '',
      motivations: 'be helpful',
      goals: '- [ ] Goal A',
      recentMemory: '',
      datetime: '2026-02-20T10:00:00Z',
    });
    expect(system).toContain('ask_human');
    expect(system).toContain('Self-Contained OR Ask');
    expect(system).not.toContain('No Dependencies');
  });

  test('includes ask_human deliverable examples', () => {
    const { system } = buildStrategistPrompt({
      identity: 'test bot',
      soul: '',
      motivations: 'be helpful',
      goals: '- [ ] Goal A',
      recentMemory: '',
      datetime: '2026-02-20T10:00:00Z',
    });
    expect(system).toContain('Ask the operator which social channels to prioritize');
    expect(system).toContain('Check in with the operator');
  });

  test('includes human check-in cadence rules', () => {
    const { system } = buildStrategistPrompt({
      identity: 'test bot',
      soul: '',
      motivations: 'be helpful',
      goals: '- [ ] Goal A',
      recentMemory: '',
      datetime: '2026-02-20T10:00:00Z',
    });
    expect(system).toContain('Human Check-In Cadence');
    expect(system).toContain('Every 3-5 sessions');
    expect(system).toContain('checking in with the human operator');
  });
});

describe('planner prompt with strategic focus', () => {
  test('includes Strategic Focus section when focus is provided', () => {
    const { system } = buildPlannerPrompt({
      identity: 'test',
      soul: 'test',
      motivations: 'test',
      goals: '- [ ] Goal A',
      recentMemory: '',
      datetime: '2026-01-01',
      availableTools: ['save_memory'],
      hasCreateTool: false,
      focus: 'Focus on outreach instead of internal tooling',
    });
    expect(system).toContain('## Strategic Focus');
    expect(system).toContain('Focus on outreach instead of internal tooling');
    expect(system).toContain('trust the focus');
  });

  test('omits Strategic Focus section when focus is absent', () => {
    const { system } = buildPlannerPrompt({
      identity: 'test',
      soul: 'test',
      motivations: 'test',
      goals: '- [ ] Goal A',
      recentMemory: '',
      datetime: '2026-01-01',
      availableTools: ['save_memory'],
      hasCreateTool: false,
    });
    expect(system).not.toContain('## Strategic Focus');
  });
});

describe('parseGoals / serializeGoals exports', () => {
  test('parseGoals handles null content', () => {
    const result = parseGoals(null);
    expect(result.active).toEqual([]);
    expect(result.completed).toEqual([]);
  });

  test('parseGoals parses active goals', () => {
    const content = `## Active Goals
- [ ] Build dashboard
  - status: in_progress
  - priority: high
  - notes: WIP

## Completed
- [x] Set up repo
  - completed: 2026-01-15
  - outcome: Done
`;
    const { active, completed } = parseGoals(content);
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe('Build dashboard');
    expect(active[0].status).toBe('in_progress');
    expect(active[0].priority).toBe('high');
    expect(active[0].notes).toBe('WIP');
    expect(completed).toHaveLength(1);
    expect(completed[0].text).toBe('Set up repo');
    expect(completed[0].outcome).toBe('Done');
  });

  test('round-trip: serialize then parse preserves data', () => {
    const active = [
      { text: 'Goal A', status: 'pending', priority: 'high', notes: 'some notes' },
      { text: 'Goal B', status: 'in_progress', priority: 'low' },
    ];
    const completed = [
      {
        text: 'Goal C',
        status: 'completed',
        priority: 'medium',
        completed: '2026-01-10',
        outcome: 'Shipped',
      },
    ];
    const serialized = serializeGoals(active, completed);
    const parsed = parseGoals(serialized);

    expect(parsed.active).toHaveLength(2);
    expect(parsed.active[0].text).toBe('Goal A');
    expect(parsed.active[0].priority).toBe('high');
    expect(parsed.active[0].notes).toBe('some notes');
    expect(parsed.active[1].text).toBe('Goal B');
    expect(parsed.completed).toHaveLength(1);
    expect(parsed.completed[0].text).toBe('Goal C');
    expect(parsed.completed[0].outcome).toBe('Shipped');
  });
});

describe('strategist cycle counting logic', () => {
  test('AND condition: both cycles and interval must be met', () => {
    // Simulates the shouldRunStrategist logic
    const everyCycles = 4;
    const minIntervalMs = parseDurationMs('4h');

    // Case 1: enough cycles but not enough time
    const cyclesMet1 = 5 >= everyCycles;
    const intervalMet1 = Date.now() - (Date.now() - 3_600_000) >= minIntervalMs; // 1h ago
    expect(cyclesMet1 && intervalMet1).toBe(false);

    // Case 2: enough time but not enough cycles
    const cyclesMet2 = 2 >= everyCycles;
    const intervalMet2 = Date.now() - (Date.now() - 5 * 3_600_000) >= minIntervalMs; // 5h ago
    expect(cyclesMet2 && intervalMet2).toBe(false);

    // Case 3: both met
    const cyclesMet3 = 4 >= everyCycles;
    const intervalMet3 = Date.now() - (Date.now() - 5 * 3_600_000) >= minIntervalMs; // 5h ago
    expect(cyclesMet3 && intervalMet3).toBe(true);
  });

  test('first run (no lastStrategistAt) always meets interval condition', () => {
    const lastStrategistAt: number | null = null;
    const intervalMet = lastStrategistAt === null;
    expect(intervalMet).toBe(true);
  });
});

describe('parseStrategistResult', () => {
  const noopLogger = { warn: () => {} };

  test('parses result with focus field', () => {
    const raw = JSON.stringify({
      goal_operations: [],
      focus: 'Write unit tests',
      reflection: 'Tests are lacking',
    });
    const result = parseStrategistResult(raw, noopLogger);
    expect(result).not.toBeNull();
    expect(result?.focus).toBe('Write unit tests');
    expect(result?.single_deliverable).toBe('Write unit tests');
    expect(result?.reflection).toBe('Tests are lacking');
  });

  test('parses result with single_deliverable field', () => {
    const raw = JSON.stringify({
      goal_operations: [],
      single_deliverable: 'Deploy the API endpoint',
      reflection: 'API is ready',
    });
    const result = parseStrategistResult(raw, noopLogger);
    expect(result).not.toBeNull();
    expect(result?.single_deliverable).toBe('Deploy the API endpoint');
    expect(result?.focus).toBe('Deploy the API endpoint');
    expect(result?.reflection).toBe('API is ready');
  });

  test('prefers single_deliverable over focus when both present', () => {
    const raw = JSON.stringify({
      goal_operations: [],
      single_deliverable: 'New deliverable',
      focus: 'Old focus',
      reflection: 'Both present',
    });
    const result = parseStrategistResult(raw, noopLogger);
    expect(result).not.toBeNull();
    expect(result?.single_deliverable).toBe('New deliverable');
    expect(result?.focus).toBe('New deliverable');
  });

  test('returns null when neither focus nor single_deliverable present', () => {
    const raw = JSON.stringify({
      goal_operations: [],
      reflection: 'Missing deliverable',
    });
    const result = parseStrategistResult(raw, noopLogger);
    expect(result).toBeNull();
  });

  test('returns null when reflection is missing', () => {
    const raw = JSON.stringify({
      goal_operations: [],
      single_deliverable: 'Something',
    });
    const result = parseStrategistResult(raw, noopLogger);
    expect(result).toBeNull();
  });

  test('strips markdown fences', () => {
    const raw = `\`\`\`json\n${JSON.stringify({
      goal_operations: [],
      single_deliverable: 'Fenced result',
      reflection: 'Was fenced',
    })}\n\`\`\``;
    const result = parseStrategistResult(raw, noopLogger);
    expect(result).not.toBeNull();
    expect(result?.single_deliverable).toBe('Fenced result');
  });

  test('extracts JSON from surrounding prose with single_deliverable', () => {
    const json = JSON.stringify({
      goal_operations: [],
      single_deliverable: 'Embedded result',
      reflection: 'Surrounded by prose',
    });
    const raw = `Here is my analysis:\n${json}\nThat's my plan.`;
    const result = parseStrategistResult(raw, noopLogger);
    expect(result).not.toBeNull();
    expect(result?.single_deliverable).toBe('Embedded result');
  });

  test('returns null for invalid JSON', () => {
    const result = parseStrategistResult('not json at all', noopLogger);
    expect(result).toBeNull();
  });

  test('handles goal_operations and next_strategy_in', () => {
    const raw = JSON.stringify({
      goal_operations: [{ action: 'add', goal: 'New goal', priority: 'high' }],
      single_deliverable: 'Do something',
      reflection: 'Looks good',
      next_strategy_in: '2h',
    });
    const result = parseStrategistResult(raw, noopLogger);
    expect(result).not.toBeNull();
    expect(result?.goal_operations).toHaveLength(1);
    expect(result?.goal_operations[0].action).toBe('add');
    expect(result?.next_strategy_in).toBe('2h');
  });
});

describe('buildContinuousPlannerPrompt', () => {
  const baseInput = {
    identity: 'I am a continuous bot',
    soul: 'Always working',
    motivations: 'Never stop improving',
    goals: '- [ ] Goal A\n  - status: in_progress',
    recentMemory: 'Did something earlier',
    datetime: '2026-02-20T12:00:00Z',
    availableTools: ['save_memory', 'manage_goals'],
    hasCreateTool: false,
  };

  test('does not include should_act in the prompt', () => {
    const { system } = buildContinuousPlannerPrompt(baseInput);
    expect(system).not.toContain('should_act');
  });

  test('contains NOVELTY IMPERATIVE', () => {
    const { system } = buildContinuousPlannerPrompt(baseInput);
    expect(system).toContain('NOVELTY IMPERATIVE');
    expect(system).not.toContain('SURVIVAL IMPERATIVE');
  });

  test('includes priority with "none" option in the JSON schema', () => {
    const { system } = buildContinuousPlannerPrompt(baseInput);
    expect(system).toContain('"priority"');
    expect(system).toContain('"high" | "medium" | "low" | "none"');
  });

  test('contains anti-patterns', () => {
    const { system } = buildContinuousPlannerPrompt(baseInput);
    expect(system).toContain('ANTI-PATTERNS');
    expect(system).toContain('Reviewing goals just to review them');
  });

  test('includes HUMAN COLLABORATION block with ask_human guidance', () => {
    const { system } = buildContinuousPlannerPrompt(baseInput);
    expect(system).toContain('HUMAN COLLABORATION');
    expect(system).toContain('ask_human');
    expect(system).toContain('NON-BLOCKING');
    expect(system).toContain('Do NOT return priority "none" when you could ask the human instead');
  });

  test('includes last cycle summary when provided', () => {
    const { system } = buildContinuousPlannerPrompt({
      ...baseInput,
      lastCycleSummary: 'Updated goals and saved findings to memory.',
    });
    expect(system).toContain('Last Cycle Result');
    expect(system).toContain('Updated goals and saved findings to memory.');
    expect(system).toContain('build on what was done');
  });

  test('omits last cycle summary when not provided', () => {
    const { system } = buildContinuousPlannerPrompt(baseInput);
    expect(system).not.toContain('Last Cycle Result');
  });

  test('includes strategic focus when provided', () => {
    const { system } = buildContinuousPlannerPrompt({
      ...baseInput,
      focus: 'Focus on outreach',
    });
    expect(system).toContain('## Strategic Focus');
    expect(system).toContain('Focus on outreach');
  });

  test('includes goals bootstrap when goals are empty', () => {
    const { system } = buildContinuousPlannerPrompt({
      ...baseInput,
      goals: '',
    });
    expect(system).toContain('No goals yet');
    expect(system).toContain('manage_goals');
  });

  test('includes create_tool guidance when available', () => {
    const { system } = buildContinuousPlannerPrompt({
      ...baseInput,
      hasCreateTool: true,
    });
    expect(system).toContain('create_tool');
    expect(system).toContain('Dynamic Tool Creation');
  });

  test('injects autonomousCyclesNote when provided', () => {
    const { system } = buildContinuousPlannerPrompt({
      ...baseInput,
      autonomousCyclesNote:
        '## Autonomous Run Notice\n\nYou have been running autonomously for 10 cycles.',
    });
    expect(system).toContain('## Autonomous Run Notice');
    expect(system).toContain('10 cycles');
  });

  test('omits autonomousCyclesNote when not provided', () => {
    const { system } = buildContinuousPlannerPrompt(baseInput);
    expect(system).not.toContain('Autonomous Run Notice');
  });

  test('HUMAN COLLABORATION uses proactive language in continuous mode', () => {
    const { system } = buildContinuousPlannerPrompt(baseInput);
    expect(system).toContain("proactively ask when the human's preference matters");
    expect(system).not.toContain('you cannot determine on your own');
  });

  test('priority "none" requires ask_human first in continuous mode', () => {
    const { system } = buildContinuousPlannerPrompt(baseInput);
    expect(system).toContain('Return this ONLY after you have already called ask_human');
  });
});

describe('continuous mode config defaults', () => {
  test('mode defaults to periodic', () => {
    const result = BotAgentLoopOverrideSchema.parse({});
    expect(result?.mode).toBe('periodic');
  });

  test('continuousPauseMs defaults to 5000', () => {
    const result = BotAgentLoopOverrideSchema.parse({});
    expect(result?.continuousPauseMs).toBe(5_000);
  });

  test('continuousMemoryEvery defaults to 5', () => {
    const result = BotAgentLoopOverrideSchema.parse({});
    expect(result?.continuousMemoryEvery).toBe(5);
  });

  test('accepts continuous mode', () => {
    const result = BotAgentLoopOverrideSchema.parse({ mode: 'continuous' });
    expect(result?.mode).toBe('continuous');
  });

  test('accepts custom pause and memory values', () => {
    const result = BotAgentLoopOverrideSchema.parse({
      mode: 'continuous',
      continuousPauseMs: 10_000,
      continuousMemoryEvery: 3,
    });
    expect(result?.continuousPauseMs).toBe(10_000);
    expect(result?.continuousMemoryEvery).toBe(3);
  });

  test('rejects invalid mode', () => {
    expect(() => BotAgentLoopOverrideSchema.parse({ mode: 'invalid' })).toThrow();
  });

  test('rejects negative continuousPauseMs', () => {
    expect(() => BotAgentLoopOverrideSchema.parse({ continuousPauseMs: -1 })).toThrow();
  });

  test('rejects zero continuousMemoryEvery', () => {
    expect(() => BotAgentLoopOverrideSchema.parse({ continuousMemoryEvery: 0 })).toThrow();
  });
});

describe('memory throttling logic', () => {
  // Mirrors the logic in executeSingleBot for continuous bots
  const shouldLogMemory = (cycleCount: number, memoryEvery: number) => {
    return (cycleCount + 1) % memoryEvery === 0;
  };

  test('logs on cycle that matches memoryEvery', () => {
    // With memoryEvery=5, logs on cycles 4, 9, 14... (0-indexed, +1 inside)
    expect(shouldLogMemory(4, 5)).toBe(true); // cycle 5 (1-indexed)
    expect(shouldLogMemory(9, 5)).toBe(true); // cycle 10
    expect(shouldLogMemory(14, 5)).toBe(true); // cycle 15
  });

  test('does not log on non-matching cycles', () => {
    expect(shouldLogMemory(0, 5)).toBe(false); // cycle 1
    expect(shouldLogMemory(1, 5)).toBe(false); // cycle 2
    expect(shouldLogMemory(2, 5)).toBe(false); // cycle 3
    expect(shouldLogMemory(3, 5)).toBe(false); // cycle 4
    expect(shouldLogMemory(5, 5)).toBe(false); // cycle 6
  });

  test('logs every cycle when memoryEvery=1', () => {
    expect(shouldLogMemory(0, 1)).toBe(true);
    expect(shouldLogMemory(1, 1)).toBe(true);
    expect(shouldLogMemory(2, 1)).toBe(true);
  });
});

describe('interruptibleSleep concurrency', () => {
  // Since interruptibleSleep is private, we replicate the same Set<AbortController> pattern
  // to verify the concurrency fix works correctly.

  function interruptibleSleep(controllers: Set<AbortController>, ms: number): Promise<void> {
    const controller = new AbortController();
    controllers.add(controller);
    const { signal } = controller;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    }).finally(() => {
      controllers.delete(controller);
    });
  }

  test('multiple concurrent sleeps all resolve when aborted', async () => {
    const controllers = new Set<AbortController>();

    const p1 = interruptibleSleep(controllers, 60_000);
    const p2 = interruptibleSleep(controllers, 60_000);
    const p3 = interruptibleSleep(controllers, 60_000);

    // All three controllers should be registered
    expect(controllers.size).toBe(3);

    // Abort all (mimics wakeUp)
    for (const c of controllers) c.abort();

    // All promises should resolve quickly
    await Promise.all([p1, p2, p3]);

    // Controllers should be cleaned up
    expect(controllers.size).toBe(0);
  });

  test('controllers are cleaned up after natural resolve', async () => {
    const controllers = new Set<AbortController>();

    const p = interruptibleSleep(controllers, 10);
    expect(controllers.size).toBe(1);

    await p;
    expect(controllers.size).toBe(0);
  });

  test('aborting one sleep does not affect others', async () => {
    const controllers = new Set<AbortController>();

    let resolved1 = false;
    let resolved2 = false;

    const p1 = interruptibleSleep(controllers, 60_000).then(() => {
      resolved1 = true;
    });
    const p2 = interruptibleSleep(controllers, 60_000).then(() => {
      resolved2 = true;
    });

    expect(controllers.size).toBe(2);

    // Abort only the first controller
    const first = [...controllers][0];
    first.abort();

    // Wait a tick for the abort handler + .finally to run
    await new Promise((r) => setTimeout(r, 10));

    expect(resolved1).toBe(true);
    expect(resolved2).toBe(false);
    expect(controllers.size).toBe(1);

    // Abort the remaining one
    for (const c of controllers) c.abort();
    await p2;
    expect(resolved2).toBe(true);
    expect(controllers.size).toBe(0);
  });

  test('wakeUp pattern aborts all active sleepers', async () => {
    const controllers = new Set<AbortController>();

    const sleeps = Array.from({ length: 5 }, () => interruptibleSleep(controllers, 60_000));
    expect(controllers.size).toBe(5);

    // wakeUp: abort all
    for (const c of controllers) c.abort();

    await Promise.all(sleeps);
    expect(controllers.size).toBe(0);
  });

  test('sleeping state reflects active controllers', () => {
    const controllers = new Set<AbortController>();

    // No sleeps — not sleeping
    expect(controllers.size > 0).toBe(false);

    // Add a controller — sleeping
    const c = new AbortController();
    controllers.add(c);
    expect(controllers.size > 0).toBe(true);

    // Remove — not sleeping
    controllers.delete(c);
    expect(controllers.size > 0).toBe(false);
  });
});

describe('syncBotLoops — independent loop spawning', () => {
  test('new bots get independent loops spawned on sync', () => {
    const runningBots = new Set<string>();
    const botLoops = new Map<string, Promise<void>>();

    // Simulates syncBotLoops: spawn a loop for each running bot
    function syncBotLoops() {
      for (const botId of runningBots) {
        if (botLoops.has(botId)) continue;
        // In real code this would be runBotLoop(), here we just track the spawn
        botLoops.set(botId, Promise.resolve());
      }
      for (const botId of botLoops.keys()) {
        if (!runningBots.has(botId)) {
          botLoops.delete(botId);
        }
      }
    }

    // Initially only one bot
    runningBots.add('bot-a');
    syncBotLoops();
    expect(botLoops.size).toBe(1);
    expect(botLoops.has('bot-a')).toBe(true);

    // Add three more bots — each gets its own loop
    runningBots.add('bot-b');
    runningBots.add('bot-c');
    runningBots.add('bot-d');
    syncBotLoops();
    expect(botLoops.size).toBe(4);

    // Remove a bot — its loop is cleaned up
    runningBots.delete('bot-b');
    syncBotLoops();
    expect(botLoops.size).toBe(3);
    expect(botLoops.has('bot-b')).toBe(false);
  });

  test('existing loops are not re-spawned on sync', () => {
    const runningBots = new Set<string>();
    const botLoops = new Map<string, Promise<void>>();
    let spawnCount = 0;

    function syncBotLoops() {
      for (const botId of runningBots) {
        if (botLoops.has(botId)) continue;
        spawnCount++;
        botLoops.set(botId, Promise.resolve());
      }
    }

    runningBots.add('bot-a');
    syncBotLoops();
    expect(spawnCount).toBe(1);

    // Sync again — should not re-spawn
    syncBotLoops();
    expect(spawnCount).toBe(1);

    // New bot — only that one spawns
    runningBots.add('bot-b');
    syncBotLoops();
    expect(spawnCount).toBe(2);
  });
});

describe('computeBotSleepMs — simplified', () => {
  // Replicates the simplified computeBotSleepMs logic (config-only, no planner intervals)
  function computeSleep(
    botEvery: string | undefined,
    globalEvery: string,
    isError: boolean
  ): number {
    if (isError) {
      const normalMs = parseDurationMs(botEvery ?? globalEvery);
      return Math.max(normalMs, 5 * 60_000);
    }
    return parseDurationMs(botEvery ?? globalEvery);
  }

  test('uses botEvery when configured', () => {
    expect(computeSleep('1h', '30m', false)).toBe(parseDurationMs('1h'));
  });

  test('falls back to globalEvery when no botEvery', () => {
    expect(computeSleep(undefined, '30m', false)).toBe(parseDurationMs('30m'));
  });

  test('on error: uses 5-minute floor when interval is shorter', () => {
    expect(computeSleep('1m', '30m', true)).toBe(5 * 60_000);
  });

  test('on error: uses normal interval when longer than 5 minutes', () => {
    expect(computeSleep('6h', '30m', true)).toBe(parseDurationMs('6h'));
  });

  test('on error: falls back to globalEvery with floor', () => {
    expect(computeSleep(undefined, '2m', true)).toBe(5 * 60_000);
  });
});

describe('planner prompt — human questions injection', () => {
  const baseInput = {
    identity: 'test',
    soul: 'test',
    motivations: 'test',
    goals: '- [ ] Goal A',
    recentMemory: '',
    datetime: '2026-01-01',
    availableTools: ['ask_human', 'save_memory'],
    hasCreateTool: false,
  };

  test('includes answered questions when provided', () => {
    const { system } = buildPlannerPrompt({
      ...baseInput,
      answeredQuestions: [
        { question: 'What strategy should I pursue?', answer: 'Focus on DeFi partnerships' },
      ],
    });
    expect(system).toContain('## Human Responses');
    expect(system).toContain('What strategy should I pursue?');
    expect(system).toContain('Focus on DeFi partnerships');
    expect(system).toContain('top priority');
  });

  test('includes pending questions when provided', () => {
    const { system } = buildPlannerPrompt({
      ...baseInput,
      pendingQuestions: [{ question: 'Should I pivot to NFTs?' }],
    });
    expect(system).toContain('## Pending Questions');
    expect(system).toContain('Should I pivot to NFTs?');
    expect(system).toContain('Do NOT ask the same question again');
  });

  test('includes both answered and pending questions', () => {
    const { system } = buildPlannerPrompt({
      ...baseInput,
      answeredQuestions: [{ question: 'Q1?', answer: 'A1' }],
      pendingQuestions: [{ question: 'Q2?' }],
    });
    expect(system).toContain('## Human Responses');
    expect(system).toContain('## Pending Questions');
  });

  test('omits sections when no questions', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).not.toContain('## Human Responses');
    expect(system).not.toContain('## Pending Questions');
  });

  test('omits sections when arrays are empty', () => {
    const { system } = buildPlannerPrompt({
      ...baseInput,
      answeredQuestions: [],
      pendingQuestions: [],
    });
    expect(system).not.toContain('## Human Responses');
    expect(system).not.toContain('## Pending Questions');
  });
});

describe('continuous planner prompt — human questions injection', () => {
  const baseInput = {
    identity: 'test',
    soul: 'test',
    motivations: 'test',
    goals: '- [ ] Goal A',
    recentMemory: '',
    datetime: '2026-01-01',
    availableTools: ['ask_human'],
    hasCreateTool: false,
  };

  test('includes answered questions in continuous mode', () => {
    const { system } = buildContinuousPlannerPrompt({
      ...baseInput,
      answeredQuestions: [{ question: 'Budget?', answer: '$10k' }],
    });
    expect(system).toContain('## Human Responses');
    expect(system).toContain('Budget?');
    expect(system).toContain('$10k');
  });

  test('omits sections when no questions in continuous mode', () => {
    const { system } = buildContinuousPlannerPrompt(baseInput);
    expect(system).not.toContain('## Human Responses');
    expect(system).not.toContain('## Pending Questions');
  });
});

describe('per-bot running state logic', () => {
  test('per-bot set allows concurrent bots', () => {
    const runningBotIds = new Set<string>();
    runningBotIds.add('bot-a');
    runningBotIds.add('bot-b');

    // Both are running
    expect(runningBotIds.has('bot-a')).toBe(true);
    expect(runningBotIds.has('bot-b')).toBe(true);
    expect(runningBotIds.size).toBe(2);

    // Finishing one doesn't affect the other
    runningBotIds.delete('bot-a');
    expect(runningBotIds.has('bot-a')).toBe(false);
    expect(runningBotIds.has('bot-b')).toBe(true);
  });

  test('continuous bot does not block periodic bot', () => {
    const runningBotIds = new Set<string>();
    runningBotIds.add('continuous-bot');

    // Periodic bot can still start
    const canStart = !runningBotIds.has('periodic-bot');
    expect(canStart).toBe(true);

    // Global running is: size > 0
    expect(runningBotIds.size > 0).toBe(true);
  });

  test('same bot cannot run twice', () => {
    const runningBotIds = new Set<string>();
    runningBotIds.add('bot-a');

    // Try to start same bot
    const alreadyRunning = runningBotIds.has('bot-a');
    expect(alreadyRunning).toBe(true);
  });
});

describe('planner result parsing — empty plan + priority none', () => {
  // Replicates the parsePlannerResult logic from AgentLoop
  function parsePlannerResult(
    raw: string
  ): { reasoning: string; plan: string[]; priority: string } | null {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    if (!cleaned.startsWith('{')) {
      const match = cleaned.match(/\{[\s\S]*"plan"[\s\S]*\}/);
      if (match) cleaned = match[0];
    }
    try {
      const parsed = JSON.parse(cleaned);
      if (!parsed.reasoning || !Array.isArray(parsed.plan)) return null;
      const priority = ['high', 'medium', 'low', 'none'].includes(parsed.priority)
        ? parsed.priority
        : 'medium';
      if (parsed.plan.length === 0 && priority !== 'none') return null;
      return { reasoning: String(parsed.reasoning), plan: parsed.plan.map(String), priority };
    } catch {
      return null;
    }
  }

  test('accepts empty plan with priority "none"', () => {
    const raw = '{"reasoning":"Nothing novel to do","plan":[],"priority":"none"}';
    const result = parsePlannerResult(raw);
    expect(result).not.toBeNull();
    expect(result?.plan).toEqual([]);
    expect(result?.priority).toBe('none');
  });

  test('rejects empty plan without priority "none"', () => {
    const raw = '{"reasoning":"IDK","plan":[],"priority":"low"}';
    const result = parsePlannerResult(raw);
    expect(result).toBeNull();
  });

  test('accepts normal plan with priority "low"', () => {
    const raw = '{"reasoning":"Do stuff","plan":["Step 1"],"priority":"low"}';
    const result = parsePlannerResult(raw);
    expect(result).not.toBeNull();
    expect(result?.plan).toEqual(['Step 1']);
  });

  test('accepts priority "none" with plan', () => {
    // Technically valid but unusual — plan with "none" is allowed
    const raw = '{"reasoning":"Not sure","plan":["Maybe this"],"priority":"none"}';
    const result = parsePlannerResult(raw);
    expect(result).not.toBeNull();
  });

  test('defaults to "medium" for unknown priority', () => {
    const raw = '{"reasoning":"Do stuff","plan":["Step 1"],"priority":"urgent"}';
    const result = parsePlannerResult(raw);
    expect(result).not.toBeNull();
    expect(result?.priority).toBe('medium');
  });
});

describe('isSimilarSummary — memory dedup', () => {
  // Replicates the isSimilarSummary logic
  function isSimilarSummary(a: string, b: string): boolean {
    if (!a || !b) return false;
    const normalize = (s: string) =>
      s
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/gi, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    return normalize(a) === normalize(b);
  }

  test('detects identical summaries', () => {
    expect(
      isSimilarSummary('Reviewed goals and saved memory.', 'Reviewed goals and saved memory.')
    ).toBe(true);
  });

  test('ignores timestamp differences', () => {
    const a = 'Checked status at 2026-02-22T10:00:00Z and found nothing.';
    const b = 'Checked status at 2026-02-22T11:30:00Z and found nothing.';
    expect(isSimilarSummary(a, b)).toBe(true);
  });

  test('ignores whitespace differences', () => {
    expect(isSimilarSummary('Reviewed  goals  and  saved.', 'Reviewed goals and saved.')).toBe(
      true
    );
  });

  test('returns false for different summaries', () => {
    expect(isSimilarSummary('Reviewed goals.', 'Researched new opportunities.')).toBe(false);
  });

  test('returns false for empty strings', () => {
    expect(isSimilarSummary('', 'Something')).toBe(false);
    expect(isSimilarSummary('Something', '')).toBe(false);
  });
});

describe('repetition tracking', () => {
  // Replicates the buildRecentActionsDigest pattern
  function buildDigest(
    actions: Array<{ timestamp: number; planSummary: string; tools: string[] }>
  ): string {
    if (actions.length === 0) return '';
    const now = Date.now();
    const lines: string[] = ['## Recent Actions (last 24h)'];
    const summaryCount = new Map<string, number>();
    for (const action of actions) {
      const normalized = action.planSummary.toLowerCase().replace(/\s+/g, ' ').trim();
      summaryCount.set(normalized, (summaryCount.get(normalized) ?? 0) + 1);
    }
    for (const action of actions) {
      const hoursAgo = Math.round((now - action.timestamp) / 3_600_000);
      const normalized = action.planSummary.toLowerCase().replace(/\s+/g, ' ').trim();
      const count = summaryCount.get(normalized) ?? 0;
      const repeatTag = count >= 3 ? ` ← REPEATED x${count}` : count >= 2 ? ' ← REPEATED' : '';
      lines.push(`- ${hoursAgo}h ago: ${action.planSummary}${repeatTag}`);
    }
    const exhausted: string[] = [];
    for (const [summary, count] of summaryCount) {
      if (count >= 3) exhausted.push(summary.slice(0, 60));
    }
    if (exhausted.length > 0) {
      lines.push('');
      lines.push(`EXHAUSTED PATTERNS (done 3+ times): ${exhausted.join(', ')}`);
    }
    return lines.join('\n');
  }

  test('generates empty string for no actions', () => {
    expect(buildDigest([])).toBe('');
  });

  test('lists recent actions without repeat tags', () => {
    const now = Date.now();
    const digest = buildDigest([
      {
        timestamp: now - 2 * 3_600_000,
        planSummary: 'Research DeFi trends',
        tools: ['web_search'],
      },
      { timestamp: now - 1 * 3_600_000, planSummary: 'Update goals', tools: ['manage_goals'] },
    ]);
    expect(digest).toContain('Research DeFi trends');
    expect(digest).toContain('Update goals');
    expect(digest).not.toContain('REPEATED');
    expect(digest).not.toContain('EXHAUSTED');
  });

  test('marks repeated actions (2x)', () => {
    const now = Date.now();
    const digest = buildDigest([
      { timestamp: now - 3 * 3_600_000, planSummary: 'Review goals', tools: [] },
      { timestamp: now - 2 * 3_600_000, planSummary: 'Review goals', tools: [] },
    ]);
    expect(digest).toContain('← REPEATED');
    expect(digest).not.toContain('EXHAUSTED');
  });

  test('marks exhausted patterns (3+)', () => {
    const now = Date.now();
    const digest = buildDigest([
      { timestamp: now - 4 * 3_600_000, planSummary: 'Verify documents', tools: ['file_read'] },
      { timestamp: now - 3 * 3_600_000, planSummary: 'Verify documents', tools: ['file_read'] },
      { timestamp: now - 2 * 3_600_000, planSummary: 'Verify documents', tools: ['file_read'] },
      { timestamp: now - 1 * 3_600_000, planSummary: 'Research new idea', tools: ['web_search'] },
    ]);
    expect(digest).toContain('REPEATED x3');
    expect(digest).toContain('EXHAUSTED PATTERNS');
    expect(digest).toContain('verify documents');
  });
});

describe('idle cycle tracking', () => {
  test('consecutive idle cycles increment correctly', () => {
    let consecutiveIdle = 0;

    // First idle
    consecutiveIdle++;
    expect(consecutiveIdle).toBe(1);

    // Second idle
    consecutiveIdle++;
    expect(consecutiveIdle).toBe(2);

    // Active cycle resets
    consecutiveIdle = 0;
    expect(consecutiveIdle).toBe(0);
  });

  test('first idle cycle should log, subsequent should not', () => {
    let consecutiveIdle = 0;
    const logged: string[] = [];

    // Simulate 3 idle cycles
    for (let i = 0; i < 3; i++) {
      consecutiveIdle++;
      if (consecutiveIdle === 1) {
        logged.push('Idle — no novel action found.');
      }
    }

    expect(logged.length).toBe(1);
    expect(consecutiveIdle).toBe(3);
  });

  test('active after idle should log resume message', () => {
    let consecutiveIdle = 3;
    const logged: string[] = [];

    // Active cycle after idle
    if (consecutiveIdle > 0) {
      logged.push(`Resuming after ${consecutiveIdle} idle cycles.`);
    }
    consecutiveIdle = 0;

    expect(logged.length).toBe(1);
    expect(logged[0]).toContain('3 idle cycles');
  });
});

describe('cyclesSinceAskHuman tracking', () => {
  // Mirrors the logic in agent-loop.ts executeSingleBot
  function trackCycle(
    cyclesSinceAskHuman: number,
    toolCalls: { name: string }[],
    isIdle: boolean
  ): number {
    const usedAskHuman = toolCalls.some((t) => t.name === 'ask_human');
    if (usedAskHuman) {
      return 0;
    }
    if (!isIdle) {
      return cyclesSinceAskHuman + 1;
    }
    return cyclesSinceAskHuman;
  }

  test('increments on non-idle cycle without ask_human', () => {
    expect(trackCycle(0, [{ name: 'save_memory' }], false)).toBe(1);
    expect(trackCycle(3, [{ name: 'web_search' }], false)).toBe(4);
  });

  test('resets to 0 when ask_human is used', () => {
    expect(trackCycle(5, [{ name: 'ask_human' }], false)).toBe(0);
    expect(trackCycle(10, [{ name: 'save_memory' }, { name: 'ask_human' }], false)).toBe(0);
  });

  test('does not increment on idle cycles', () => {
    expect(trackCycle(3, [], true)).toBe(3);
  });

  test('resets even on idle cycle if ask_human was used', () => {
    // Edge case: ask_human in tool calls but idle result
    expect(trackCycle(5, [{ name: 'ask_human' }], true)).toBe(0);
  });

  test('autonomousCyclesNote generated at threshold', () => {
    const threshold = 5;
    const buildNote = (cycles: number) =>
      cycles >= threshold
        ? `## Autonomous Run Notice\n\nYou have been running autonomously for ${cycles} cycles without checking in with your human operator.`
        : undefined;

    expect(buildNote(4)).toBeUndefined();
    expect(buildNote(5)).toContain('5 cycles');
    expect(buildNote(10)).toContain('10 cycles');
    expect(buildNote(0)).toBeUndefined();
  });
});

describe('config schema — karma and idleSuppression', () => {
  test('karma config has sensible defaults', () => {
    const { z } = require('zod');
    const KarmaConfigSchema = z
      .object({
        enabled: z.boolean().default(true),
        baseDir: z.string().default('./data/karma'),
        initialScore: z.number().default(50),
        decayDays: z.number().default(30),
      })
      .default({});
    const result = KarmaConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.baseDir).toBe('./data/karma');
    expect(result.initialScore).toBe(50);
    expect(result.decayDays).toBe(30);
  });

  test('idleSuppression defaults to true', () => {
    const { GlobalAgentLoopConfigSchema } = require('../src/config');
    const result = GlobalAgentLoopConfigSchema.parse({});
    expect(result.idleSuppression).toBe(true);
  });

  test('idleSuppression can be disabled', () => {
    const { GlobalAgentLoopConfigSchema } = require('../src/config');
    const result = GlobalAgentLoopConfigSchema.parse({ idleSuppression: false });
    expect(result.idleSuppression).toBe(false);
  });

  test('askHumanCheckInCycles defaults to 5', () => {
    const { GlobalAgentLoopConfigSchema } = require('../src/config');
    const result = GlobalAgentLoopConfigSchema.parse({});
    expect(result.askHumanCheckInCycles).toBe(5);
  });

  test('askHumanCheckInCycles can be customized', () => {
    const { GlobalAgentLoopConfigSchema } = require('../src/config');
    const result = GlobalAgentLoopConfigSchema.parse({ askHumanCheckInCycles: 10 });
    expect(result.askHumanCheckInCycles).toBe(10);
  });

  test('askHumanCheckInCycles rejects values below 1', () => {
    const { GlobalAgentLoopConfigSchema } = require('../src/config');
    expect(() => GlobalAgentLoopConfigSchema.parse({ askHumanCheckInCycles: 0 })).toThrow();
  });

  test('askHumanCheckInCycles rejects values above 50', () => {
    const { GlobalAgentLoopConfigSchema } = require('../src/config');
    expect(() => GlobalAgentLoopConfigSchema.parse({ askHumanCheckInCycles: 51 })).toThrow();
  });
});

// Tool error karma deduplication tests removed — karma -1 per tool error is now
// handled directly in ToolExecutor.buildFailResult(). See tool-executor-hooks.test.ts.

describe('buildExecutorPrompt — file tree context', () => {
  const baseInput = {
    plan: ['Write a config file'],
    identity: 'test bot',
    soul: 'helpful',
    motivations: 'produce output',
    goals: '- [ ] Create config',
    datetime: '2026-02-22T10:00:00Z',
    hasCreateTool: false,
    workDir: './productions/test-bot',
  };

  test('includes file tree when provided', () => {
    const result = buildExecutorPrompt({
      ...baseInput,
      fileTree: 'config/\n  settings.json\nREADME.md',
    });
    expect(result).toContain('config/');
    expect(result).toContain('settings.json');
    expect(result).toContain('README.md');
    expect(result).not.toContain('EMPTY');
    expect(result).not.toContain('Do NOT attempt file_read or file_edit on non-existent files');
  });

  test('shows EMPTY notice when fileTree is null', () => {
    const result = buildExecutorPrompt({
      ...baseInput,
      fileTree: null,
    });
    expect(result).toContain('EMPTY');
    expect(result).toContain('Use file_write to create new files');
    expect(result).toContain('Do NOT attempt file_read or file_edit on non-existent files');
    expect(result).not.toContain('You already know the project structure');
  });

  test('shows EMPTY notice when fileTree is undefined', () => {
    const result = buildExecutorPrompt(baseInput);
    expect(result).toContain('EMPTY');
    expect(result).toContain('Do NOT attempt file_read or file_edit on non-existent files');
  });

  test('does not contain old "You already know the project structure" claim', () => {
    const result = buildExecutorPrompt({
      ...baseInput,
      fileTree: 'somefile.txt',
    });
    expect(result).not.toContain('You already know the project structure');
  });

  test('does not contain old "Do NOT use exec with find/ls/tree" rule', () => {
    const result = buildExecutorPrompt({
      ...baseInput,
      fileTree: 'somefile.txt',
    });
    expect(result).not.toContain('Do NOT use exec with find/ls/tree');
  });
});

// Proportional karma penalty tests removed — tool error karma is now -1 per error
// in ToolExecutor.buildFailResult() instead of post-hoc batch analysis.
// See tool-executor-hooks.test.ts for the new karma tests.

describe('isRetryableError', () => {
  test('classifies timeout errors as retryable', () => {
    expect(
      isRetryableError(new Error('Executor phase timed out after 193660ms (session timeout guard)'))
    ).toBe(true);
    expect(isRetryableError(new Error('Agent loop timed out after 300000ms'))).toBe(true);
    expect(isRetryableError('Request timeout')).toBe(true);
  });

  test('classifies network errors as retryable', () => {
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryableError(new Error('ENOTFOUND'))).toBe(true);
    expect(isRetryableError(new Error('EAI_AGAIN'))).toBe(true);
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableError(new Error('network error'))).toBe(true);
  });

  test('classifies rate limit errors as retryable', () => {
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
  });

  test('classifies server errors as retryable', () => {
    expect(isRetryableError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isRetryableError(new Error('504 Gateway Timeout'))).toBe(true);
  });

  test('classifies auth errors as non-retryable', () => {
    expect(isRetryableError(new Error('Authentication failed'))).toBe(false);
    expect(isRetryableError(new Error('401 Unauthorized'))).toBe(false);
    expect(isRetryableError(new Error('403 Forbidden'))).toBe(false);
    expect(isRetryableError(new Error('Permission denied'))).toBe(false);
    expect(isRetryableError(new Error('invalid_api_key'))).toBe(false);
    expect(isRetryableError(new Error('Invalid API Key provided'))).toBe(false);
  });

  test('classifies unknown errors as retryable (conservative retry)', () => {
    expect(isRetryableError(new Error('Something unexpected happened'))).toBe(true);
    expect(isRetryableError(new Error('Cannot read property of undefined'))).toBe(true);
    expect(isRetryableError('random string error')).toBe(true);
  });

  test('handles non-Error objects', () => {
    expect(isRetryableError('timed out')).toBe(true);
    expect(isRetryableError(42)).toBe(true);
    expect(isRetryableError(null)).toBe(true);
    expect(isRetryableError(undefined)).toBe(true);
  });

  test('non-retryable patterns take precedence over retryable when both match', () => {
    // "auth" + "timeout" → auth takes priority (non-retryable checked first)
    expect(isRetryableError(new Error('auth request timed out'))).toBe(false);
  });
});

describe('computeRetryDelay', () => {
  test('first attempt uses initialDelayMs as base', () => {
    const delays: number[] = [];
    for (let i = 0; i < 100; i++) {
      delays.push(computeRetryDelay(0, 10_000, 60_000, 2));
    }
    // Base = 10000, jitter = ±2000, range = [8000, 12000]
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(8000);
      expect(d).toBeLessThanOrEqual(12000);
    }
  });

  test('exponential growth: attempt 1 doubles', () => {
    const delays: number[] = [];
    for (let i = 0; i < 100; i++) {
      delays.push(computeRetryDelay(1, 10_000, 60_000, 2));
    }
    // Base = 20000, jitter = ±4000, range = [16000, 24000]
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(16000);
      expect(d).toBeLessThanOrEqual(24000);
    }
  });

  test('caps at maxDelayMs', () => {
    const delays: number[] = [];
    for (let i = 0; i < 100; i++) {
      delays.push(computeRetryDelay(10, 10_000, 60_000, 2));
    }
    // Base would be 10000 * 2^10 = 10_240_000, capped at 60_000
    // Jitter ±12_000 → [48000, 72000]
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(48000);
      expect(d).toBeLessThanOrEqual(72000);
    }
  });

  test('respects custom multiplier', () => {
    const delays: number[] = [];
    for (let i = 0; i < 100; i++) {
      delays.push(computeRetryDelay(1, 5_000, 60_000, 3));
    }
    // Base = 5000 * 3^1 = 15000, jitter = ±3000, range = [12000, 18000]
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(12000);
      expect(d).toBeLessThanOrEqual(18000);
    }
  });

  test('never returns negative', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      for (let i = 0; i < 50; i++) {
        const d = computeRetryDelay(attempt, 1000, 60_000, 2);
        expect(d).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('staggered bot startup', () => {
  test('first bot gets nextRunAt = now, second += 30s, third += 60s', () => {
    const botSchedules = new Map<string, { nextRunAt: number }>();
    const now = Date.now();

    // Simulates syncSchedules stagger logic
    function registerBot(botId: string) {
      if (botSchedules.has(botId)) return;
      const staggerOffset = botSchedules.size * 30_000;
      botSchedules.set(botId, { nextRunAt: now + staggerOffset });
    }

    registerBot('bot-a');
    registerBot('bot-b');
    registerBot('bot-c');

    expect(botSchedules.get('bot-a')?.nextRunAt).toBe(now);
    expect(botSchedules.get('bot-b')?.nextRunAt).toBe(now + 30_000);
    expect(botSchedules.get('bot-c')?.nextRunAt).toBe(now + 60_000);
  });

  test('re-registering existing bot does not change stagger', () => {
    const botSchedules = new Map<string, { nextRunAt: number }>();
    const now = Date.now();

    function registerBot(botId: string) {
      if (botSchedules.has(botId)) return;
      const staggerOffset = botSchedules.size * 30_000;
      botSchedules.set(botId, { nextRunAt: now + staggerOffset });
    }

    registerBot('bot-a');
    registerBot('bot-b');
    const originalB = botSchedules.get('bot-b')?.nextRunAt;

    // Re-register should be no-op
    registerBot('bot-b');
    expect(botSchedules.get('bot-b')?.nextRunAt).toBe(originalB);
  });

  test('stagger accounts for already-registered bots when adding later', () => {
    const botSchedules = new Map<string, { nextRunAt: number }>();
    const now = Date.now();

    function registerBot(botId: string) {
      if (botSchedules.has(botId)) return;
      const staggerOffset = botSchedules.size * 30_000;
      botSchedules.set(botId, { nextRunAt: now + staggerOffset });
    }

    registerBot('bot-a');
    registerBot('bot-b');
    // Later, a third bot joins — it should get offset based on current size (2)
    registerBot('bot-c');
    expect(botSchedules.get('bot-c')?.nextRunAt).toBe(now + 60_000);
  });
});

describe('concurrency semaphore', () => {
  function createSemaphore(limit: number) {
    let running = 0;
    const queue: Array<() => void> = [];

    function acquire(): Promise<void> {
      if (running < limit) {
        running++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        queue.push(() => {
          running++;
          resolve();
        });
      });
    }

    function release(): void {
      running--;
      const next = queue.shift();
      if (next) next();
    }

    return { acquire, release, getRunning: () => running, getQueueLength: () => queue.length };
  }

  test('allows up to limit concurrent acquisitions', async () => {
    const sem = createSemaphore(2);

    await sem.acquire();
    await sem.acquire();
    expect(sem.getRunning()).toBe(2);

    // Third acquire should queue
    let thirdResolved = false;
    const p3 = sem.acquire().then(() => {
      thirdResolved = true;
    });
    // Give microtask a chance
    await new Promise((r) => setTimeout(r, 10));
    expect(thirdResolved).toBe(false);
    expect(sem.getQueueLength()).toBe(1);

    // Release one — third should now resolve
    sem.release();
    await p3;
    expect(thirdResolved).toBe(true);
    expect(sem.getRunning()).toBe(2);
  });

  test('FIFO ordering: first queued gets released first', async () => {
    const sem = createSemaphore(1);
    const order: string[] = [];

    await sem.acquire();

    const p1 = sem.acquire().then(() => {
      order.push('first');
    });
    const p2 = sem.acquire().then(() => {
      order.push('second');
    });

    sem.release();
    await p1;
    sem.release();
    await p2;

    expect(order).toEqual(['first', 'second']);
  });

  test('release without pending queue decrements running', () => {
    const sem = createSemaphore(3);

    // Acquire and release all
    const acquired: Promise<void>[] = [];
    for (let i = 0; i < 3; i++) acquired.push(sem.acquire());

    expect(sem.getRunning()).toBe(3);

    sem.release();
    expect(sem.getRunning()).toBe(2);
    sem.release();
    expect(sem.getRunning()).toBe(1);
    sem.release();
    expect(sem.getRunning()).toBe(0);
  });

  test('concurrent execution respects limit under load', async () => {
    const sem = createSemaphore(2);
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    async function simulateBot(id: string, durationMs: number) {
      await sem.acquire();
      try {
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
        await new Promise((r) => setTimeout(r, durationMs));
      } finally {
        currentConcurrent--;
        sem.release();
      }
    }

    // Launch 5 bots that each take 50ms
    await Promise.all([
      simulateBot('a', 50),
      simulateBot('b', 50),
      simulateBot('c', 50),
      simulateBot('d', 50),
      simulateBot('e', 50),
    ]);

    expect(maxConcurrent).toBe(2);
    expect(currentConcurrent).toBe(0);
    expect(sem.getRunning()).toBe(0);
    expect(sem.getQueueLength()).toBe(0);
  });
});

describe('maxConcurrent config schema', () => {
  test('defaults to 2', () => {
    const result = GlobalAgentLoopConfigSchema.parse({});
    expect(result.maxConcurrent).toBe(2);
  });

  test('accepts valid values', () => {
    expect(GlobalAgentLoopConfigSchema.parse({ maxConcurrent: 1 }).maxConcurrent).toBe(1);
    expect(GlobalAgentLoopConfigSchema.parse({ maxConcurrent: 5 }).maxConcurrent).toBe(5);
    expect(GlobalAgentLoopConfigSchema.parse({ maxConcurrent: 10 }).maxConcurrent).toBe(10);
  });

  test('rejects values below 1', () => {
    expect(() => GlobalAgentLoopConfigSchema.parse({ maxConcurrent: 0 })).toThrow();
    expect(() => GlobalAgentLoopConfigSchema.parse({ maxConcurrent: -1 })).toThrow();
  });

  test('rejects values above 10', () => {
    expect(() => GlobalAgentLoopConfigSchema.parse({ maxConcurrent: 11 })).toThrow();
  });

  test('rejects non-integer values', () => {
    expect(() => GlobalAgentLoopConfigSchema.parse({ maxConcurrent: 2.5 })).toThrow();
  });
});

describe('retry config schema', () => {
  test('AgentLoopRetryConfigSchema has sensible defaults', () => {
    const result = AgentLoopRetryConfigSchema.parse({});
    expect(result.maxRetries).toBe(2);
    expect(result.initialDelayMs).toBe(10_000);
    expect(result.maxDelayMs).toBe(60_000);
    expect(result.backoffMultiplier).toBe(2);
  });

  test('GlobalAgentLoopConfigSchema includes retry with defaults', () => {
    const result = GlobalAgentLoopConfigSchema.parse({});
    expect(result.retry).toBeDefined();
    expect(result.retry.maxRetries).toBe(2);
    expect(result.retry.initialDelayMs).toBe(10_000);
    expect(result.retry.maxDelayMs).toBe(60_000);
    expect(result.retry.backoffMultiplier).toBe(2);
  });

  test('retry config can be overridden at global level', () => {
    const result = GlobalAgentLoopConfigSchema.parse({
      retry: { maxRetries: 5, initialDelayMs: 5000 },
    });
    expect(result.retry.maxRetries).toBe(5);
    expect(result.retry.initialDelayMs).toBe(5000);
    expect(result.retry.maxDelayMs).toBe(60_000); // still default
  });

  test('per-bot retry override schema accepts partial config', () => {
    const result = BotAgentLoopOverrideSchema.parse({
      retry: { maxRetries: 0 },
    });
    expect(result?.retry?.maxRetries).toBe(0);
    expect(result?.retry?.initialDelayMs).toBeUndefined();
  });

  test('per-bot retry override with all fields', () => {
    const result = BotAgentLoopOverrideSchema.parse({
      retry: {
        maxRetries: 3,
        initialDelayMs: 5000,
        maxDelayMs: 120_000,
        backoffMultiplier: 3,
      },
    });
    expect(result?.retry?.maxRetries).toBe(3);
    expect(result?.retry?.initialDelayMs).toBe(5000);
    expect(result?.retry?.maxDelayMs).toBe(120_000);
    expect(result?.retry?.backoffMultiplier).toBe(3);
  });

  test('rejects maxRetries > 10', () => {
    expect(() => AgentLoopRetryConfigSchema.parse({ maxRetries: 11 })).toThrow();
  });

  test('rejects negative maxRetries', () => {
    expect(() => AgentLoopRetryConfigSchema.parse({ maxRetries: -1 })).toThrow();
  });

  test('rejects initialDelayMs below 1000', () => {
    expect(() => AgentLoopRetryConfigSchema.parse({ initialDelayMs: 500 })).toThrow();
  });

  test('rejects backoffMultiplier below 1', () => {
    expect(() => AgentLoopRetryConfigSchema.parse({ backoffMultiplier: 0.5 })).toThrow();
  });

  test('rejects backoffMultiplier above 10', () => {
    expect(() => AgentLoopRetryConfigSchema.parse({ backoffMultiplier: 11 })).toThrow();
  });

  test('maxRetries 0 disables retries', () => {
    const result = AgentLoopRetryConfigSchema.parse({ maxRetries: 0 });
    expect(result.maxRetries).toBe(0);
  });
});
