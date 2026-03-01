import { describe, expect, test } from 'bun:test';
import type { ExternalToolDef } from '../../src/core/external-skill-loader';
import { adaptExternalTool } from '../../src/core/external-tool-adapter';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLogger,
  level: 'debug',
  fatal: () => {},
} as any;

function makeDef(name: string, description = 'test tool'): ExternalToolDef {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    },
  };
}

describe('adaptExternalTool', () => {
  test('namespaces tool name as skillId_toolName', () => {
    const handler = async () => 'ok';
    const tool = adaptExternalTool(
      'github',
      makeDef('repo_list'),
      handler,
      {},
      new Map(),
      mockLogger
    );
    expect(tool.definition.function.name).toBe('github_repo_list');
  });

  test('prefixes description with skill ID', () => {
    const handler = async () => 'ok';
    const tool = adaptExternalTool(
      'github',
      makeDef('repo_list', 'List repos'),
      handler,
      {},
      new Map(),
      mockLogger
    );
    expect(tool.definition.function.description).toBe('[github] List repos');
  });

  test('preserves parameter schema', () => {
    const handler = async () => 'ok';
    const def = makeDef('test_tool');
    const tool = adaptExternalTool('skill', def, handler, {}, new Map(), mockLogger);
    expect(tool.definition.function.parameters.properties).toEqual({ input: { type: 'string' } });
    expect(tool.definition.function.parameters.required).toEqual(['input']);
  });

  test('returns string result as-is', async () => {
    const handler = async () => 'hello world';
    const tool = adaptExternalTool('skill', makeDef('test'), handler, {}, new Map(), mockLogger);
    const result = await tool.execute({ input: 'x' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toBe('hello world');
  });

  test('JSON-stringifies object results', async () => {
    const handler = async () => ({ name: 'test', count: 42 });
    const tool = adaptExternalTool('skill', makeDef('test'), handler, {}, new Map(), mockLogger);
    const result = await tool.execute({ input: 'x' }, mockLogger);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.name).toBe('test');
    expect(parsed.count).toBe(42);
  });

  test('returns empty string for undefined result', async () => {
    const handler = async () => undefined;
    const tool = adaptExternalTool('skill', makeDef('test'), handler, {}, new Map(), mockLogger);
    const result = await tool.execute({ input: 'x' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toBe('');
  });

  test('returns empty string for null result', async () => {
    const handler = async () => null;
    const tool = adaptExternalTool('skill', makeDef('test'), handler, {}, new Map(), mockLogger);
    const result = await tool.execute({ input: 'x' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toBe('');
  });

  test('catches errors and returns success: false', async () => {
    const handler = async () => {
      throw new Error('boom');
    };
    const tool = adaptExternalTool('skill', makeDef('test'), handler, {}, new Map(), mockLogger);
    const result = await tool.execute({ input: 'x' }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toBe('boom');
  });

  test('catches non-Error throws', async () => {
    const handler = async () => {
      throw 'string error';
    };
    const tool = adaptExternalTool('skill', makeDef('test'), handler, {}, new Map(), mockLogger);
    const result = await tool.execute({ input: 'x' }, mockLogger);
    expect(result.success).toBe(false);
    expect(result.content).toBe('string error');
  });

  test('state persists across calls', async () => {
    const state = new Map<string, unknown>();
    const handler = async (_args: Record<string, unknown>, ctx: any) => {
      const count = ((ctx.state.get('count') as number) ?? 0) + 1;
      ctx.state.set('count', count);
      return count;
    };
    const tool = adaptExternalTool('skill', makeDef('counter'), handler, {}, state, mockLogger);

    const r1 = await tool.execute({ input: 'x' }, mockLogger);
    expect(r1.content).toBe('1');

    const r2 = await tool.execute({ input: 'x' }, mockLogger);
    expect(r2.content).toBe('2');

    const r3 = await tool.execute({ input: 'x' }, mockLogger);
    expect(r3.content).toBe('3');

    expect(state.get('count')).toBe(3);
  });

  test('passes config to handler context', async () => {
    const skillConfig = { api_key: 'secret-123', base_url: 'https://api.example.com' };
    let receivedConfig: Record<string, unknown> | undefined;
    const handler = async (_args: Record<string, unknown>, ctx: any) => {
      receivedConfig = ctx.config;
      return 'ok';
    };
    const tool = adaptExternalTool(
      'skill',
      makeDef('test'),
      handler,
      skillConfig,
      new Map(),
      mockLogger
    );
    await tool.execute({ input: 'x' }, mockLogger);

    expect(receivedConfig).toBeDefined();
    expect(receivedConfig?.api_key).toBe('secret-123');
    expect(receivedConfig?.base_url).toBe('https://api.example.com');
  });

  test('logger adapter has correct methods', async () => {
    const logCalls: string[] = [];
    const handler = async (_args: Record<string, unknown>, ctx: any) => {
      ctx.logger.debug('d');
      ctx.logger.info('i');
      ctx.logger.warn('w');
      ctx.logger.error('e');
      return 'ok';
    };

    // Create a mock logger that records calls
    const trackingLogger = {
      debug: (msg: any) => {
        if (typeof msg === 'string') logCalls.push(`debug:${msg}`);
      },
      info: (msg: any) => {
        if (typeof msg === 'string') logCalls.push(`info:${msg}`);
      },
      warn: (msg: any) => {
        if (typeof msg === 'string') logCalls.push(`warn:${msg}`);
      },
      error: (msg: any) => {
        if (typeof msg === 'string') logCalls.push(`error:${msg}`);
      },
      child: () => trackingLogger,
      level: 'debug',
      fatal: () => {},
    } as any;

    const tool = adaptExternalTool(
      'skill',
      makeDef('test'),
      handler,
      {},
      new Map(),
      trackingLogger
    );
    await tool.execute({ input: 'x' }, mockLogger);

    expect(logCalls).toContain('debug:d');
    expect(logCalls).toContain('info:i');
    expect(logCalls).toContain('warn:w');
    expect(logCalls).toContain('error:e');
  });

  test('passes args to handler', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const handler = async (args: Record<string, unknown>) => {
      receivedArgs = args;
      return 'ok';
    };
    const tool = adaptExternalTool('skill', makeDef('test'), handler, {}, new Map(), mockLogger);
    await tool.execute({ input: 'hello', extra: 42 }, mockLogger);

    expect(receivedArgs).toBeDefined();
    expect(receivedArgs?.input).toBe('hello');
    expect(receivedArgs?.extra).toBe(42);
  });

  test('definition type is function', () => {
    const handler = async () => 'ok';
    const tool = adaptExternalTool('skill', makeDef('test'), handler, {}, new Map(), mockLogger);
    expect(tool.definition.type).toBe('function');
  });
});
