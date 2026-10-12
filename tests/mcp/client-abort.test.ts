import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { LLMAbortedError } from '../../src/core/abort';
import { McpClient } from '../../src/mcp/client';
import { McpClientPool } from '../../src/mcp/client-pool';
import type { McpTransport } from '../../src/mcp/protocol';
import { adaptMcpTool } from '../../src/mcp/tool-adapter';

const logger: any = { info: mock(), warn: mock(), error: mock(), debug: mock() };
logger.child = () => logger;

/** A connected transport that never answers tools/call. */
class SilentTransport extends EventEmitter implements McpTransport {
  sent: Array<{ method?: string; id?: unknown; params?: any }> = [];
  get connected() {
    return true;
  }
  async start() {}
  send(message: unknown) {
    this.sent.push(message as any);
  }
  async close() {}
}

function connectedClient() {
  const client = new McpClient(
    { name: 'srv', transport: 'stdio', command: 'x', timeout: 60_000, autoReconnect: false },
    logger
  );
  const transport = new SilentTransport();
  (client as any).transport = transport;
  return { client, transport };
}

describe('MCP callTool cancellation', () => {
  test('abort stops waiting, sends notifications/cancelled, rejects with LLMAbortedError', async () => {
    const { client, transport } = connectedClient();
    const ac = new AbortController();
    const pending = client.callTool('t', {}, { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(LLMAbortedError);
    const call = transport.sent.find((m) => m.method === 'tools/call');
    const cancel = transport.sent.find((m) => m.method === 'notifications/cancelled');
    expect(cancel?.params?.requestId).toBe(call?.id);
    expect(transport.listenerCount('message')).toBe(0);
  });

  test('the adapter turns an abort into a stopped result and passes the signal through', async () => {
    const pool = new McpClientPool(logger);
    const ac = new AbortController();
    const callTool = mock(
      (_s: string, _t: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
        expect(args._signal).toBeUndefined();
        expect(opts?.signal).toBe(ac.signal);
        return Promise.reject(new LLMAbortedError());
      }
    );
    (pool as any).callTool = callTool;
    const tool = adaptMcpTool(
      'srv',
      'srv',
      { name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } },
      pool,
      logger
    );
    const res = await tool.execute({ _signal: ac.signal, x: 1 }, logger);
    expect(res.success).toBe(false);
    expect(res.content).toContain('Stopped');
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
