import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';

const BRIDGE_PATH = resolve(import.meta.dir, '../../src/mcp/tool-bridge-server.ts');

/**
 * Spawn the bridge server with the given tool defs and callback port,
 * send JSON-RPC messages, collect responses.
 */
async function spawnBridge(
  toolDefs: unknown[],
  callbackPort: number,
  messages: unknown[]
): Promise<string[]> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  const defsPath = join(tmpDir, 'tools.json');
  await Bun.write(defsPath, JSON.stringify(toolDefs));

  const input = `${messages.map((m) => JSON.stringify(m)).join('\n')}\n`;

  const proc = Bun.spawn(['bun', 'run', BRIDGE_PATH], {
    cwd: resolve('.'),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      TOOL_DEFS_FILE: defsPath,
      CALLBACK_PORT: String(callbackPort),
    },
  });

  proc.stdin.write(input);
  proc.stdin.end();

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, 10_000);

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);

  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  return stdout.trim().split('\n').filter(Boolean);
}

const sampleTools = [
  {
    name: 'get_time',
    description: 'Get current time',
    inputSchema: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'TZ name' } },
      required: [],
    },
  },
];

describe('MCP Tool Bridge Server', () => {
  test('responds to initialize with capabilities', async () => {
    const responses = await spawnBridge(sampleTools, 0, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    ]);

    expect(responses.length).toBeGreaterThanOrEqual(1);
    const result = JSON.parse(responses[0]);
    expect(result.jsonrpc).toBe('2.0');
    expect(result.id).toBe(1);
    expect(result.result.protocolVersion).toBe('2024-11-05');
    expect(result.result.capabilities.tools).toBeDefined();
    expect(result.result.serverInfo.name).toBe('aibot-tool-bridge');
  });

  test('responds to tools/list with tool definitions', async () => {
    const responses = await spawnBridge(sampleTools, 0, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]);

    expect(responses.length).toBeGreaterThanOrEqual(1);
    const result = JSON.parse(responses[0]);
    expect(result.result.tools).toEqual(sampleTools);
  });

  test('returns error for unknown method', async () => {
    const responses = await spawnBridge(sampleTools, 0, [
      { jsonrpc: '2.0', id: 1, method: 'unknown/method', params: {} },
    ]);

    expect(responses.length).toBeGreaterThanOrEqual(1);
    const result = JSON.parse(responses[0]);
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32601);
  });

  test('does not respond to notifications/initialized', async () => {
    const responses = await spawnBridge(sampleTools, 0, [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);

    // Only the tools/list should get a response
    const parsed = responses.map((r) => JSON.parse(r));
    const ids = parsed.map((r) => r.id);
    expect(ids).toContain(2);
    expect(ids).not.toContain(undefined);
  });

  test('tools/call POSTs to callback server and returns result', async () => {
    // Start a callback server that echoes back the tool call
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const body = (await req.json()) as { name: string; arguments: Record<string, unknown> };
        return Response.json({
          success: true,
          content: `Called ${body.name} with ${JSON.stringify(body.arguments)}`,
        });
      },
    });

    try {
      const responses = await spawnBridge(sampleTools, server.port, [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_time', arguments: { timezone: 'UTC' } },
        },
      ]);

      expect(responses.length).toBeGreaterThanOrEqual(1);
      const result = JSON.parse(responses[0]);
      expect(result.id).toBe(1);
      expect(result.result.content[0].type).toBe('text');
      expect(result.result.content[0].text).toContain('Called get_time');
      expect(result.result.content[0].text).toContain('UTC');
      expect(result.result.isError).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test('tools/call returns error when callback server is unavailable', async () => {
    // Use a port that nothing is listening on
    const responses = await spawnBridge(sampleTools, 1, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_time', arguments: {} },
      },
    ]);

    expect(responses.length).toBeGreaterThanOrEqual(1);
    const result = JSON.parse(responses[0]);
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain('Tool bridge error');
  });

  test('tools/call returns error for missing tool name', async () => {
    const responses = await spawnBridge(sampleTools, 0, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {},
      },
    ]);

    expect(responses.length).toBeGreaterThanOrEqual(1);
    const result = JSON.parse(responses[0]);
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32602);
  });

  test('handles multiple messages in sequence', async () => {
    const responses = await spawnBridge(sampleTools, 0, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);

    // Should get 2 responses (initialize + tools/list), not 3 (notification has no response)
    expect(responses.length).toBe(2);
    const parsed = responses.map((r) => JSON.parse(r));
    expect(parsed[0].id).toBe(1);
    expect(parsed[1].id).toBe(2);
  });
});
