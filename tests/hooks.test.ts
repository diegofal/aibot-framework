import { describe, expect, test, vi } from 'bun:test';
import { HookEmitter } from '../src/bot/hooks';

describe('HookEmitter', () => {
  test('emitHook dispatches to listeners', () => {
    const hooks = new HookEmitter();
    const handler = vi.fn();
    hooks.onHook('message_received', handler);

    hooks.emitHook('message_received', {
      botId: 'bot1',
      channelKind: 'telegram',
      chatId: 123,
      text: 'hello',
      timestamp: Date.now(),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].botId).toBe('bot1');
    expect(handler.mock.calls[0][0].text).toBe('hello');
    expect(handler.mock.calls[0][0].channelKind).toBe('telegram');
  });

  test('onceHook fires only once', () => {
    const hooks = new HookEmitter();
    const handler = vi.fn();
    hooks.onceHook('before_llm_call', handler);

    hooks.emitHook('before_llm_call', {
      botId: 'b',
      caller: 'conversation',
      messageCount: 5,
      timestamp: Date.now(),
    });
    hooks.emitHook('before_llm_call', {
      botId: 'b',
      caller: 'conversation',
      messageCount: 5,
      timestamp: Date.now(),
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('multiple listeners on same event', () => {
    const hooks = new HookEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    hooks.onHook('after_tool_call', h1);
    hooks.onHook('after_tool_call', h2);

    hooks.emitHook('after_tool_call', {
      botId: 'b',
      toolName: 'web_search',
      args: {},
      success: true,
      durationMs: 100,
      timestamp: Date.now(),
    });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  test('no listeners does not throw', () => {
    const hooks = new HookEmitter();
    expect(() =>
      hooks.emitHook('agent_loop_cycle', {
        botId: 'b',
        cycle: 1,
        status: 'started',
        timestamp: Date.now(),
      })
    ).not.toThrow();
  });

  test('emitHook returns true when listeners exist', () => {
    const hooks = new HookEmitter();
    hooks.onHook('message_sent', () => {});

    const result = hooks.emitHook('message_sent', {
      botId: 'b',
      channelKind: 'web',
      chatId: 1,
      text: 'hi',
      timestamp: Date.now(),
    });

    expect(result).toBe(true);
  });

  test('emitHook returns false when no listeners', () => {
    const hooks = new HookEmitter();

    const result = hooks.emitHook('before_compaction', {
      botId: 'b',
      messageCount: 10,
      estimatedTokens: 5000,
      timestamp: Date.now(),
    });

    expect(result).toBe(false);
  });

  test('max listeners is set to 50', () => {
    const hooks = new HookEmitter();
    expect(hooks.getMaxListeners()).toBe(50);
  });

  test('after_llm_call receives all fields', () => {
    const hooks = new HookEmitter();
    const handler = vi.fn();
    hooks.onHook('after_llm_call', handler);

    hooks.emitHook('after_llm_call', {
      botId: 'bot1',
      caller: 'planner',
      durationMs: 250,
      tokenCount: 1500,
      success: true,
      timestamp: 12345,
    });

    const event = handler.mock.calls[0][0];
    expect(event.caller).toBe('planner');
    expect(event.durationMs).toBe(250);
    expect(event.tokenCount).toBe(1500);
    expect(event.success).toBe(true);
  });

  test('before_tool_call receives tool args', () => {
    const hooks = new HookEmitter();
    const handler = vi.fn();
    hooks.onHook('before_tool_call', handler);

    hooks.emitHook('before_tool_call', {
      botId: 'b',
      toolName: 'file_read',
      args: { path: '/tmp/test.txt' },
      timestamp: Date.now(),
    });

    expect(handler.mock.calls[0][0].toolName).toBe('file_read');
    expect(handler.mock.calls[0][0].args.path).toBe('/tmp/test.txt');
  });
});
