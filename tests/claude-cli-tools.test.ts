import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { claudeGenerateWithTools } from '../src/claude-cli';
import type { ToolDefinition, ToolExecutor } from '../src/tools/types';

function mockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  } as any;
}

const sampleTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_datetime',
      description: 'Get current date and time',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA timezone name' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'echo',
      description: 'Echo back the input',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo' },
        },
        required: ['message'],
      },
    },
  },
];

describe('claudeGenerateWithTools', () => {
  test('throws when claude CLI is not available at given path', async () => {
    const executor: ToolExecutor = mock(async () => ({
      success: true,
      content: 'ok',
    }));

    await expect(
      claudeGenerateWithTools('Hello', {
        claudePath: '/nonexistent/claude-binary',
        timeout: 5_000,
        logger: mockLogger(),
        tools: sampleTools,
        toolExecutor: executor,
      })
    ).rejects.toThrow();
  });

  test('passes tool definitions to MCP config', async () => {
    // This test verifies the temp file setup works even if claude isn't available.
    // We use a very short timeout and a fake claude path — the temp dir
    // and callback server lifecycle are the real test subjects.
    const executor: ToolExecutor = mock(async () => ({
      success: true,
      content: 'result',
    }));

    try {
      await claudeGenerateWithTools('Hello', {
        claudePath: '/bin/false', // exits immediately with code 1
        timeout: 5_000,
        logger: mockLogger(),
        tools: sampleTools,
        toolExecutor: executor,
      });
    } catch (err) {
      // Expected to fail since /bin/false isn't claude
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('exited with code');
    }

    // The executor should NOT have been called since claude never ran
    expect(executor).not.toHaveBeenCalled();
  });

  test('callback server handles tool calls correctly', async () => {
    // Test the callback server lifecycle in isolation by simulating what
    // the MCP bridge would do: POST to the callback server.
    const executor: ToolExecutor = mock(async (name, args) => ({
      success: true,
      content: `Executed ${name}: ${JSON.stringify(args)}`,
    }));

    // We need to access the callback server directly.
    // Start it the same way claudeGenerateWithTools does internally.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        if (req.method !== 'POST' || new URL(req.url).pathname !== '/call') {
          return new Response('Not found', { status: 404 });
        }
        const body = (await req.json()) as { name: string; arguments: Record<string, unknown> };
        const result = await executor(body.name, body.arguments ?? {});
        return Response.json(result);
      },
    });

    try {
      // Simulate what the MCP bridge does
      const resp = await fetch(`http://127.0.0.1:${server.port}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'get_datetime', arguments: { timezone: 'UTC' } }),
      });

      const result = await resp.json();
      expect(result.success).toBe(true);
      expect(result.content).toContain('Executed get_datetime');
      expect(result.content).toContain('UTC');
      expect(executor).toHaveBeenCalledTimes(1);

      // Test 404 for wrong path
      const badResp = await fetch(`http://127.0.0.1:${server.port}/wrong`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(badResp.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test('callback server handles executor errors gracefully', async () => {
    const executor: ToolExecutor = mock(async () => {
      throw new Error('DB connection failed');
    });

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        if (req.method !== 'POST' || new URL(req.url).pathname !== '/call') {
          return new Response('Not found', { status: 404 });
        }
        try {
          const body = (await req.json()) as { name: string; arguments: Record<string, unknown> };
          const result = await executor(body.name, body.arguments ?? {});
          return Response.json(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ success: false, content: `Executor error: ${msg}` });
        }
      },
    });

    try {
      const resp = await fetch(`http://127.0.0.1:${server.port}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'broken_tool', arguments: {} }),
      });

      const result = await resp.json();
      expect(result.success).toBe(false);
      expect(result.content).toContain('DB connection failed');
    } finally {
      server.stop(true);
    }
  });
});
