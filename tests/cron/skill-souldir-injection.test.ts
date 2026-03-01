import { describe, expect, it } from 'bun:test';
import { resolveAgentConfig } from '../../src/config';

describe('resolveAgentConfig soulDir for skill cron jobs', () => {
  const minimalGlobalConfig = {
    soul: { dir: './config/soul' },
    ollama: { models: { primary: 'llama3.2' } },
    conversation: {
      systemPrompt: 'test',
      temperature: 0.7,
      maxHistory: 50,
    },
    productions: { baseDir: './productions' },
  } as any;

  it('resolves soulDir to per-bot subdirectory when bot has no soulDir override', () => {
    const botConfig = { id: 'finny', soulDir: undefined } as any;
    const resolved = resolveAgentConfig(minimalGlobalConfig, botConfig);
    expect(resolved.soulDir).toBe('./config/soul/finny');
  });

  it('uses explicit bot soulDir override when provided', () => {
    const botConfig = { id: 'finny', soulDir: '/custom/path/finny' } as any;
    const resolved = resolveAgentConfig(minimalGlobalConfig, botConfig);
    expect(resolved.soulDir).toBe('/custom/path/finny');
  });

  it('produces different soulDirs for different bots', () => {
    const bot1 = { id: 'finny' } as any;
    const bot2 = { id: 'makemylifeeasier' } as any;

    const resolved1 = resolveAgentConfig(minimalGlobalConfig, bot1);
    const resolved2 = resolveAgentConfig(minimalGlobalConfig, bot2);

    expect(resolved1.soulDir).toBe('./config/soul/finny');
    expect(resolved2.soulDir).toBe('./config/soul/makemylifeeasier');
    expect(resolved1.soulDir).not.toBe(resolved2.soulDir);
  });
});
