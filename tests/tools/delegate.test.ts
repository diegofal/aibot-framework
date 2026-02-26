import { describe, test, expect, mock } from 'bun:test';
import { createDelegationTool, type DelegationHandler } from '../../src/tools/delegate';

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

function createMockHandler(overrides: Partial<DelegationHandler> = {}): DelegationHandler {
  return {
    handleDelegation: overrides.handleDelegation ?? (async () => 'delegated'),
  };
}

describe('delegate_to_bot tool', () => {
  test('has correct definition', () => {
    const tool = createDelegationTool(() => createMockHandler());
    expect(tool.definition.function.name).toBe('delegate_to_bot');
    expect(tool.definition.type).toBe('function');
  });

  test('delegates successfully with chat context', async () => {
    const delegateFn = mock(async () => 'Response from target');
    const handler = createMockHandler({ handleDelegation: delegateFn });
    const tool = createDelegationTool(() => handler);

    const result = await tool.execute({
      targetBotId: 'bot-2',
      message: 'Handle this please',
      _chatId: 12345,
      _botId: 'bot-1',
    }, logger);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Delegation successful');
    expect(delegateFn).toHaveBeenCalledWith('bot-2', 12345, 'Handle this please', 'bot-1');
  });

  test('returns helpful error when no chat context (autonomous mode)', async () => {
    const tool = createDelegationTool(() => createMockHandler());

    const result = await tool.execute({
      targetBotId: 'bot-2',
      message: 'Handle this',
      _chatId: 0,
      _botId: 'bot-1',
    }, logger);

    expect(result.success).toBe(false);
    expect(result.content).toContain('collaborate');
    expect(result.content).toContain('visible=false');
    expect(result.content).toContain('autonomous mode');
  });

  test('returns error when chatId is undefined', async () => {
    const tool = createDelegationTool(() => createMockHandler());

    const result = await tool.execute({
      targetBotId: 'bot-2',
      message: 'Handle this',
      _botId: 'bot-1',
      // _chatId not set
    }, logger);

    expect(result.success).toBe(false);
    expect(result.content).toContain('collaborate');
  });

  test('missing bot context returns error', async () => {
    const tool = createDelegationTool(() => createMockHandler());

    const result = await tool.execute({
      targetBotId: 'bot-2',
      message: 'Handle this',
      _chatId: 12345,
    }, logger);

    expect(result.success).toBe(false);
    expect(result.content).toContain('missing bot context');
  });

  test('cannot delegate to yourself', async () => {
    const tool = createDelegationTool(() => createMockHandler());

    const result = await tool.execute({
      targetBotId: 'bot-1',
      message: 'Handle this',
      _chatId: 12345,
      _botId: 'bot-1',
    }, logger);

    expect(result.success).toBe(false);
    expect(result.content).toContain('Cannot delegate to yourself');
  });

  test('requires message', async () => {
    const tool = createDelegationTool(() => createMockHandler());

    const result = await tool.execute({
      targetBotId: 'bot-2',
      _chatId: 12345,
      _botId: 'bot-1',
    }, logger);

    expect(result.success).toBe(false);
    expect(result.content).toContain('message is required');
  });

  test('handles delegation failure', async () => {
    const handler = createMockHandler({
      handleDelegation: async () => { throw new Error('Target bot unavailable'); },
    });
    const tool = createDelegationTool(() => handler);

    const result = await tool.execute({
      targetBotId: 'bot-2',
      message: 'Handle this',
      _chatId: 12345,
      _botId: 'bot-1',
    }, logger);

    expect(result.success).toBe(false);
    expect(result.content).toContain('Delegation failed');
    expect(result.content).toContain('Target bot unavailable');
  });
});
