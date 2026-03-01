import { describe, expect, mock, test } from 'bun:test';
import { type CollaborateHandler, createCollaborateTool } from '../../src/tools/collaborate';

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

function createMockHandler(overrides: Partial<CollaborateHandler> = {}): CollaborateHandler {
  return {
    discoverAgents: overrides.discoverAgents ?? (() => []),
    collaborationStep:
      overrides.collaborationStep ?? (async () => ({ sessionId: 'sess-1', response: 'ok' })),
    endSession: overrides.endSession ?? (() => {}),
    sendVisibleMessage: overrides.sendVisibleMessage ?? (async () => {}),
  };
}

describe('collaborate tool', () => {
  test('has correct definition', () => {
    const tool = createCollaborateTool(() => createMockHandler());
    expect(tool.definition.function.name).toBe('collaborate');
    expect(tool.definition.type).toBe('function');
  });

  test('discover returns available agents', async () => {
    const handler = createMockHandler({
      discoverAgents: () =>
        [
          {
            botId: 'bot-2',
            name: 'Helper',
            telegramUsername: 'helper_bot',
            skills: ['search'],
            description: 'A helper',
          },
        ] as any,
    });
    const tool = createCollaborateTool(() => handler);
    const result = await tool.execute({ action: 'discover', _botId: 'bot-1' }, logger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('bot-2');
    expect(result.content).toContain('Helper');
  });

  test('discover with no agents', async () => {
    const tool = createCollaborateTool(() => createMockHandler());
    const result = await tool.execute({ action: 'discover', _botId: 'bot-1' }, logger);
    expect(result.success).toBe(true);
    expect(result.content).toContain('No other agents available');
  });

  test('send invisible collaboration works without chat context', async () => {
    const stepFn = mock(async () => ({ sessionId: 'sess-1', response: 'Hello from bot-2' }));
    const handler = createMockHandler({ collaborationStep: stepFn });
    const tool = createCollaborateTool(() => handler);

    const result = await tool.execute(
      {
        action: 'send',
        targetBotId: 'bot-2',
        message: 'Hi there',
        _botId: 'bot-1',
        _chatId: 0, // no chat context (agent loop)
      },
      logger
    );

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.response).toBe('Hello from bot-2');
    expect(stepFn).toHaveBeenCalledWith(undefined, 'bot-2', 'Hi there', 'bot-1');
  });

  test('send visible collaboration works with chat context', async () => {
    const visibleFn = mock(async () => {});
    const handler = createMockHandler({ sendVisibleMessage: visibleFn });
    const tool = createCollaborateTool(() => handler);

    const result = await tool.execute(
      {
        action: 'send',
        targetBotId: 'bot-2',
        message: 'Hi group',
        visible: true,
        _botId: 'bot-1',
        _chatId: 12345,
      },
      logger
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('visibly');
    expect(visibleFn).toHaveBeenCalledWith(12345, 'bot-1', 'bot-2', 'Hi group');
  });

  test('visible collaboration falls back to invisible when no chat context', async () => {
    const stepFn = mock(async () => ({ sessionId: 'sess-2', response: 'Invisible reply' }));
    const visibleFn = mock(async () => {});
    const handler = createMockHandler({
      collaborationStep: stepFn,
      sendVisibleMessage: visibleFn,
    });
    const tool = createCollaborateTool(() => handler);

    const result = await tool.execute(
      {
        action: 'send',
        targetBotId: 'bot-2',
        message: 'Hi from agent loop',
        visible: true,
        _botId: 'bot-1',
        _chatId: 0, // no chat context
      },
      logger
    );

    expect(result.success).toBe(true);
    // Should NOT have called sendVisibleMessage
    expect(visibleFn).not.toHaveBeenCalled();
    // Should have fallen back to invisible collaboration
    expect(stepFn).toHaveBeenCalledWith(undefined, 'bot-2', 'Hi from agent loop', 'bot-1');
    const parsed = JSON.parse(result.content);
    expect(parsed.response).toBe('Invisible reply');
  });

  test('visible collaboration falls back when chatId is undefined', async () => {
    const stepFn = mock(async () => ({ sessionId: 'sess-3', response: 'Fallback reply' }));
    const handler = createMockHandler({ collaborationStep: stepFn });
    const tool = createCollaborateTool(() => handler);

    const result = await tool.execute(
      {
        action: 'send',
        targetBotId: 'bot-2',
        message: 'Hello',
        visible: true,
        _botId: 'bot-1',
        // _chatId not set at all
      },
      logger
    );

    expect(result.success).toBe(true);
    expect(stepFn).toHaveBeenCalled();
  });

  test('send requires targetBotId', async () => {
    const tool = createCollaborateTool(() => createMockHandler());
    const result = await tool.execute({ action: 'send', message: 'hi', _botId: 'bot-1' }, logger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('targetBotId is required');
  });

  test('send requires message', async () => {
    const tool = createCollaborateTool(() => createMockHandler());
    const result = await tool.execute(
      { action: 'send', targetBotId: 'bot-2', _botId: 'bot-1' },
      logger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('message is required');
  });

  test('cannot collaborate with yourself', async () => {
    const tool = createCollaborateTool(() => createMockHandler());
    const result = await tool.execute(
      {
        action: 'send',
        targetBotId: 'bot-1',
        message: 'hi me',
        _botId: 'bot-1',
      },
      logger
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain('Cannot collaborate with yourself');
  });

  test('missing bot context returns error', async () => {
    const tool = createCollaborateTool(() => createMockHandler());
    const result = await tool.execute({ action: 'discover' }, logger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('missing bot context');
  });

  test('end_session closes session', async () => {
    const endFn = mock(() => {});
    const handler = createMockHandler({ endSession: endFn });
    const tool = createCollaborateTool(() => handler);

    const result = await tool.execute(
      {
        action: 'end_session',
        sessionId: 'sess-1',
        _botId: 'bot-1',
      },
      logger
    );

    expect(result.success).toBe(true);
    expect(endFn).toHaveBeenCalledWith('sess-1');
  });

  test('end_session requires sessionId', async () => {
    const tool = createCollaborateTool(() => createMockHandler());
    const result = await tool.execute({ action: 'end_session', _botId: 'bot-1' }, logger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('sessionId is required');
  });

  test('unknown action returns error', async () => {
    const tool = createCollaborateTool(() => createMockHandler());
    const result = await tool.execute({ action: 'invalid', _botId: 'bot-1' }, logger);
    expect(result.success).toBe(false);
    expect(result.content).toContain('Unknown action');
  });

  test('multi-turn with sessionId', async () => {
    const stepFn = mock(async () => ({ sessionId: 'sess-1', response: 'Turn 2 reply' }));
    const handler = createMockHandler({ collaborationStep: stepFn });
    const tool = createCollaborateTool(() => handler);

    const result = await tool.execute(
      {
        action: 'send',
        targetBotId: 'bot-2',
        message: 'Follow-up',
        sessionId: 'sess-1',
        _botId: 'bot-1',
      },
      logger
    );

    expect(result.success).toBe(true);
    expect(stepFn).toHaveBeenCalledWith('sess-1', 'bot-2', 'Follow-up', 'bot-1');
  });
});
