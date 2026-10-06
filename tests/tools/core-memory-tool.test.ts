import { describe, expect, test } from 'bun:test';
import { createCoreMemoryTools } from '../../src/tools/core-memory';

const logger = {} as any;

function appendTool(calls: unknown[] = []) {
  const fake = {
    set: async (...a: unknown[]) => {
      calls.push(a);
    },
  } as any;
  const tool = createCoreMemoryTools(fake).find(
    (t) => t.definition.function.name === 'core_memory_append'
  );
  if (!tool) throw new Error('core_memory_append missing');
  return tool;
}

describe('core_memory_append value limit', () => {
  test('the schema declares the 2000-char limit', () => {
    const params = appendTool().definition.function.parameters as any;
    expect(params.properties.value.maxLength).toBe(2000);
  });

  test('an oversized value is refused before saving, naming its length and what to do', async () => {
    const calls: unknown[] = [];
    const result = await appendTool(calls).execute(
      { category: 'general', key: 'notes', value: 'x'.repeat(2345), _botId: 'b1' },
      logger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('2345');
    expect(result.content).toContain('2000');
    expect(result.content).toMatch(/split|file/i);
    expect(calls).toHaveLength(0);
  });

  test('a value at the limit is saved', async () => {
    const calls: unknown[] = [];
    const result = await appendTool(calls).execute(
      { category: 'general', key: 'notes', value: 'x'.repeat(2000), _botId: 'b1' },
      logger
    );
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
