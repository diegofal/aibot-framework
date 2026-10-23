import { describe, expect, test } from 'bun:test';
import {
  AVAILABLE_PRESETS,
  PRESET_DIRECTIVE_DEFINITIONS,
  buildContinuousPlannerPrompt,
  buildConversationSection,
  buildDirectivesSection,
  buildExecutorPrompt,
  buildFeedbackProcessorPrompt,
  buildFleetBroadcastSection,
  buildOperatorGoalsSection,
  buildPlannerPrompt,
  buildSelfStateSection,
  buildStrategistPrompt,
} from '../../src/bot/agent-loop-prompts';
import type { StoredTask } from '../../src/goals/task-store';

describe('buildFeedbackProcessorPrompt', () => {
  const baseInput = {
    identity: 'I am TestBot',
    soul: 'A helpful assistant',
    motivations: 'Be useful and learn',
    goals: '## Active Goals\n- Help users',
    datetime: '2026-02-21T12:00:00Z',
    feedbackContent: 'Focus more on creative tasks',
    availableTools: ['manage_goals', 'update_soul', 'save_memory'],
  };

  test('returns system and userPrompt strings', () => {
    const result = buildFeedbackProcessorPrompt(baseInput);

    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('userPrompt');
    expect(typeof result.system).toBe('string');
    expect(typeof result.userPrompt).toBe('string');
  });

  test('system prompt includes identity', () => {
    const result = buildFeedbackProcessorPrompt(baseInput);
    expect(result.system).toContain('I am TestBot');
  });

  test('system prompt includes soul', () => {
    const result = buildFeedbackProcessorPrompt(baseInput);
    expect(result.system).toContain('A helpful assistant');
  });

  test('system prompt includes motivations', () => {
    const result = buildFeedbackProcessorPrompt(baseInput);
    expect(result.system).toContain('Be useful and learn');
  });

  test('system prompt includes goals', () => {
    const result = buildFeedbackProcessorPrompt(baseInput);
    expect(result.system).toContain('Help users');
  });

  test('system prompt includes available tools', () => {
    const result = buildFeedbackProcessorPrompt(baseInput);
    expect(result.system).toContain('manage_goals');
    expect(result.system).toContain('update_soul');
    expect(result.system).toContain('save_memory');
  });

  test('system prompt includes datetime', () => {
    const result = buildFeedbackProcessorPrompt(baseInput);
    expect(result.system).toContain('2026-02-21T12:00:00Z');
  });

  test('user prompt includes feedback content', () => {
    const result = buildFeedbackProcessorPrompt(baseInput);
    expect(result.userPrompt).toContain('Focus more on creative tasks');
  });

  test('handles empty goals', () => {
    const result = buildFeedbackProcessorPrompt({ ...baseInput, goals: '' });
    expect(result.system).toContain('No goals set yet');
  });

  test('user prompt references operator feedback', () => {
    const result = buildFeedbackProcessorPrompt(baseInput);
    expect(result.userPrompt).toContain('operator');
    expect(result.userPrompt).toContain('feedback');
  });
});

describe('buildDirectivesSection', () => {
  test('returns empty string when no directives', () => {
    expect(buildDirectivesSection(undefined)).toBe('');
    expect(buildDirectivesSection([])).toBe('');
  });

  test('returns formatted section with directives', () => {
    const result = buildDirectivesSection(['Check inbox', 'Review logs']);
    expect(result).toContain('## Operator Directives');
    expect(result).toContain('- Check inbox');
    expect(result).toContain('- Review logs');
    expect(result).toContain('standing directives');
  });

  test('includes single directive', () => {
    const result = buildDirectivesSection(['Only one directive']);
    expect(result).toContain('- Only one directive');
  });
});

describe('PRESET_DIRECTIVE_DEFINITIONS', () => {
  test('conversation-review preset exists', () => {
    expect(PRESET_DIRECTIVE_DEFINITIONS['conversation-review']).toBeDefined();
    expect(PRESET_DIRECTIVE_DEFINITIONS['conversation-review'].length).toBeGreaterThan(0);
  });

  test('conversation-review preset mentions session logs', () => {
    const text = PRESET_DIRECTIVE_DEFINITIONS['conversation-review'][0];
    expect(text).toContain('session logs');
  });
});

describe('AVAILABLE_PRESETS', () => {
  test('includes conversation-review', () => {
    const preset = AVAILABLE_PRESETS.find((p) => p.id === 'conversation-review');
    expect(preset).toBeDefined();
    expect(preset?.description).toBeTruthy();
  });
});

