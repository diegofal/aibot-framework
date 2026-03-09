import { describe, expect, it, mock } from 'bun:test';
import type { SoulLoader } from '../../src/soul';
import { createSaveMemoryTool } from '../../src/tools/soul';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as any;

describe('save_memory userId isolation', () => {
  it('passes _userId to appendDailyMemory', async () => {
    const appendCalls: { fact: string; userId?: string }[] = [];
    const mockSoulLoader = {
      appendDailyMemory: (fact: string, userId?: string) => {
        appendCalls.push({ fact, userId });
      },
    };
    const tool = createSaveMemoryTool(() => mockSoulLoader as any);

    await tool.execute({ fact: 'User likes cats', _botId: 'bot1', _userId: '12345' }, noopLogger);

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0].fact).toBe('User likes cats');
    expect(appendCalls[0].userId).toBe('12345');
  });

  it('does not pass userId when _userId is absent', async () => {
    const appendCalls: { fact: string; userId?: string }[] = [];
    const mockSoulLoader = {
      appendDailyMemory: (fact: string, userId?: string) => {
        appendCalls.push({ fact, userId });
      },
    };
    const tool = createSaveMemoryTool(() => mockSoulLoader as any);

    await tool.execute({ fact: 'General fact', _botId: 'bot1' }, noopLogger);

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0].userId).toBeUndefined();
  });
});
