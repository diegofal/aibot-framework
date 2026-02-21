import { describe, test, expect, mock } from 'bun:test';
import { createSaveMemoryTool } from '../src/tools/soul';

const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
} as any;

describe('save_memory tool', () => {
  test('truncates facts longer than 2000 characters', async () => {
    let savedFact = '';
    const mockSoulLoader = {
      appendDailyMemory: (fact: string) => { savedFact = fact; },
    };
    const tool = createSaveMemoryTool(() => mockSoulLoader as any);

    const longFact = 'x'.repeat(3000);
    const result = await tool.execute({ fact: longFact, _botId: 'test' }, mockLogger);

    expect(result.success).toBe(true);
    // 2000 chars + '\n...(truncated)' = 2015 chars
    expect(savedFact.length).toBe(2000 + '\n...(truncated)'.length);
    expect(savedFact.endsWith('\n...(truncated)')).toBe(true);
  });

  test('does not truncate facts under 2000 characters', async () => {
    let savedFact = '';
    const mockSoulLoader = {
      appendDailyMemory: (fact: string) => { savedFact = fact; },
    };
    const tool = createSaveMemoryTool(() => mockSoulLoader as any);

    const shortFact = 'This is a normal fact';
    const result = await tool.execute({ fact: shortFact, _botId: 'test' }, mockLogger);

    expect(result.success).toBe(true);
    expect(savedFact).toBe(shortFact);
  });

  test('does not truncate facts exactly at 2000 characters', async () => {
    let savedFact = '';
    const mockSoulLoader = {
      appendDailyMemory: (fact: string) => { savedFact = fact; },
    };
    const tool = createSaveMemoryTool(() => mockSoulLoader as any);

    const exactFact = 'y'.repeat(2000);
    const result = await tool.execute({ fact: exactFact, _botId: 'test' }, mockLogger);

    expect(result.success).toBe(true);
    expect(savedFact).toBe(exactFact);
    expect(savedFact.length).toBe(2000);
  });

  test('rejects empty fact', async () => {
    const tool = createSaveMemoryTool(() => ({ appendDailyMemory: () => {} }) as any);
    const result = await tool.execute({ fact: '', _botId: 'test' }, mockLogger);
    expect(result.success).toBe(false);
  });
});