describe('directives in prompt builders', () => {
  const basePlannerInput = {
    identity: 'TestBot',
    soul: 'A bot',
    motivations: 'Be helpful',
    goals: '## Goals\n- Goal 1',
    recentMemory: 'Did stuff',
    datetime: '2026-03-08T12:00:00Z',
    availableTools: ['web_search'],
    hasCreateTool: false,
  };

  test('planner prompt includes directives when provided', () => {
    const result = buildPlannerPrompt({
      ...basePlannerInput,
      directives: ['Monitor RSS feeds daily'],
    });
    expect(result.system).toContain('## Operator Directives');
    expect(result.system).toContain('Monitor RSS feeds daily');
  });

  test('planner prompt omits directives section when empty', () => {
    const result = buildPlannerPrompt(basePlannerInput);
    expect(result.system).not.toContain('## Operator Directives');
  });

  test('continuous planner prompt includes directives', () => {
    const result = buildContinuousPlannerPrompt({
      ...basePlannerInput,
      directives: ['Check weather'],
    });
    expect(result.system).toContain('## Operator Directives');
    expect(result.system).toContain('Check weather');
  });

  test('executor prompt includes directives', () => {
    const result = buildExecutorPrompt({
      plan: ['Step 1'],
      identity: 'TestBot',
      soul: 'A bot',
      motivations: 'Be helpful',
      goals: '## Goals\n- Goal 1',
      datetime: '2026-03-08T12:00:00Z',
      hasCreateTool: false,
      workDir: '/tmp/test',
      directives: ['Always verify sources'],
    });
    expect(result).toContain('## Operator Directives');
    expect(result).toContain('Always verify sources');
  });

  test('strategist prompt includes directives', () => {
    const result = buildStrategistPrompt({
      identity: 'TestBot',
      soul: 'A bot',
      motivations: 'Be helpful',
      goals: '## Goals\n- Goal 1',
      recentMemory: 'Did stuff',
      datetime: '2026-03-08T12:00:00Z',
      directives: ['Prioritize user engagement'],
    });
    expect(result.system).toContain('## Operator Directives');
    expect(result.system).toContain('Prioritize user engagement');
  });
});

describe('buildExecutorPrompt productionsEnabled', () => {
  const baseExecutorInput = {
    plan: ['Step 1', 'Step 2'],
    identity: 'TestBot',
    soul: 'A bot',
    motivations: 'Be helpful',
    goals: '## Goals\n- Goal 1',
    datetime: '2026-03-08T12:00:00Z',
    hasCreateTool: false,
    workDir: '/tmp/test',
    fileTree: 'file1.md\nfile2.md',
  };

  test('includes production sections by default', () => {
    const result = buildExecutorPrompt(baseExecutorInput);
    expect(result).toContain('## Working Directory Contents');
    expect(result).toContain('## Production Directory Rules');
    expect(result).toContain('LIVING DOCUMENTS');
    expect(result).toContain('file_read/file_write/file_edit');
  });

  // Deliberately changed: "create a new version, archive the old one" made
  // v1/v2 files; a goal now keeps one document, edited in place and short.
  test('the executor is told the cap and the size of each document', () => {
    const result = buildExecutorPrompt({
      ...baseExecutorInput,
      documents: {
        maxChars: 12_000,
        docs: [{ path: '06_rules.md', chars: 11_500, goalId: 'g-1' }],
      },
    });
    expect(result).toContain('12,000 characters');
    expect(result).toContain('06_rules.md (goal g-1): 11,500 / 12,000');
  });

  test('one living document per goal, edited in place and kept short; research step by step', () => {
    const result = buildExecutorPrompt(baseExecutorInput);
    expect(result).toContain('ONE document per goal');
    expect(result).toContain('Edit it in place');
    expect(result).toContain('about two pages');
    expect(result).toContain('exploration cycle');
    expect(result).not.toContain('create the replacement');
    expect(result).not.toContain('When you create a new version of a file');
  });

  test('includes production sections when productionsEnabled is true', () => {
    const result = buildExecutorPrompt({ ...baseExecutorInput, productionsEnabled: true });
    expect(result).toContain('## Working Directory Contents');
    expect(result).toContain('## Production Directory Rules');
    expect(result).toContain('LIVING DOCUMENTS');
  });

  test('tells the executor supporting code is a scratch file and only the write-up is reviewed', () => {
    const result = buildExecutorPrompt(baseExecutorInput);
    expect(result).toContain('SUPPORTING WORK');
    expect(result).toContain('_kappa_power_sim.ts');
    const off = buildExecutorPrompt({ ...baseExecutorInput, productionsEnabled: false });
    expect(off).not.toContain('SUPPORTING WORK');
  });

  test('skips production sections when productionsEnabled is false', () => {
    const result = buildExecutorPrompt({ ...baseExecutorInput, productionsEnabled: false });
    expect(result).not.toContain('## Working Directory Contents');
    expect(result).not.toContain('## Production Directory Rules');
    expect(result).not.toContain('LIVING DOCUMENTS');
    expect(result).not.toContain('file_read/file_write/file_edit');
    expect(result).not.toContain('Use RELATIVE paths');
  });

  test('skips Working Directory when productionsEnabled is false', () => {
    const result = buildExecutorPrompt({ ...baseExecutorInput, productionsEnabled: false });
    expect(result).not.toContain('/tmp/test');
    expect(result).not.toContain('file1.md');
  });

  test('still includes memory/goals instructions when productions disabled', () => {
    const result = buildExecutorPrompt({ ...baseExecutorInput, productionsEnabled: false });
    expect(result).toContain('save findings to memory, update goals');
    expect(result).toContain('manage_goals');
    expect(result).toContain('save_memory');
    expect(result).toContain('## Tool Usage Rules');
    // Should NOT include "write/edit files" in the output line
    expect(result).not.toContain('save findings to memory, update goals, write/edit files');
  });
});

