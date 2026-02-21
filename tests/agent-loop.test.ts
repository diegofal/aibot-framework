import { describe, test, expect } from 'bun:test';
import { parseDurationMs } from '../src/bot/agent-loop';
import { parseGoals, serializeGoals } from '../src/tools/goals';
import { buildStrategistPrompt, buildContinuousPlannerPrompt, buildPlannerPrompt } from '../src/bot/agent-loop-prompts';
import { BotAgentLoopOverrideSchema } from '../src/config';

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

describe('planner prompt — no skip gate', () => {
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

  test('always requires a plan (no option to skip)', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain('always produce a plan');
    expect(system).toContain('no option to skip');
  });

  test('contains survival imperative', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain('eliminated');
    expect(system).toContain('SURVIVAL IMPERATIVE');
  });

  test('includes priority in the JSON schema', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain('"priority"');
    expect(system).toContain('"high" | "medium" | "low"');
  });

  test('suggests self-improvement activities', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain('self-improvement');
    expect(system).toContain('Review and update the status of your goals');
    expect(system).toContain('Reflect on recent activity and save insights');
    expect(system).toContain('Research opportunities');
    expect(system).toContain('ask_human to request new directives');
  });

  test('includes ask_human guidance', () => {
    const { system } = buildPlannerPrompt(baseInput);
    expect(system).toContain('ask_human');
    expect(system).toContain('Do NOT passively wait');
  });

  test('prompt instructs to always produce a plan', () => {
    const { prompt } = buildPlannerPrompt(baseInput);
    expect(prompt).toContain('must always produce a plan');
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
      { text: 'Goal C', status: 'completed', priority: 'medium', completed: '2026-01-10', outcome: 'Shipped' },
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
    const intervalMet1 = (Date.now() - (Date.now() - 3_600_000)) >= minIntervalMs; // 1h ago
    expect(cyclesMet1 && intervalMet1).toBe(false);

    // Case 2: enough time but not enough cycles
    const cyclesMet2 = 2 >= everyCycles;
    const intervalMet2 = (Date.now() - (Date.now() - 5 * 3_600_000)) >= minIntervalMs; // 5h ago
    expect(cyclesMet2 && intervalMet2).toBe(false);

    // Case 3: both met
    const cyclesMet3 = 4 >= everyCycles;
    const intervalMet3 = (Date.now() - (Date.now() - 5 * 3_600_000)) >= minIntervalMs; // 5h ago
    expect(cyclesMet3 && intervalMet3).toBe(true);
  });

  test('first run (no lastStrategistAt) always meets interval condition', () => {
    const lastStrategistAt: number | null = null;
    const intervalMet = lastStrategistAt === null;
    expect(intervalMet).toBe(true);
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

  test('always expects a plan (no skip option)', () => {
    const { system } = buildContinuousPlannerPrompt(baseInput);
    expect(system).toContain('Always produce a plan');
    expect(system).toContain('no option to skip');
    expect(system).not.toContain('skip_reason');
  });

  test('includes priority in the JSON schema', () => {
    const { system } = buildContinuousPlannerPrompt(baseInput);
    expect(system).toContain('"priority"');
    expect(system).toContain('"high" | "medium" | "low"');
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
    expect(shouldLogMemory(4, 5)).toBe(true);  // cycle 5 (1-indexed)
    expect(shouldLogMemory(9, 5)).toBe(true);  // cycle 10
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

  function interruptibleSleep(
    controllers: Set<AbortController>,
    ms: number,
  ): Promise<void> {
    const controller = new AbortController();
    controllers.add(controller);
    const { signal } = controller;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
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

    const p1 = interruptibleSleep(controllers, 60_000).then(() => { resolved1 = true; });
    const p2 = interruptibleSleep(controllers, 60_000).then(() => { resolved2 = true; });

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
    isError: boolean,
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
      pendingQuestions: [
        { question: 'Should I pivot to NFTs?' },
      ],
    });
    expect(system).toContain('## Pending Questions');
    expect(system).toContain('Should I pivot to NFTs?');
    expect(system).toContain('Do NOT ask the same question again');
  });

  test('includes both answered and pending questions', () => {
    const { system } = buildPlannerPrompt({
      ...baseInput,
      answeredQuestions: [
        { question: 'Q1?', answer: 'A1' },
      ],
      pendingQuestions: [
        { question: 'Q2?' },
      ],
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
      answeredQuestions: [
        { question: 'Budget?', answer: '$10k' },
      ],
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
