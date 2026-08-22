/**
 * New top-level config surfaces: `operator` (who the bots report to) and
 * `askHuman` (the inbox protocol limits), plus `bots[].token: null` as the
 * explicit "headless on purpose" value.
 */
import { describe, expect, test } from 'bun:test';
import { AskHumanConfigSchema, BotConfigSchema, OperatorConfigSchema } from '../src/config';

describe('BotConfigSchema.token', () => {
  const base = { id: 'b', name: 'B', skills: [] };

  test('null is accepted and normalised to the empty string (missing)', () => {
    const parsed = BotConfigSchema.parse({ ...base, token: null });
    expect(parsed.token).toBe('');
  });

  test('omitted stays the empty string', () => {
    expect(BotConfigSchema.parse(base).token).toBe('');
  });

  test('a string passes through untouched', () => {
    expect(BotConfigSchema.parse({ ...base, token: '123:abc' }).token).toBe('123:abc');
  });

  test('non-string, non-null values are still rejected', () => {
    expect(() => BotConfigSchema.parse({ ...base, token: 42 })).toThrow();
  });
});

describe('OperatorConfigSchema', () => {
  test('everything is optional and an empty object is valid', () => {
    expect(OperatorConfigSchema.parse({})).toEqual({});
  });

  test('accepts the full shape', () => {
    const parsed = OperatorConfigSchema.parse({
      name: 'Diego',
      telegramChatId: 796164002,
      email: 'diego@example.com',
      notifyOnAsk: true,
    });
    expect(parsed).toEqual({
      name: 'Diego',
      telegramChatId: 796164002,
      email: 'diego@example.com',
      notifyOnAsk: true,
    });
  });

  test('telegramChatId must be an integer', () => {
    expect(() => OperatorConfigSchema.parse({ telegramChatId: '796164002' })).toThrow();
    expect(() => OperatorConfigSchema.parse({ telegramChatId: 1.5 })).toThrow();
  });
});

describe('AskHumanConfigSchema', () => {
  test('defaults: maxChars 600, autoCloseHours 72', () => {
    expect(AskHumanConfigSchema.parse({})).toEqual({ maxChars: 600, autoCloseHours: 72 });
  });

  test('accepts overrides and rejects non-positive values', () => {
    expect(AskHumanConfigSchema.parse({ maxChars: 400, autoCloseHours: 24 })).toEqual({
      maxChars: 400,
      autoCloseHours: 24,
    });
    expect(() => AskHumanConfigSchema.parse({ maxChars: 0 })).toThrow();
    expect(() => AskHumanConfigSchema.parse({ autoCloseHours: -1 })).toThrow();
  });
});