describe('buildOperatorGoalsSection', () => {
  const goals = `## Active Goals
- [ ] Find three remote FDE roles
  - status: pending
  - priority: high
  - source: operator
- [ ] Self-set research thread
  - status: in_progress
  - priority: medium
  - source: agent
- [ ] Done operator goal is not active
  - status: blocked
  - priority: low
  - source: operator:2026-10-06

## Completed
- [x] Old operator goal
  - completed: 2026-10-01
`;

  test('returns empty string when there are no operator goals', () => {
    expect(buildOperatorGoalsSection(undefined)).toBe('');
    expect(buildOperatorGoalsSection({ goalsMd: '', tasks: [] })).toBe('');
    expect(
      buildOperatorGoalsSection({
        goalsMd: '## Active Goals\n- [ ] Mine\n  - status: pending\n  - source: agent\n',
        tasks: [],
      })
    ).toBe('');
  });

  test('lists only active operator goals with the priority instruction', () => {
    const result = buildOperatorGoalsSection({ goalsMd: goals, tasks: [] });
    expect(result).toContain('## Set by your operator');
    expect(result).toContain('Find three remote FDE roles');
    expect(result).toContain('Done operator goal is not active');
    expect(result).not.toContain('Self-set research thread');
    expect(result).not.toContain('Old operator goal');
    expect(result).toContain('ask_human');
    expect(result.toLowerCase()).toContain('before your own goals');
  });

  test('appears in planner, continuous planner, executor and strategist prompts', () => {
    const base = {
      identity: 'TestBot',
      soul: 'A bot',
      motivations: 'Be helpful',
      goals,
      recentMemory: 'Did stuff',
      datetime: '2026-03-08T12:00:00Z',
      availableTools: ['web_search'],
      hasCreateTool: false,
    };
    expect(buildPlannerPrompt(base).system).toContain('## Set by your operator');
    expect(buildContinuousPlannerPrompt(base).system).toContain('## Set by your operator');
    expect(buildExecutorPrompt({ ...base, plan: ['Step 1'], workDir: '/tmp/test' })).toContain(
      '## Set by your operator'
    );
    expect(buildStrategistPrompt(base).system).toContain('## Set by your operator');
  });
});

