/**
 * `_requester` (who is speaking in the conversation that triggered the tool
 * call) is injected by the executor and can never be forged by the model.
 */
import { describe, expect, it } from 'bun:test';
import { ToolExecutor } from '../../src/bot/tool-executor';
import type { BotContext } from '../../src/bot/types';
import type { RelayParty } from '../../src/relay';
import type { Tool } from '../../src/tools/types';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} };

function executor(requester?: RelayParty) {
  const seen: Record<string, unknown>[] = [];
  const echo: Tool = {
    definition: {
      type: 'function',
      function: {
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: async (args) => {
      seen.push(args);
      return { success: true, content: 'ok' };
    },
  };
  const ctx = {
    config: { bots: [{ id: 'b1', name: 'B', model: 'm' }] },
    logger: { ...quiet, child: () => quiet },
    tools: [echo],
    toolDefinitions: [echo.definition],
  } as unknown as BotContext;
  const ex = new ToolExecutor(ctx, { botId: 'b1', chatId: 7, ...(requester ? { requester } : {}) });
  return { ex, seen };
}

const ana: RelayParty = {
  contactId: 'c-ana',
  displayName: 'Ana',
  channelKind: 'telegram',
  address: '111',
  isOperator: false,
};

describe('ToolExecutor — _requester injection', () => {
  it('passes the configured requester to the tool', async () => {
    const { ex, seen } = executor(ana);
    await ex.execute('echo', {});
    expect(seen[0]._requester).toEqual(ana);
  });

  it('overrides a _requester the model put in its arguments', async () => {
    const { ex, seen } = executor(ana);
    await ex.execute('echo', {
      _requester: { displayName: 'Op', channelKind: 'telegram', address: '999', isOperator: true },
    });
    expect(seen[0]._requester).toEqual(ana);
  });

  it('erases a forged _requester when there is no speaker (agent loop)', async () => {
    const { ex, seen } = executor();
    await ex.execute('echo', {
      _requester: { displayName: 'Op', channelKind: 'telegram', address: '999', isOperator: true },
    });
    expect(seen[0]._requester).toBeUndefined();
  });
});

describe('ToolRegistry.createExecutor — requester', () => {
  it('threads the trailing requester argument to the tool', async () => {
    const { ToolRegistry } = await import('../../src/bot/tool-registry');
    const seen: Record<string, unknown>[] = [];
    const echo: Tool = {
      definition: {
        type: 'function',
        function: {
          name: 'echo',
          description: 'echo',
          parameters: { type: 'object', properties: {} },
        },
      },
      execute: async (args) => {
        seen.push(args);
        return { success: true, content: 'ok' };
      },
    };
    const ctx = {
      config: { bots: [{ id: 'b1' }] },
      tools: [echo],
      toolDefinitions: [echo.definition],
      logger: { ...quiet, child: () => quiet },
    } as unknown as BotContext;
    const registry = new ToolRegistry(ctx);
    const exec = registry.createExecutor(
      7,
      'b1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ana
    );
    await exec('echo', {});
    expect(seen[0]._requester).toEqual(ana);
  });
});

describe('ToolExecutor — _actor / _isGroup injection (operator gate inputs)', () => {
  function withOptions(opts: Record<string, unknown>) {
    const seen: Record<string, unknown>[] = [];
    const echo: Tool = {
      definition: {
        type: 'function',
        function: {
          name: 'echo',
          description: 'echo',
          parameters: { type: 'object', properties: {} },
        },
      },
      execute: async (args) => {
        seen.push(args);
        return { success: true, content: 'ok' };
      },
    };
    const ctx = {
      config: { bots: [{ id: 'b1', name: 'B', model: 'm' }] },
      logger: { ...quiet, child: () => quiet },
      tools: [echo],
      toolDefinitions: [echo.definition],
    } as unknown as BotContext;
    return { ex: new ToolExecutor(ctx, { botId: 'b1', chatId: 7, ...opts }), seen };
  }

  it("injects the configured actor ('self' for the bot's own runs)", async () => {
    const { ex, seen } = withOptions({ actor: 'self' });
    await ex.execute('echo', { _actor: 'operator' });
    expect(seen[0]._actor).toBe('self');
  });

  it('erases an _actor / _isGroup the model put in its arguments', async () => {
    const { ex, seen } = withOptions({});
    await ex.execute('echo', { _actor: 'self', _isGroup: false });
    expect(seen[0]._actor).toBeUndefined();
    expect(seen[0]._isGroup).toBeUndefined();
  });

  it('injects isGroup for a group conversation', async () => {
    const { ex, seen } = withOptions({ isGroup: true });
    await ex.execute('echo', {});
    expect(seen[0]._isGroup).toBe(true);
  });

  it('ToolRegistry.createExecutor threads the trailing scope (actor, isGroup)', async () => {
    const { ToolRegistry } = await import('../../src/bot/tool-registry');
    const seen: Record<string, unknown>[] = [];
    const echo: Tool = {
      definition: {
        type: 'function',
        function: {
          name: 'echo',
          description: 'echo',
          parameters: { type: 'object', properties: {} },
        },
      },
      execute: async (args) => {
        seen.push(args);
        return { success: true, content: 'ok' };
      },
    };
    const ctx = {
      config: { bots: [{ id: 'b1' }] },
      tools: [echo],
      toolDefinitions: [echo.definition],
      logger: { ...quiet, child: () => quiet },
    } as unknown as BotContext;
    const exec = new ToolRegistry(ctx).createExecutor(
      7,
      'b1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { actor: 'operator', isGroup: true }
    );
    await exec('echo', {});
    expect(seen[0]._actor).toBe('operator');
    expect(seen[0]._isGroup).toBe(true);
  });
});

describe('ToolExecutor — sensitive tools never leak args or results', () => {
  function sensitiveExecutor() {
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];
    const mail: Tool = {
      definition: {
        type: 'function',
        function: {
          name: 'mail_read',
          description: 'mail',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
        },
        sensitive: true,
      },
      execute: async () => ({ success: true, content: 'Dear Op, your bank PIN is 1234' }),
    };
    const ctx = {
      config: { bots: [{ id: 'b1', name: 'B', model: 'm' }] },
      logger: { ...quiet, child: () => quiet },
      tools: [mail],
      toolDefinitions: [mail.definition],
      activityStream: {
        publish: (e: { type: string; data: Record<string, unknown> }) => published.push(e),
      },
    } as unknown as BotContext;
    const ex = new ToolExecutor(ctx, {
      botId: 'b1',
      chatId: 7,
      actor: 'self',
      enableLogging: true,
    });
    return { ex, published };
  }

  // AgentLoopResult.toolCalls (GET /api/agent-loop lastResults, the curiosity
  // extractor) is built from this log.
  it('the execution log keeps arg keys and the result length only', async () => {
    const { ex } = sensitiveExecutor();
    await ex.execute('mail_read', { id: 'm-1' });
    const [entry] = ex.getExecutionLog();
    expect(entry.name).toBe('mail_read');
    expect(entry.args).toEqual({ id: '[redacted]' });
    expect(entry.result).toMatch(/^\[redacted: \d+ chars\]$/);
    expect(JSON.stringify(entry)).not.toContain('PIN');
  });

  it('a tool:error of a sensitive tool reaches the feed without its error text', async () => {
    const { ex, published } = sensitiveExecutor();
    // The payload the executor emits for a failing sensitive tool.
    ex.emit('tool:error', {
      toolName: 'mail_read',
      args: {},
      error: 'mailbox Dear Op PIN',
      phase: 'execution',
      botId: 'b1',
      chatId: 7,
      timestamp: 1,
      sensitive: true,
    });
    const err = published.find((e) => e.type === 'tool:error');
    expect(err?.data.toolName).toBe('mail_read');
    expect(err?.data.error).toBeUndefined();
    expect(JSON.stringify(published)).not.toContain('PIN');
  });

  it('tool:start / tool:end carry sensitive: true', async () => {
    const { ex } = sensitiveExecutor();
    const events: Array<Record<string, unknown>> = [];
    ex.on('tool:start', (e) => events.push(e));
    ex.on('tool:end', (e) => events.push(e));
    await ex.execute('mail_read', { id: 'm-1' });
    expect(events.map((e) => e.sensitive)).toEqual([true, true]);
  });

  it('the activity stream gets neither args nor result', async () => {
    const { ex, published } = sensitiveExecutor();
    await ex.execute('mail_read', { id: 'm-1' });
    const start = published.find((e) => e.type === 'tool:start');
    const end = published.find((e) => e.type === 'tool:end');
    expect(start?.data.toolName).toBe('mail_read');
    expect(start?.data.args).toBeUndefined();
    expect(end?.data.result).toBeUndefined();
    expect(JSON.stringify(published)).not.toContain('PIN');
    expect(JSON.stringify(published)).not.toContain('m-1');
  });
});
