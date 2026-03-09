import { describe, expect, test } from 'bun:test';
import { resolveDirectives } from '../../src/bot/agent-scheduler';
import type { BotConfig } from '../../src/config';

describe('resolveDirectives', () => {
  const baseBotConfig: BotConfig = {
    id: 'test-bot',
    name: 'Test Bot',
    token: '',
    enabled: true,
    skills: [],
  };

  test('returns empty array when no bot config', () => {
    expect(resolveDirectives(undefined)).toEqual([]);
  });

  test('returns empty array when no agentLoop config', () => {
    expect(resolveDirectives(baseBotConfig)).toEqual([]);
  });

  test('returns empty array when agentLoop has no directives', () => {
    const config = { ...baseBotConfig, agentLoop: { mode: 'periodic' as const } };
    expect(resolveDirectives(config)).toEqual([]);
  });

  test('returns custom directives only', () => {
    const config = {
      ...baseBotConfig,
      agentLoop: {
        directives: ['Check the weather daily', 'Review inbox'],
      },
    };
    expect(resolveDirectives(config)).toEqual(['Check the weather daily', 'Review inbox']);
  });

  test('returns preset directives only', () => {
    const config = {
      ...baseBotConfig,
      agentLoop: {
        presetDirectives: ['conversation-review' as const],
      },
    };
    const result = resolveDirectives(config);
    expect(result.length).toBe(1);
    expect(result[0]).toContain('Periodically review recent conversation session logs');
  });

  test('returns both custom and preset directives', () => {
    const config = {
      ...baseBotConfig,
      agentLoop: {
        directives: ['Custom instruction'],
        presetDirectives: ['conversation-review' as const],
      },
    };
    const result = resolveDirectives(config);
    expect(result.length).toBe(2);
    expect(result[0]).toBe('Custom instruction');
    expect(result[1]).toContain('Periodically review');
  });

  test('handles unknown preset gracefully', () => {
    const config = {
      ...baseBotConfig,
      agentLoop: {
        directives: ['Keep it simple'],
        presetDirectives: ['nonexistent-preset' as unknown as 'conversation-review'],
      },
    };
    const result = resolveDirectives(config);
    expect(result).toEqual(['Keep it simple']);
  });

  test('handles empty arrays', () => {
    const config = {
      ...baseBotConfig,
      agentLoop: {
        directives: [],
        presetDirectives: [],
      },
    };
    expect(resolveDirectives(config)).toEqual([]);
  });
});