describe('buildOperatorGoalsSection with tasks from the store', () => {
  const md = `## Active Goals
- [ ] Monday brief
  - status: in_progress
  - priority: high
  - source: operator
  - id: g-aaaaaaaa
`;
  const task = (id: string, text: string, lane: StoredTask['lane']): StoredTask => ({
    id,
    goalId: 'g-aaaaaaaa',
    text,
    lane,
    order: 0,
    by: 'agent',
    createdAt: '2026-10-12T00:00:00.000Z',
    cycles: [],
  });

  test('names each operator goal by id with its task counts and the task rule', () => {
    const out = buildOperatorGoalsSection({
      goalsMd: md,
      tasks: [task('t-aaaaaa', 'Pick sources', 'done'), task('t-bbbbbb', 'Draft', 'in_progress')],
    });
    expect(out).toContain('- [g-aaaaaaaa] Monday brief (in_progress) — 1 open task, 1 done');
    expect(out).toContain('update_task');
    expect(out).toContain('add_task');
  });

  test('legacy task lines in the markdown are not read', () => {
    const out = buildOperatorGoalsSection({
      goalsMd: md.replace('  - id:', '  - task: [ ] Old line {id: t-cccccc}\n  - id:'),
      tasks: [],
    });
    expect(out).toContain('- [g-aaaaaaaa] Monday brief (in_progress)');
    expect(out).not.toContain('open task');
    expect(out).not.toContain('update_task');
  });

  test('prompts render the goals view with the store tasks', () => {
    const base = {
      identity: 'TestBot',
      soul: 'A bot',
      motivations: 'Be helpful',
      goals: md,
      tasks: [task('t-bbbbbb', 'Draft 600 words', 'in_progress')],
      recentMemory: 'Did stuff',
      datetime: '2026-03-08T12:00:00Z',
      availableTools: ['web_search'],
      hasCreateTool: false,
    };
    const line = '[~] t-bbbbbb Draft 600 words';
    expect(buildPlannerPrompt(base).system).toContain(line);
    expect(buildContinuousPlannerPrompt(base).system).toContain(line);
    expect(buildExecutorPrompt({ ...base, plan: ['Step 1'], workDir: '/tmp/test' })).toContain(
      line
    );
    expect(buildStrategistPrompt(base).system).toContain(line);
    expect(
      buildFeedbackProcessorPrompt({ ...base, feedbackContent: 'x', availableTools: [] }).system
    ).toContain(line);
  });
});

describe('strategist prompt asks for reasons (why-everywhere rows 12 and 13)', () => {
  const system = () =>
    buildStrategistPrompt({
      identity: 'TestBot',
      soul: 'A bot',
      motivations: 'Be helpful',
      goals: '## Goals\n- Goal 1',
      recentMemory: 'Did stuff',
      datetime: '2026-03-08T12:00:00Z',
    }).system;

  test('one short reason per goal operation', () => {
    // The line now also says the reason is required for a drop (relevance check).
    expect(system()).toMatch(/- reason: string \(one short sentence: why this change[;)]/);
  });

  test('one short reason per adjusted trait, in trait_reasons', () => {
    expect(system()).toMatch(/- trait_reasons: object/);
  });
});

describe('the conversation is not loop work', () => {
  const replies = ['Tenés razón, no más resúmenes salvo que los pidas.'];
  const planner = {
    identity: 'TestBot',
    soul: 'A bot',
    motivations: 'Be helpful',
    goals: '## Goals\n- Goal 1',
    recentMemory: 'Did stuff',
    datetime: '2026-03-08T12:00:00Z',
    availableTools: ['web_search'],
    hasCreateTool: false,
  };

  test('the section states the rule and lists what the conversation already said', () => {
    const text = buildConversationSection(replies);
    expect(text).toContain('CONVERSATION IS NOT WORK');
    expect(text).toContain('Already said in chat');
    expect(text).toContain('no más resúmenes');
  });

  test('without replies the rule stands alone', () => {
    const text = buildConversationSection();
    expect(text).toContain('CONVERSATION IS NOT WORK');
    expect(text).not.toContain('Already said in chat');
  });

  test('replies are clipped', () => {
    const text = buildConversationSection(['x'.repeat(1000)]);
    expect(text).not.toContain('x'.repeat(201));
  });

  test('planner, continuous planner, executor and strategist all carry it', () => {
    expect(buildPlannerPrompt({ ...planner, chatReplies: replies }).system).toContain(
      'no más resúmenes'
    );
    expect(buildContinuousPlannerPrompt({ ...planner, chatReplies: replies }).system).toContain(
      'no más resúmenes'
    );
    expect(
      buildExecutorPrompt({
        plan: ['Step 1'],
        identity: 'TestBot',
        soul: 'A bot',
        motivations: 'Be helpful',
        goals: '## Goals',
        datetime: '2026-03-08T12:00:00Z',
        hasCreateTool: false,
        workDir: '/tmp/test',
        chatReplies: replies,
      })
    ).toContain('no más resúmenes');
    expect(buildStrategistPrompt({ ...planner, chatReplies: replies }).system).toContain(
      'CONVERSATION IS NOT WORK'
    );
  });
});

