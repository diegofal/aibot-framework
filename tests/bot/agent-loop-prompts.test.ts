import { describe, test, expect } from 'bun:test';
import { buildFeedbackProcessorPrompt } from '../../src/bot/agent-loop-prompts';

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
