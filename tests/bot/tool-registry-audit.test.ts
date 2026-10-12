import { describe, expect, test } from 'bun:test';
import type { ToolAuditEntry } from '../../src/bot/tool-audit-log';
import { ToolRegistry } from '../../src/bot/tool-registry';
import type { BotContext } from '../../src/bot/types';
import type { Tool, ToolResult } from '../../src/tools/types';

const noopLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
  child: () => noopLogger,
} as any;

function tool(name: string, result: ToolResult): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    execute: async () => result,
  };
}

function setup(tools: Tool[], withAudit = true) {
  const entries: ToolAuditEntry[] = [];
  const ctx = {
    config: { bots: [{ id: 'bot-1' }] },
    tools,
    toolDefinitions: tools.map((t) => t.definition),
    logger: noopLogger,
    ...(withAudit ? { toolAuditLog: { append: (e: ToolAuditEntry) => entries.push(e) } } : {}),
  } as unknown as BotContext;
  return { registry: new ToolRegistry(ctx), entries };
}

describe('ToolRegistry.createExecutor — tool audit', () => {
  test('a conversation tool call writes exactly one audit entry with the chat id', async () => {
    const { registry, entries } = setup([tool('echo', { success: true, content: 'hello back' })]);
    const exec = registry.createExecutor(4242, 'bot-1', 'user-7');

    await exec('echo', { text: 'hello' });

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.chatId).toBe(4242);
    expect(entry.botId).toBe('bot-1');
    expect(entry.toolName).toBe('echo');
    expect(entry.success).toBe(true);
    expect(entry.result).toBe('hello back');
    expect(typeof entry.durationMs).toBe('number');
    // Model arguments only — injected context (_chatId, _botId, _userId) is not dumped.
    expect(entry.args).toEqual({ text: 'hello' });
  });

  test('failed calls are audited with their failure kind', async () => {
    const { registry, entries } = setup([
      tool('fetchy', { success: false, content: 'blocked by host', failureKind: 'blocked' }),
    ]);
    const exec = registry.createExecutor(9, 'bot-1');

    await exec('fetchy', {});

    expect(entries).toHaveLength(1);
    expect(entries[0].success).toBe(false);
    expect(entries[0].failureKind).toBe('blocked');
  });

  test('one entry per call across several calls', async () => {
    const { registry, entries } = setup([tool('echo', { success: true, content: 'ok' })]);
    const exec = registry.createExecutor(1, 'bot-1');

    await exec('echo', {});
    await exec('echo', {});

    expect(entries).toHaveLength(2);
  });

  test('no audit log wired: the call still runs', async () => {
    const { registry } = setup([tool('echo', { success: true, content: 'ok' })], false);
    const result = await registry.createExecutor(1, 'bot-1')('echo', {});
    expect(result.success).toBe(true);
  });
});
