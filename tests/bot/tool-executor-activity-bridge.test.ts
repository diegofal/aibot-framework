import { describe, expect, it, mock } from 'bun:test';
import { ActivityStream } from '../../src/bot/activity-stream';
import { ToolExecutor } from '../../src/bot/tool-executor';
import type { BotContext } from '../../src/bot/types';
import type { Tool, ToolResult } from '../../src/tools/types';

function createTestTool(name: string, result: ToolResult): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `Test tool ${name}`,
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: async () => result,
  };
}

function createThrowingTool(name: string, error: string): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `Throwing tool ${name}`,
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: async () => {
      throw new Error(error);
    },
  };
}

function createMockCtx(tools: Tool[], activityStream?: ActivityStream): BotContext {
  return {
    config: {
      bots: [{ id: 'bot1', name: 'Bot 1' }],
    } as any,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      child: () =>
        ({
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
          trace: () => {},
        }) as any,
    },
    tools,
    toolDefinitions: tools.map((t) => t.definition),
    activityStream,
  } as BotContext;
}

describe('ToolExecutor activity stream auto-bridge', () => {
  it('publishes tool:start and tool:end to activityStream on success', async () => {
    const stream = new ActivityStream();
    const published = mock(() => {});
    stream.on('activity', published);

    const tool = createTestTool('test_tool', { success: true, content: 'ok' });
    const ctx = createMockCtx([tool], stream);
    const executor = new ToolExecutor(ctx, { botId: 'bot1', chatId: 123 });

    await executor.execute('test_tool', {});

    // Should have tool:start + tool:end
    expect(published).toHaveBeenCalledTimes(2);
    const events = published.mock.calls.map((c) => c[0]);
    expect(events[0].type).toBe('tool:start');
    expect(events[0].botId).toBe('bot1');
    expect(events[0].data.toolName).toBe('test_tool');
    expect(events[1].type).toBe('tool:end');
    expect(events[1].data.success).toBe(true);
  });

  it('publishes tool:error to activityStream on execution failure', async () => {
    const stream = new ActivityStream();
    const published = mock(() => {});
    stream.on('activity', published);

    const tool = createThrowingTool('fail_tool', 'boom');
    const ctx = createMockCtx([tool], stream);
    const executor = new ToolExecutor(ctx, { botId: 'bot1', chatId: 123 });

    await executor.execute('fail_tool', {});

    const events = published.mock.calls.map((c) => c[0]);
    const types = events.map((e: any) => e.type);
    expect(types).toContain('tool:start');
    expect(types).toContain('tool:error');
    expect(types).toContain('tool:end');

    const errorEvent = events.find((e: any) => e.type === 'tool:error');
    expect(errorEvent.data.toolName).toBe('fail_tool');
    expect(errorEvent.data.error).toContain('boom');
  });

  it('does not crash when activityStream is undefined', async () => {
    const tool = createTestTool('test_tool', { success: true, content: 'ok' });
    const ctx = createMockCtx([tool]); // no activity stream
    const executor = new ToolExecutor(ctx, { botId: 'bot1', chatId: 123 });

    const result = await executor.execute('test_tool', {});
    expect(result.success).toBe(true);
  });

  it('truncates long result strings in activity events', async () => {
    const stream = new ActivityStream();
    const published = mock(() => {});
    stream.on('activity', published);

    const longResult = 'x'.repeat(500);
    const tool = createTestTool('long_tool', { success: true, content: longResult });
    const ctx = createMockCtx([tool], stream);
    const executor = new ToolExecutor(ctx, { botId: 'bot1', chatId: 123 });

    await executor.execute('long_tool', {});

    const endEvent = published.mock.calls.map((c) => c[0]).find((e: any) => e.type === 'tool:end');
    expect(endEvent.data.result.length).toBeLessThanOrEqual(300);
  });
});
