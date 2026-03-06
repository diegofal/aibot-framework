import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  BotAgentLoopOverrideSchema,
  BotConfigSchema,
  CalendarConfigSchema,
  ClaudeCliConfigSchema,
  CompactionConfigSchema,
  GlobalAgentLoopConfigSchema,
  MMRConfigSchema,
  RedditConfigSchema,
  TwitterConfigSchema,
  WebToolsConfigSchema,
} from '../src/config';

describe('GlobalAgentLoopConfigSchema', () => {
  test('defaults claudeTimeout to 300_000', () => {
    const result = GlobalAgentLoopConfigSchema.parse({});
    expect(result.claudeTimeout).toBe(300_000);
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
    expect(result.maxToolRounds).toBe(30);
    expect(result.maxDurationMs).toBe(300_000);
  });
});

describe('BotAgentLoopOverrideSchema', () => {
  test('accepts claudeTimeout override', () => {
    const result = BotAgentLoopOverrideSchema.parse({ claudeTimeout: 600_000 });
    expect(result?.claudeTimeout).toBe(600_000);
  });

  test('accepts undefined (all optional)', () => {
    const result = BotAgentLoopOverrideSchema.parse(undefined);
    expect(result).toBeUndefined();
  });

  test('accepts empty object', () => {
    const result = BotAgentLoopOverrideSchema.parse({});
    expect(result).toBeDefined();
    expect(result?.claudeTimeout).toBeUndefined();
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
    expect(result?.reportChatId).toBe(12345);
    expect(result?.claudeTimeout).toBe(300_000);
  });

  test('accepts maxToolRounds override', () => {
    const result = BotAgentLoopOverrideSchema.parse({ maxToolRounds: 15 });
    expect(result?.maxToolRounds).toBe(15);
  });

  test('maxToolRounds defaults to undefined (uses global)', () => {
    const result = BotAgentLoopOverrideSchema.parse({});
    expect(result?.maxToolRounds).toBeUndefined();
  });

  test('rejects invalid maxToolRounds', () => {
    expect(() => BotAgentLoopOverrideSchema.parse({ maxToolRounds: 0 })).toThrow();
    expect(() => BotAgentLoopOverrideSchema.parse({ maxToolRounds: 51 })).toThrow();
  });
});

describe('BotConfigSchema maxToolRounds', () => {
  const minBot = { id: 'test', name: 'Test', skills: [] };

  test('maxToolRounds defaults to undefined (uses global)', () => {
    const result = BotConfigSchema.parse(minBot);
    expect(result.maxToolRounds).toBeUndefined();
  });

  test('accepts per-bot maxToolRounds override', () => {
    const result = BotConfigSchema.parse({ ...minBot, maxToolRounds: 25 });
    expect(result.maxToolRounds).toBe(25);
  });

  test('accepts maxToolRounds up to 50', () => {
    const result = BotConfigSchema.parse({ ...minBot, maxToolRounds: 50 });
    expect(result.maxToolRounds).toBe(50);
  });

  test('rejects maxToolRounds out of range', () => {
    expect(() => BotConfigSchema.parse({ ...minBot, maxToolRounds: 0 })).toThrow();
    expect(() => BotConfigSchema.parse({ ...minBot, maxToolRounds: 51 })).toThrow();
  });
});

describe('WebToolsConfigSchema maxToolRounds', () => {
  test('defaults to 5', () => {
    const result = WebToolsConfigSchema.parse({});
    expect(result.maxToolRounds).toBe(5);
  });

  test('accepts up to 50', () => {
    const result = WebToolsConfigSchema.parse({ maxToolRounds: 50 });
    expect(result.maxToolRounds).toBe(50);
  });

  test('rejects above 50', () => {
    expect(() => WebToolsConfigSchema.parse({ maxToolRounds: 51 })).toThrow();
  });
});

describe('RedditConfigSchema', () => {
  test('parses valid config with defaults', () => {
    const result = RedditConfigSchema.parse({
      clientId: 'cid',
      clientSecret: 'csecret',
      username: 'user',
      password: 'pass',
    });
    expect(result.enabled).toBe(false);
    expect(result.cacheTtlMs).toBe(300_000);
    expect(result.timeout).toBe(30_000);
    expect(result.userAgent).toContain('AIBot');
  });

  test('rejects missing required fields', () => {
    expect(() => RedditConfigSchema.parse({ clientId: 'x' })).toThrow();
    expect(() => RedditConfigSchema.parse({})).toThrow();
  });

  test('accepts enabled: true', () => {
    const result = RedditConfigSchema.parse({
      enabled: true,
      clientId: 'cid',
      clientSecret: 'csecret',
      username: 'user',
      password: 'pass',
    });
    expect(result.enabled).toBe(true);
  });
});

describe('TwitterConfigSchema', () => {
  test('parses valid config with defaults', () => {
    const result = TwitterConfigSchema.parse({
      apiKey: 'key',
      apiSecret: 'secret',
      bearerToken: 'bearer',
    });
    expect(result.enabled).toBe(false);
    expect(result.cacheTtlMs).toBe(120_000);
    expect(result.timeout).toBe(30_000);
    expect(result.accessToken).toBeUndefined();
    expect(result.accessSecret).toBeUndefined();
  });

  test('accepts write credentials', () => {
    const result = TwitterConfigSchema.parse({
      apiKey: 'key',
      apiSecret: 'secret',
      bearerToken: 'bearer',
      accessToken: 'at',
      accessSecret: 'as',
    });
    expect(result.accessToken).toBe('at');
    expect(result.accessSecret).toBe('as');
  });

  test('rejects missing required fields', () => {
    expect(() => TwitterConfigSchema.parse({ apiKey: 'x' })).toThrow();
    expect(() => TwitterConfigSchema.parse({})).toThrow();
  });
});

