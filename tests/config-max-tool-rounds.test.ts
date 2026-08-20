import { describe, expect, test } from 'bun:test';
import {
  type BotConfig,
  type Config,
  DEFAULT_MAX_TOOL_ROUNDS,
  WebToolsConfigSchema,
  resolveMaxToolRounds,
} from '../src/config';

describe('resolveMaxToolRounds', () => {
  test('returns the global webTools.maxToolRounds when no bot override', () => {
    const config = { webTools: { maxToolRounds: 15 } } as Config;
    expect(resolveMaxToolRounds(config)).toBe(15);
  });

  test('per-bot maxToolRounds wins over the global', () => {
    const config = { webTools: { maxToolRounds: 15 } } as Config;
    const bot = { maxToolRounds: 40 } as BotConfig;
    expect(resolveMaxToolRounds(config, bot)).toBe(40);
  });

  test('returns undefined when neither is set', () => {
    const config = {} as Config;
    expect(resolveMaxToolRounds(config, {} as BotConfig)).toBeUndefined();
  });

  test('falls through to the global when the bot override is undefined', () => {
    const config = { webTools: { maxToolRounds: 15 } } as Config;
    const bot = { maxToolRounds: undefined } as unknown as BotConfig;
    expect(resolveMaxToolRounds(config, bot)).toBe(15);
  });

  test('DEFAULT_MAX_TOOL_ROUNDS matches the WebToolsConfigSchema default', () => {
    expect(WebToolsConfigSchema.parse({}).maxToolRounds).toBe(DEFAULT_MAX_TOOL_ROUNDS);
  });
});
