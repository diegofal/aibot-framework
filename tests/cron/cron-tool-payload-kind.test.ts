import { describe, expect, it, mock } from 'bun:test';
import { createCronTool } from '../../src/tools/cron';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

function makeCronService() {
  const addMock = mock(async (input: any) => ({
    id: 'job-1',
    name: input.name,
    schedule: input.schedule,
    state: { nextRunAtMs: Date.now() + 60000, consecutiveErrors: 0 },
    payload: input.payload,
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  }));

  return {
    add: addMock,
    remove: mock(async () => ({ ok: true, removed: true })),
    list: mock(async () => []),
    run: mock(async () => ({ ran: true })),
    status: mock(async () => ({ enabled: true })),
    _addMock: addMock,
  };
}

describe('cron tool payloadKind', () => {
  it('defaults to instruction when payloadKind not specified', async () => {
    const svc = makeCronService();
    const tool = createCronTool(svc as any);

    await tool.execute(
      {
        action: 'add',
        name: 'News briefing',
        schedule: { kind: 'cron', expr: '0 22 * * *', tz: 'America/Buenos_Aires' },
        text: 'Generate a news briefing',
        _chatId: 123,
        _botId: 'bot1',
      },
      mockLogger
    );

    expect(svc._addMock).toHaveBeenCalledTimes(1);
    const addArgs = svc._addMock.mock.calls[0][0];
    expect(addArgs.payload.kind).toBe('instruction');
    expect(addArgs.payload.text).toBe('Generate a news briefing');
  });

  it('uses message kind when explicitly specified', async () => {
    const svc = makeCronService();
    const tool = createCronTool(svc as any);

    await tool.execute(
      {
        action: 'add',
        name: 'Water reminder',
        schedule: { kind: 'every', everyMs: 3600000 },
        text: 'Drink water!',
        payloadKind: 'message',
        _chatId: 123,
        _botId: 'bot1',
      },
      mockLogger
    );

    expect(svc._addMock).toHaveBeenCalledTimes(1);
    const addArgs = svc._addMock.mock.calls[0][0];
    expect(addArgs.payload.kind).toBe('message');
    expect(addArgs.payload.text).toBe('Drink water!');
  });

  it('uses instruction kind when explicitly specified', async () => {
    const svc = makeCronService();
    const tool = createCronTool(svc as any);

    await tool.execute(
      {
        action: 'add',
        name: 'Daily report',
        schedule: { kind: 'at', at: '2026-04-01T10:00:00Z' },
        text: 'Generate daily report',
        payloadKind: 'instruction',
        _chatId: 456,
        _botId: 'bot2',
      },
      mockLogger
    );

    expect(svc._addMock).toHaveBeenCalledTimes(1);
    const addArgs = svc._addMock.mock.calls[0][0];
    expect(addArgs.payload.kind).toBe('instruction');
  });

  it('accepts explicit chatId from agent loop (no _chatId context)', async () => {
    const svc = makeCronService();
    const tool = createCronTool(svc as any);

    const result = await tool.execute(
      {
        action: 'add',
        name: 'Agent loop briefing',
        schedule: { kind: 'cron', expr: '0 6 * * *', tz: 'America/Argentina/Buenos_Aires' },
        text: 'Generate morning briefing',
        chatId: 796164002,
        _chatId: 0, // agent loop injects 0
        _botId: 'news',
      },
      mockLogger
    );

    expect(result.success).toBe(true);
    expect(svc._addMock).toHaveBeenCalledTimes(1);
    const addArgs = svc._addMock.mock.calls[0][0];
    expect(addArgs.payload.chatId).toBe(796164002);
    expect(addArgs.payload.kind).toBe('instruction');
  });

  it('fails when no chatId available at all', async () => {
    const svc = makeCronService();
    const tool = createCronTool(svc as any);

    const result = await tool.execute(
      {
        action: 'add',
        name: 'No context job',
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        text: 'Do something',
        _chatId: 0,
        _botId: 'bot1',
      },
      mockLogger
    );

    expect(result.success).toBe(false);
    expect(result.content).toContain('chatId');
    expect(svc._addMock).not.toHaveBeenCalled();
  });
});
