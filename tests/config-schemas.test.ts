import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { GlobalAgentLoopConfigSchema, BotAgentLoopOverrideSchema } from '../src/config';

describe('GlobalAgentLoopConfigSchema', () => {
  test('defaults claudeTimeout to 120_000', () => {
    const result = GlobalAgentLoopConfigSchema.parse({});
    expect(result.claudeTimeout).toBe(120_000);
  });

  test('accepts custom claudeTimeout', () => {
    const result = GlobalAgentLoopConfigSchema.parse({ claudeTimeout: 600_000 });
    expect(result.claudeTimeout).toBe(600_000);
  });

  test('rejects zero claudeTimeout', () => {
    expect(() => GlobalAgentLoopConfigSchema.parse({ claudeTimeout: 0 })).toThrow();
  });

  test('rejects negative claudeTimeout', () => {
    expect(() => GlobalAgentLoopConfigSchema.parse({ claudeTimeout: -1000 })).toThrow();
  });

  test('rejects non-integer claudeTimeout', () => {
    expect(() => GlobalAgentLoopConfigSchema.parse({ claudeTimeout: 1.5 })).toThrow();
  });

  test('provides all defaults from empty object', () => {
    const result = GlobalAgentLoopConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.every).toBe('6h');
    expect(result.minInterval).toBe('1m');
    expect(result.maxInterval).toBe('24h');
    expect(result.maxToolRounds).toBe(10);
    expect(result.maxDurationMs).toBe(300_000);
  });
});

describe('BotAgentLoopOverrideSchema', () => {
  test('accepts claudeTimeout override', () => {
    const result = BotAgentLoopOverrideSchema.parse({ claudeTimeout: 600_000 });
    expect(result!.claudeTimeout).toBe(600_000);
  });

  test('accepts undefined (all optional)', () => {
    const result = BotAgentLoopOverrideSchema.parse(undefined);
    expect(result).toBeUndefined();
  });

  test('accepts empty object', () => {
    const result = BotAgentLoopOverrideSchema.parse({});
    expect(result).toBeDefined();
    expect(result!.claudeTimeout).toBeUndefined();
  });

  test('rejects invalid claudeTimeout', () => {
    expect(() => BotAgentLoopOverrideSchema.parse({ claudeTimeout: -1 })).toThrow();
    expect(() => BotAgentLoopOverrideSchema.parse({ claudeTimeout: 0 })).toThrow();
  });

  test('accepts reportChatId alongside claudeTimeout', () => {
    const result = BotAgentLoopOverrideSchema.parse({
      reportChatId: 12345,
      claudeTimeout: 300_000,
    });
    expect(result!.reportChatId).toBe(12345);
    expect(result!.claudeTimeout).toBe(300_000);
  });
});
