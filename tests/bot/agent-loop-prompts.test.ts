import { describe, expect, test } from 'bun:test';
import {
  AVAILABLE_PRESETS,
  PRESET_DIRECTIVE_DEFINITIONS,
  buildContinuousPlannerPrompt,
  buildDirectivesSection,
  buildExecutorPrompt,
  buildFeedbackProcessorPrompt,
  buildPlannerPrompt,
  buildStrategistPrompt,
} from '../../src/bot/agent-loop-prompts';

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
