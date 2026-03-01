#!/usr/bin/env bun
/**
 * MCP Tool Bridge Server — standalone stdio JSON-RPC server.
 *
 * Spawned by Claude CLI as an MCP tool server.
 * On `tools/call`, POSTs to the main process callback server which
 * wraps the original toolExecutor (preserving bot context, karma, audit).
 *
 * Env vars:
 *   TOOL_DEFS_FILE  — path to JSON file with tool definitions
 *   CALLBACK_PORT   — port of the HTTP callback server in the main process
 */

const TOOL_DEFS_FILE = process.env.TOOL_DEFS_FILE;
const CALLBACK_PORT = process.env.CALLBACK_PORT;

if (!TOOL_DEFS_FILE || !CALLBACK_PORT) {
  process.stderr.write('Missing TOOL_DEFS_FILE or CALLBACK_PORT env vars\n');
  process.exit(1);
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Load tool definitions
let toolDefs: McpToolDef[];
try {
  const raw = await Bun.file(TOOL_DEFS_FILE).text();
  toolDefs = JSON.parse(raw);
} catch (err) {
  process.stderr.write(`Failed to load tool defs from ${TOOL_DEFS_FILE}: ${err}\n`);
  process.exit(1);
}

// JSON-RPC response helpers
function jsonrpcResponse(id: string | number | null, result: unknown) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonrpcError(id: string | number | null, code: number, message: string) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(msg: {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}): Promise<string | null> {
  const id = msg.id ?? null;

  switch (msg.method) {
    case 'initialize':
      return jsonrpcResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'aibot-tool-bridge', version: '1.0.0' },
      });

    case 'notifications/initialized':
      // No response for notifications
      return null;

    case 'tools/list':
      return jsonrpcResponse(id, { tools: toolDefs });

    case 'tools/call': {
      const params = msg.params as
        | { name: string; arguments?: Record<string, unknown> }
        | undefined;
      if (!params?.name) {
        return jsonrpcError(id, -32602, 'Missing tool name');
      }

      try {
        const resp = await fetch(`http://127.0.0.1:${CALLBACK_PORT}/call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: params.name, arguments: params.arguments ?? {} }),
          signal: AbortSignal.timeout(300_000),
        });

        const result = (await resp.json()) as { success: boolean; content: string };

        return jsonrpcResponse(id, {
          content: [{ type: 'text', text: result.content }],
          isError: !result.success,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return jsonrpcResponse(id, {
          content: [{ type: 'text', text: `Tool bridge error: ${errMsg}` }],
          isError: true,
        });
      }
    }

    default:
      return jsonrpcError(id, -32601, `Unknown method: ${msg.method}`);
  }
}

// Read stdio line by line (JSON-RPC over newline-delimited JSON)
const decoder = new TextDecoder();
let buffer = '';

const reader = Bun.stdin.stream().getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });

  // Process complete lines
  let newlineIdx: number = buffer.indexOf('\n');
  while (newlineIdx !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);

    if (!line) continue;

    try {
      const msg = JSON.parse(line);
      const response = await handleRequest(msg);
      if (response !== null) {
        process.stdout.write(`${response}\n`);
      }
    } catch (err) {
      process.stderr.write(`Failed to parse JSON-RPC message: ${line.slice(0, 200)}\n`);
    }
    newlineIdx = buffer.indexOf('\n');
  }
}
