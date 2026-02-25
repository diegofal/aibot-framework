import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { GlobalAgentLoopConfigSchema, BotAgentLoopOverrideSchema, RedditConfigSchema, TwitterConfigSchema, CalendarConfigSchema } from '../src/config';

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
    expect(result.maxToolRounds).toBe(30);
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

  test('accepts maxToolRounds override', () => {
    const result = BotAgentLoopOverrideSchema.parse({ maxToolRounds: 15 });
    expect(result!.maxToolRounds).toBe(15);
  });

  test('maxToolRounds defaults to undefined (uses global)', () => {
    const result = BotAgentLoopOverrideSchema.parse({});
    expect(result!.maxToolRounds).toBeUndefined();
  });

  test('rejects invalid maxToolRounds', () => {
    expect(() => BotAgentLoopOverrideSchema.parse({ maxToolRounds: 0 })).toThrow();
    expect(() => BotAgentLoopOverrideSchema.parse({ maxToolRounds: 51 })).toThrow();
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
    expect(() => CalendarConfigSchema.parse({
      provider: 'outlook',
      apiKey: 'key',
    })).toThrow();
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