describe('Fleet broadcast section (watcher phase 3)', () => {
  const planner = {
    identity: 'TestBot',
    soul: 'A bot',
    motivations: 'Be helpful',
    goals: '## Goals\n- Goal 1',
    recentMemory: 'Did stuff',
    datetime: '2026-03-08T12:00:00Z',
    availableTools: ['web_search'],
    hasCreateTool: false,
  };
  const items = [
    { id: 'b-11111111', kind: 'directive' as const, text: 'Coordinate with Scout on Acme' },
    { id: 'b-22222222', kind: 'wake' as const, text: '' },
  ];

  test('lists every broadcast with its id and the serves_broadcast instruction', () => {
    const text = buildFleetBroadcastSection(items);
    expect(text).toContain('## Fleet broadcast');
    expect(text).toContain('- [b-11111111] directive: Coordinate with Scout on Acme');
    expect(text).toContain('- [b-22222222] wake: the fleet watcher woke you');
    expect(text).toContain('serves_broadcast');
  });

  test('empty when there are no broadcasts', () => {
    expect(buildFleetBroadcastSection([])).toBe('');
  });

  test('both planner prompts carry it, with the serves_broadcast schema line', () => {
    const fleetBroadcast = buildFleetBroadcastSection(items);
    for (const build of [buildPlannerPrompt, buildContinuousPlannerPrompt]) {
      const { system } = build({ ...planner, fleetBroadcast });
      expect(system).toContain('## Fleet broadcast');
      expect(system).toContain('- serves_broadcast: string');
    }
  });

  test('without broadcasts neither prompt has the section nor the schema line', () => {
    for (const build of [buildPlannerPrompt, buildContinuousPlannerPrompt]) {
      const { system } = build(planner);
      expect(system).not.toContain('## Fleet broadcast');
      expect(system).not.toContain('serves_broadcast');
    }
  });
});

describe('Your current state section (watcher phase 4)', () => {
  const planner = {
    identity: 'TestBot',
    soul: 'A bot',
    motivations: 'Be helpful',
    goals: '## Goals\n- Goal 1',
    recentMemory: 'Did stuff',
    datetime: '2026-03-08T12:00:00Z',
    availableTools: ['web_search'],
    hasCreateTool: false,
  };
  const now = Date.parse('2026-10-23T10:00:00Z');
  const state = {
    presence: {
      executing: true,
      phase: 'executor',
      currentTool: 'web_fetch',
      since: now - 120_000,
    },
    cycle: {
      cycleId: 'c-1',
      plan: 'Read the Acme filings',
      goalId: 'g-aaaaaaaa',
      goalTitle: 'Map Acme',
    },
    fleetFocus: ['Jarvis and Scout both research Acme'],
  };

  test('renders phase, tool, since, the cycle and the fleet focus', () => {
    const text = buildSelfStateSection(state, now);
    expect(text).toContain('## Your current state');
    expect(text).toContain('executor');
    expect(text).toContain('web_fetch');
    expect(text).toContain('2m ago');
    expect(text).toContain('Map Acme (g-aaaaaaaa)');
    expect(text).toContain('Read the Acme filings');
    expect(text).toContain('Jarvis and Scout both research Acme');
  });

  test('idle with no cycle and no fleet focus still says so', () => {
    const text = buildSelfStateSection(
      {
        presence: { executing: false, phase: null, currentTool: null, since: null },
        fleetFocus: [],
      },
      now
    );
    expect(text).toContain('idle between cycles');
    expect(text).not.toContain('Cycle:');
    expect(text).not.toContain('The fleet is attending to');
  });

  test('empty when the watcher is off', () => {
    expect(buildSelfStateSection(undefined)).toBe('');
  });

  test('both planner prompts carry it before the fleet broadcast', () => {
    const selfState = buildSelfStateSection(state, now);
    const fleetBroadcast = buildFleetBroadcastSection([
      { id: 'b-11111111', kind: 'directive', text: 'x' },
    ]);
    for (const build of [buildPlannerPrompt, buildContinuousPlannerPrompt]) {
      const { system } = build({ ...planner, selfState, fleetBroadcast });
      expect(system).toContain('## Your current state');
      expect(system.indexOf('## Your current state')).toBeLessThan(
        system.indexOf('## Fleet broadcast')
      );
    }
  });

  test('without the watcher neither prompt has the section', () => {
    for (const build of [buildPlannerPrompt, buildContinuousPlannerPrompt]) {
      expect(build(planner).system).not.toContain('## Your current state');
    }
  });
});
