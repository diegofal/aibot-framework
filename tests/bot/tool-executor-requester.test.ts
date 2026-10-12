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
