import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { McpClient, type McpServerConfig } from '../../src/mcp/client';
import type { McpTransport } from '../../src/mcp/protocol';
import { MCP_PROTOCOL_VERSION, _resetIdCounter } from '../../src/mcp/types';

// Mock transport that captures sent messages and emits responses
class MockTransport extends EventEmitter implements McpTransport {
  public sentMessages: unknown[] = [];
  private _connected = false;
  public autoRespond = true;

  get connected(): boolean {
    return this._connected;
  }

  async start(): Promise<void> {
    this._connected = true;
  }

  send(message: unknown): void {
    this.sentMessages.push(message);

    if (!this.autoRespond) return;

    // Auto-respond to known methods
    const msg = message as { id: number; method: string };

    if (msg.method === 'initialize') {
      setTimeout(() => {
        this.emit('message', {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'test-server', version: '1.0.0' },
          },
        });
      }, 0);
    }

    if (msg.method === 'tools/list') {
      setTimeout(() => {
        this.emit('message', {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'test_tool',
                description: 'A test tool',
                inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
              },
              {
                name: 'hidden_tool',
                description: 'Should be filtered',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        });
      }, 0);
    }

    if (msg.method === 'tools/call') {
      setTimeout(() => {
        this.emit('message', {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: 'tool result' }],
            isError: false,
          },
        });
      }, 0);
    }
  }

  async close(): Promise<void> {
    this._connected = false;
  }
}

const mockLogger: any = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: () => mockLogger,
};

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: 'test',
    transport: 'stdio',
    command: 'echo',
    timeout: 5000,
    autoReconnect: false,
    ...overrides,
  };
}

