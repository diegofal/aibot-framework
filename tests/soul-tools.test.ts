import { describe, expect, mock, test } from 'bun:test';
import { createSaveMemoryTool, resolveFactParam } from '../src/tools/soul';

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
      appendDailyMemory: (fact: string) => {
        savedFact = fact;
      },
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
      appendDailyMemory: (fact: string) => {
        savedFact = fact;
      },
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
      appendDailyMemory: (fact: string) => {
        savedFact = fact;
      },
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

  test('accepts "content" as alias for "fact" (common LLM mistake)', async () => {
    let savedFact = '';
    const mockSoulLoader = {
      appendDailyMemory: (f: string) => {
        savedFact = f;
      },
    };
    const tool = createSaveMemoryTool(() => mockSoulLoader as any);

    const result = await tool.execute(
      { content: 'Curiosity scan 2026-03-04', source: 'web_search', _botId: 'test' },
      mockLogger
    );

    expect(result.success).toBe(true);
    expect(savedFact).toBe('Curiosity scan 2026-03-04');
  });

  test('accepts "value" as alias for "fact"', async () => {
    let savedFact = '';
    const mockSoulLoader = {
      appendDailyMemory: (f: string) => {
        savedFact = f;
      },
    };
    const tool = createSaveMemoryTool(() => mockSoulLoader as any);

    const result = await tool.execute(
      { category: 'pricing', key: 'deploy-script', value: 'Created deploy script', _botId: 'test' },
      mockLogger
    );

    expect(result.success).toBe(true);
    expect(savedFact).toBe('Created deploy script');
  });

  test('accepts "text" as alias for "fact"', async () => {
    let savedFact = '';
    const mockSoulLoader = {
      appendDailyMemory: (f: string) => {
        savedFact = f;
      },
    };
    const tool = createSaveMemoryTool(() => mockSoulLoader as any);

    const result = await tool.execute({ text: 'Some important note', _botId: 'test' }, mockLogger);

    expect(result.success).toBe(true);
    expect(savedFact).toBe('Some important note');
  });

  test('"fact" takes priority over aliases', async () => {
    let savedFact = '';
    const mockSoulLoader = {
      appendDailyMemory: (f: string) => {
        savedFact = f;
      },
    };
    const tool = createSaveMemoryTool(() => mockSoulLoader as any);

    const result = await tool.execute(
      { fact: 'correct value', content: 'should be ignored', _botId: 'test' },
      mockLogger
    );

    expect(result.success).toBe(true);
    expect(savedFact).toBe('correct value');
  });

  test('rejects when no alias has a value either', async () => {
    const tool = createSaveMemoryTool(() => ({ appendDailyMemory: () => {} }) as any);
    const result = await tool.execute({ source: 'web_search', _botId: 'test' }, mockLogger);
    expect(result.success).toBe(false);
  });
});

describe('resolveFactParam', () => {
  test('returns fact when present', () => {
    expect(resolveFactParam({ fact: 'hello' })).toBe('hello');
  });

  test('returns content as fallback', () => {
    expect(resolveFactParam({ content: 'hello' })).toBe('hello');
  });

  test('returns text as fallback', () => {
    expect(resolveFactParam({ text: 'hello' })).toBe('hello');
  });

  test('returns value as fallback', () => {
    expect(resolveFactParam({ value: 'hello' })).toBe('hello');
  });

  test('returns empty for no matching key', () => {
    expect(resolveFactParam({ source: 'web' })).toBe('');
  });

  test('fact takes priority over aliases', () => {
    expect(resolveFactParam({ fact: 'primary', content: 'alias' })).toBe('primary');
  });

  test('trims whitespace', () => {
    expect(resolveFactParam({ fact: '  hello  ' })).toBe('hello');
    expect(resolveFactParam({ content: '  world  ' })).toBe('world');
  });

  test('skips empty string aliases', () => {
    expect(resolveFactParam({ content: '', text: '', value: 'found' })).toBe('found');
  });
});
