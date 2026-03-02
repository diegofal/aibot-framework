import { describe, expect, mock, test } from 'bun:test';
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

describe('adaptExternalTool cron integration', () => {
  test('cron.add delegates to CronService when cronDeps provided', async () => {
    const addMock = mock(async () => ({
      id: 'job-123',
      name: 'test-reminder',
      schedule: { kind: 'at' as const, at: '2026-03-01T12:00:00Z' },
      state: { nextRunAtMs: Date.now() + 60000 },
    }));
    const cronService = {
      add: addMock,
      remove: mock(async () => ({ ok: true, removed: true })),
      list: mock(async () => []),
    } as any;

    let capturedContext: any;
    const handler = async (_args: Record<string, unknown>, ctx: any) => {
      capturedContext = ctx;
      await ctx.cron.add({
        name: 'test-reminder',
        schedule: { kind: 'at', at: '2026-03-01T12:00:00Z' },
        text: 'Hello reminder',
        deleteAfterRun: true,
      });
      return 'ok';
    };

    const tool = adaptExternalTool(
      'reminders',
      makeDef('set_reminder'),
      handler,
      {},
      new Map(),
      mockLogger,
      { cronService }
    );

    // _chatId and _botId are injected by ToolExecutor
    await tool.execute({ input: 'test', _chatId: 42, _botId: 'bot1' }, mockLogger);

    expect(addMock).toHaveBeenCalledTimes(1);
    const addArgs = addMock.mock.calls[0][0];
    expect(addArgs.name).toBe('test-reminder');
    expect(addArgs.schedule).toEqual({ kind: 'at', at: '2026-03-01T12:00:00Z' });
    expect(addArgs.payload.text).toBe('Hello reminder');
    expect(addArgs.payload.chatId).toBe(42);
    expect(addArgs.payload.botId).toBe('bot1');
    expect(addArgs.deleteAfterRun).toBe(true);
  });

  test('cron.remove looks up job by name and removes by id', async () => {
    const removeMock = mock(async () => ({ ok: true, removed: true }));
    const listMock = mock(async () => [
      { id: 'uuid-456', name: 'reminder-abc', enabled: true, state: {} },
    ]);
    const cronService = {
      add: mock(async () => ({})),
      remove: removeMock,
      list: listMock,
    } as any;

    const handler = async (_args: Record<string, unknown>, ctx: any) => {
      await ctx.cron.remove({ jobId: 'reminder-abc' });
      return 'ok';
    };

    const tool = adaptExternalTool(
      'reminders',
      makeDef('cancel_reminder'),
      handler,
      {},
      new Map(),
      mockLogger,
      { cronService }
    );

    await tool.execute({ input: 'test', _chatId: 42, _botId: 'bot1' }, mockLogger);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock.mock.calls[0][0]).toBe('uuid-456');
  });

  test('cron.add logs warning when no cronDeps provided', async () => {
    const warnCalls: string[] = [];
    const trackingLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg: any) => {
        if (typeof msg === 'string') warnCalls.push(msg);
      },
      error: () => {},
      child: () => trackingLogger,
      level: 'debug',
      fatal: () => {},
    } as any;

    const handler = async (_args: Record<string, unknown>, ctx: any) => {
      await ctx.cron.add({ name: 'test' });
      return 'ok';
    };

    // No cronDeps → should log warning
    const tool = adaptExternalTool(
      'reminders',
      makeDef('set_reminder'),
      handler,
      {},
      new Map(),
      trackingLogger
    );

    await tool.execute({ input: 'test' }, trackingLogger);

    expect(warnCalls.some((w) => w.includes('no CronService available'))).toBe(true);
  });

  test('cron.add with "cron" schedule kind', async () => {
    const addMock = mock(async () => ({
      id: 'job-789',
      name: 'recurring-job',
      schedule: { kind: 'cron' as const, expr: '0 9 * * *', tz: 'America/Buenos_Aires' },
      state: { nextRunAtMs: Date.now() + 60000 },
    }));
    const cronService = {
      add: addMock,
      remove: mock(async () => ({})),
      list: mock(async () => []),
    } as any;

    const handler = async (_args: Record<string, unknown>, ctx: any) => {
      await ctx.cron.add({
        name: 'recurring-job',
        schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'America/Buenos_Aires' },
        text: 'Daily reminder',
      });
      return 'ok';
    };

    const tool = adaptExternalTool(
      'reminders',
      makeDef('set_recurring'),
      handler,
      {},
      new Map(),
      mockLogger,
      { cronService }
    );

    await tool.execute({ input: 'test', _chatId: 42, _botId: 'bot1' }, mockLogger);

    expect(addMock).toHaveBeenCalledTimes(1);
    const addArgs = addMock.mock.calls[0][0];
    expect(addArgs.schedule).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'America/Buenos_Aires',
    });
  });

  test('backward compatible — existing tests still work without cronDeps', async () => {
    const handler = async () => 'hello';
    const tool = adaptExternalTool('skill', makeDef('test'), handler, {}, new Map(), mockLogger);
    const result = await tool.execute({ input: 'x' }, mockLogger);
    expect(result.success).toBe(true);
    expect(result.content).toBe('hello');
  });
});