describe('McpClient', () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it('should start in disconnected status', () => {
    const client = new McpClient(makeConfig(), mockLogger);
    expect(client.status).toBe('disconnected');
    expect(client.tools).toEqual([]);
    expect(client.serverInfo).toBeNull();
  });

  it('should use toolPrefix or server name as prefix', () => {
    const client1 = new McpClient(makeConfig({ name: 'github' }), mockLogger);
    expect(client1.prefix).toBe('github');

    const client2 = new McpClient(makeConfig({ name: 'gh', toolPrefix: 'github' }), mockLogger);
    expect(client2.prefix).toBe('github');
  });

  describe('connect with mock transport', () => {
    it('should complete handshake and discover tools', async () => {
      const client = new McpClient(makeConfig(), mockLogger);
      const transport = new MockTransport();

      // Override createTransport via prototype patching
      (client as any).createTransport = () => transport;

      await client.connect();

      expect(client.status).toBe('connected');
      expect(client.serverInfo).toEqual({ name: 'test-server', version: '1.0.0' });
      expect(client.tools.length).toBe(2);
      expect(client.tools[0].name).toBe('test_tool');
    });

    it('should apply allowedTools filter', async () => {
      const client = new McpClient(makeConfig({ allowedTools: ['test_tool'] }), mockLogger);
      const transport = new MockTransport();
      (client as any).createTransport = () => transport;

      await client.connect();

      expect(client.tools.length).toBe(1);
      expect(client.tools[0].name).toBe('test_tool');
    });

    it('should apply deniedTools filter', async () => {
      const client = new McpClient(makeConfig({ deniedTools: ['hidden_tool'] }), mockLogger);
      const transport = new MockTransport();
      (client as any).createTransport = () => transport;

      await client.connect();

      expect(client.tools.length).toBe(1);
      expect(client.tools[0].name).toBe('test_tool');
    });

    it('should call tools on the remote server', async () => {
      const client = new McpClient(makeConfig(), mockLogger);
      const transport = new MockTransport();
      (client as any).createTransport = () => transport;

      await client.connect();

      const result = await client.callTool('test_tool', { x: 42 });
      expect(result.isError).toBe(false);
      expect(result.content[0]).toEqual({ type: 'text', text: 'tool result' });
    });

    it('should disconnect cleanly', async () => {
      const client = new McpClient(makeConfig(), mockLogger);
      const transport = new MockTransport();
      (client as any).createTransport = () => transport;

      await client.connect();
      expect(client.status).toBe('connected');

      await client.disconnect();
      expect(client.status).toBe('disconnected');
      expect(client.tools).toEqual([]);
      expect(client.serverInfo).toBeNull();
    });
  });

  it('should throw when callTool is called while disconnected', async () => {
    const client = new McpClient(makeConfig(), mockLogger);
    expect(() => client.callTool('foo', {})).toThrow('not connected');
  });

  it('should throw for stdio transport without command', () => {
    const client = new McpClient(
      makeConfig({ transport: 'stdio', command: undefined }),
      mockLogger
    );
    expect(() => (client as any).createTransport()).toThrow("requires 'command'");
  });

  it('should throw for sse transport without url', () => {
    const client = new McpClient(makeConfig({ transport: 'sse', url: undefined }), mockLogger);
    expect(() => (client as any).createTransport()).toThrow("requires 'url'");
  });

  describe('circuit breaker', () => {
    it('should disable the server after MAX_RECONNECT_ATTEMPTS with the same error', async () => {
      // Force createTransport to throw a stable error message on every call,
      // simulating a missing executable (ENOENT).
      const stableError = 'Executable not found in $PATH: "npx"';
      const client = new McpClient(
        makeConfig({ autoReconnect: false, name: 'broken' }),
        mockLogger
      );
      (client as any).createTransport = () => {
        throw new Error(stableError);
      };

      // autoReconnect is off so connect() rejects without scheduling. We
      // drive the reconnect cycle manually to keep the test deterministic.
      await expect(client.connect()).rejects.toThrow(stableError);
      expect(client.status).toBe('error');

      // Stub setTimeout so scheduleReconnect does not arm a real timer.
      const origSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (() => undefined) as unknown as typeof setTimeout;
      try {
        // The first call seeds lastErrorMessage; subsequent calls with the
        // same error trip the breaker once reconnectAttempts reaches the cap.
        const MAX = (McpClient as any).MAX_RECONNECT_ATTEMPTS;
        for (let i = 0; i < MAX; i++) {
          (client as any).scheduleReconnect(stableError);
        }

        // The next call with the same error must trip the circuit breaker.
        (client as any).scheduleReconnect(stableError);
      } finally {
        globalThis.setTimeout = origSetTimeout;
      }

      expect(client.status).toBe('disabled');

      // A disabled client must not expose any tools.
      expect(client.tools).toEqual([]);

      await client.disconnect();
    });

    it('should not disable when errors differ', async () => {
      const client = new McpClient(
        makeConfig({ autoReconnect: false, name: 'flaky' }),
        mockLogger
      );
      (client as any).createTransport = () => {
        throw new Error('first error');
      };

      // autoReconnect is off so connect() rejects without scheduling.
      await expect(client.connect()).rejects.toThrow('first error');

      // Stub setTimeout so scheduleReconnect does not arm a real timer.
      const origSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (() => undefined) as unknown as typeof setTimeout;
      try {
        // Feed a different error each time — the circuit breaker must NOT trip.
        const MAX = (McpClient as any).MAX_RECONNECT_ATTEMPTS;
        for (let i = 0; i < MAX + 2; i++) {
          (client as any).scheduleReconnect(`different-error-${i}`);
        }
      } finally {
        globalThis.setTimeout = origSetTimeout;
      }

      expect(client.status).not.toBe('disabled');

      await client.disconnect();
    });

    it('should reset lastErrorMessage on successful connect', async () => {
      const client = new McpClient(makeConfig({ autoReconnect: false }), mockLogger);
      const transport = new MockTransport();

      let callCount = 0;
      (client as any).createTransport = () => {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return transport;
      };

      // First attempt fails. autoReconnect is off so no timer is scheduled,
      // but the error message is still captured by connect()'s catch block.
      await expect(client.connect()).rejects.toThrow('transient');

      // Simulate a prior failed reconnect cycle having set lastErrorMessage.
      (client as any).lastErrorMessage = 'transient';
      (client as any).reconnectAttempts = 3;

      // Second attempt succeeds and must clear the circuit-breaker state.
      await client.connect();
      expect(client.status).toBe('connected');
      expect((client as any).lastErrorMessage).toBeNull();
      expect((client as any).reconnectAttempts).toBe(0);

      await client.disconnect();
    });
  });
});
