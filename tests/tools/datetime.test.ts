import { describe, test, expect } from 'bun:test';
import { createDatetimeTool } from '../../src/tools/datetime';

function createMockLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createMockLogger(),
    fatal: () => {},
    trace: () => {},
    level: 'info',
    silent: () => {},
  } as any;
}

const logger = createMockLogger();

describe('get_datetime tool', () => {
  const tool = createDatetimeTool({
    timezone: 'America/Argentina/Buenos_Aires',
    locale: 'es-AR',
  });

  test('has correct definition', () => {
    expect(tool.definition.function.name).toBe('get_datetime');
    expect(tool.definition.type).toBe('function');
  });

  test('returns current datetime with default timezone', async () => {
    const result = await tool.execute({}, logger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Date:');
    expect(result.content).toContain('Time:');
    expect(result.content).toContain('Day:');
    expect(result.content).toContain('Timezone: America/Argentina/Buenos_Aires');
    expect(result.content).toContain('ISO 8601:');
  });

  test('accepts timezone override', async () => {
    const result = await tool.execute({ timezone: 'America/New_York' }, logger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Timezone: America/New_York');
  });

  test('rejects invalid timezone', async () => {
    const result = await tool.execute({ timezone: 'Invalid/Zone' }, logger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Invalid timezone');
  });

  test('ignores empty timezone string', async () => {
    const result = await tool.execute({ timezone: '  ' }, logger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Timezone: America/Argentina/Buenos_Aires');
  });

  test('ignores non-string timezone', async () => {
    const result = await tool.execute({ timezone: 42 }, logger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Timezone: America/Argentina/Buenos_Aires');
  });

  test('ISO 8601 timestamp is valid', async () => {
    const result = await tool.execute({}, logger);
    const isoMatch = result.content.match(/ISO 8601: (.+)/);
    expect(isoMatch).toBeTruthy();
    const parsed = new Date(isoMatch![1]);
    expect(parsed.getTime()).not.toBeNaN();
    // Should be within last few seconds
    expect(Date.now() - parsed.getTime()).toBeLessThan(5000);
  });
});