describe('CalendarConfigSchema', () => {
  test('parses valid Google config with defaults', () => {
    const result = CalendarConfigSchema.parse({
      provider: 'google',
      apiKey: 'key',
    });
    expect(result.enabled).toBe(false);
    expect(result.provider).toBe('google');
    expect(result.defaultTimezone).toBe('America/Argentina/Buenos_Aires');
    expect(result.cacheTtlMs).toBe(60_000);
    expect(result.calendarId).toBeUndefined();
  });

  test('parses valid Calendly config', () => {
    const result = CalendarConfigSchema.parse({
      provider: 'calendly',
      apiKey: 'cal-key',
    });
    expect(result.provider).toBe('calendly');
  });

  test('rejects invalid provider', () => {
    expect(() =>
      CalendarConfigSchema.parse({
        provider: 'outlook',
        apiKey: 'key',
      })
    ).toThrow();
  });

  test('rejects missing provider', () => {
    expect(() => CalendarConfigSchema.parse({ apiKey: 'key' })).toThrow();
  });

  test('accepts calendarId', () => {
    const result = CalendarConfigSchema.parse({
      provider: 'google',
      apiKey: 'key',
      calendarId: 'my-cal@group.calendar.google.com',
    });
    expect(result.calendarId).toBe('my-cal@group.calendar.google.com');
  });
});

describe('MMRConfigSchema', () => {
  test('provides defaults from empty object', () => {
    const result = MMRConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.lambda).toBe(0.7);
  });

  test('accepts enabled: true', () => {
    const result = MMRConfigSchema.parse({ enabled: true });
    expect(result.enabled).toBe(true);
  });

  test('accepts custom lambda', () => {
    const result = MMRConfigSchema.parse({ lambda: 0.5 });
    expect(result.lambda).toBe(0.5);
  });

  test('accepts lambda boundaries', () => {
    expect(MMRConfigSchema.parse({ lambda: 0 }).lambda).toBe(0);
    expect(MMRConfigSchema.parse({ lambda: 1 }).lambda).toBe(1);
  });

  test('rejects lambda out of range', () => {
    expect(() => MMRConfigSchema.parse({ lambda: -0.1 })).toThrow();
    expect(() => MMRConfigSchema.parse({ lambda: 1.1 })).toThrow();
  });
});

describe('CompactionConfigSchema', () => {
  test('provides all defaults from empty object', () => {
    const result = CompactionConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.contextWindows.ollamaTokens).toBe(8192);
    expect(result.contextWindows.claudeCliTokens).toBe(180_000);
    expect(result.thresholdRatio).toBe(0.75);
    expect(result.keepRecentMessages).toBe(6);
    expect(result.maxMessageChars).toBe(15_000);
    expect(result.maxOverflowRetries).toBe(2);
  });

  test('accepts custom values', () => {
    const result = CompactionConfigSchema.parse({
      enabled: false,
      thresholdRatio: 0.5,
      keepRecentMessages: 10,
      maxMessageChars: 20_000,
      maxOverflowRetries: 1,
      contextWindows: { ollamaTokens: 4096, claudeCliTokens: 100_000 },
    });
    expect(result.enabled).toBe(false);
    expect(result.thresholdRatio).toBe(0.5);
    expect(result.keepRecentMessages).toBe(10);
    expect(result.maxMessageChars).toBe(20_000);
    expect(result.maxOverflowRetries).toBe(1);
    expect(result.contextWindows.ollamaTokens).toBe(4096);
  });

  test('rejects thresholdRatio out of range', () => {
    expect(() => CompactionConfigSchema.parse({ thresholdRatio: 0.05 })).toThrow();
    expect(() => CompactionConfigSchema.parse({ thresholdRatio: 0.96 })).toThrow();
  });

  test('rejects keepRecentMessages below minimum', () => {
    expect(() => CompactionConfigSchema.parse({ keepRecentMessages: 1 })).toThrow();
  });

  test('rejects maxOverflowRetries out of range', () => {
    expect(() => CompactionConfigSchema.parse({ maxOverflowRetries: -1 })).toThrow();
    expect(() => CompactionConfigSchema.parse({ maxOverflowRetries: 4 })).toThrow();
  });

  test('rejects non-positive maxMessageChars', () => {
    expect(() => CompactionConfigSchema.parse({ maxMessageChars: 0 })).toThrow();
  });
});

describe('ClaudeCliConfigSchema', () => {
  test('defaults to empty object with no model', () => {
    const result = ClaudeCliConfigSchema.parse({});
    expect(result.model).toBeUndefined();
  });

  test('accepts a model string', () => {
    const result = ClaudeCliConfigSchema.parse({ model: 'sonnet' });
    expect(result.model).toBe('sonnet');
  });

  test('accepts undefined model', () => {
    const result = ClaudeCliConfigSchema.parse({ model: undefined });
    expect(result.model).toBeUndefined();
  });
});
