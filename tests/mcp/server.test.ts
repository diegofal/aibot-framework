import { afterEach, describe, expect, it, mock } from 'bun:test';
import { McpServer, type McpServerConfig, type McpServerDeps } from '../../src/mcp/server';
import { MCP_PROTOCOL_VERSION } from '../../src/mcp/types';
import type { Tool, ToolDefinition } from '../../src/tools/types';

const mockLogger: any = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: () => mockLogger,
};

const sampleDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exec',
      description: 'Execute a command',
      parameters: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_datetime',
      description: 'Get current date/time',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function makeDeps(overrides: Partial<McpServerDeps> = {}): McpServerDeps {
  return {
    config: {
      enabled: true,
      port: 0, // random port
      host: '127.0.0.1',
      hiddenTools: ['exec'],
      maxCallsPerMinute: 60,
    },
    getTools: () => [],
    getDefinitions: () => sampleDefinitions,
    executeTool: async (name, args) => ({ success: true, content: `Executed ${name}` }),
    logger: mockLogger,
    ...overrides,
  };
}

describe('McpServer', () => {
  let server: McpServer;
  let port: number;

  afterEach(async () => {
    if (server?.running) {
      await server.stop();
    }
  });

  async function startAndGetPort(deps?: Partial<McpServerDeps>): Promise<number> {
    // Use a random available port
    const testPort = 30000 + Math.floor(Math.random() * 10000);
    const finalDeps = makeDeps({
      ...deps,
      config: { ...makeDeps(deps).config, port: testPort },
    });
    server = new McpServer(finalDeps);
    await server.start();
    port = testPort;
    return testPort;
  }

  it('should start and stop', async () => {
    const p = await startAndGetPort();
    expect(server.running).toBe(true);

    await server.stop();
    expect(server.running).toBe(false);
  });

  it('should respond to health check', async () => {
    const p = await startAndGetPort();
    const resp = await fetch(`http://127.0.0.1:${p}/health`);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.status).toBe('ok');
    expect(body.protocol).toBe(MCP_PROTOCOL_VERSION);
  });

  it('should handle initialize', async () => {
    const p = await startAndGetPort();
    const resp = await fetch(`http://127.0.0.1:${p}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    });

    const body = await resp.json();
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(body.result.serverInfo.name).toBe('aibot-mcp-server');
  });

  it('should list tools, excluding hidden ones', async () => {
    const p = await startAndGetPort();
    const resp = await fetch(`http://127.0.0.1:${p}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

    const body = await resp.json();
    const toolNames = body.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('web_search');
    expect(toolNames).toContain('get_datetime');
    expect(toolNames).not.toContain('exec'); // hidden
  });

  it('should execute a tool call', async () => {
    const p = await startAndGetPort();
    const resp = await fetch(`http://127.0.0.1:${p}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'web_search', arguments: { query: 'test' } },
      }),
    });

    const body = await resp.json();
    expect(body.result.content[0].text).toBe('Executed web_search');
    expect(body.result.isError).toBe(false);
  });

  it('should reject calls to hidden tools', async () => {
    const p = await startAndGetPort();
    const resp = await fetch(`http://127.0.0.1:${p}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'exec', arguments: { cmd: 'rm -rf /' } },
      }),
    });

    const body = await resp.json();
    expect(body.error.message).toContain('not available');
  });

  it('should enforce auth token when configured', async () => {
    const p = await startAndGetPort({
      config: {
        enabled: true,
        port: 0,
        host: '127.0.0.1',
        hiddenTools: [],
        maxCallsPerMinute: 60,
        authToken: 'secret-token',
      },
    });

    // Without token
    const resp1 = await fetch(`http://127.0.0.1:${p}/health`);
    expect(resp1.status).toBe(401);

    // With wrong token
    const resp2 = await fetch(`http://127.0.0.1:${p}/health`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(resp2.status).toBe(401);

    // With correct token
    const resp3 = await fetch(`http://127.0.0.1:${p}/health`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(resp3.status).toBe(200);
  });

  it('should reject invalid JSON-RPC', async () => {
    const p = await startAndGetPort();
    const resp = await fetch(`http://127.0.0.1:${p}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(resp.status).toBe(400);
  });

  it('should return 404 for unknown paths', async () => {
    const p = await startAndGetPort();
    const resp = await fetch(`http://127.0.0.1:${p}/unknown`);
    expect(resp.status).toBe(404);
  });

  it('should reject unknown methods', async () => {
    const p = await startAndGetPort();
    const resp = await fetch(`http://127.0.0.1:${p}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'unknown/method' }),
    });

    const body = await resp.json();
    expect(body.error.code).toBe(-32601);
  });

  describe('exposedTools allowlist', () => {
    it('should only expose listed tools', async () => {
      const p = await startAndGetPort({
        config: {
          enabled: true,
          port: 0,
          host: '127.0.0.1',
          hiddenTools: [],
          exposedTools: ['get_datetime'],
          maxCallsPerMinute: 60,
        },
      });

      const resp = await fetch(`http://127.0.0.1:${p}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
      });

      const body = await resp.json();
      const toolNames = body.result.tools.map((t: any) => t.name);
      expect(toolNames).toEqual(['get_datetime']);
    });
  });
});
