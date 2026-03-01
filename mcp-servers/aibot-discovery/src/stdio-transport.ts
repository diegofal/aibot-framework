/**
 * Stdio Transport for MCP
 *
 * Reads newline-delimited JSON-RPC messages from stdin,
 * passes them to the MCP server handler, and writes
 * responses to stdout.
 *
 * Follows the MCP stdio transport specification.
 */

import type { JsonRpcRequest, JsonRpcResponse, McpServer } from './mcp-server.js';

export interface StdioTransport {
  start(): void;
  stop(): void;
}

export function createStdioTransport(server: McpServer): StdioTransport {
  let running = false;
  let buffer = '';

  function processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      };
      process.stdout.write(`${JSON.stringify(errorResponse)}\n`);
      return;
    }

    const response = server.handleRequest(request);

    // Don't send responses for notifications (id is null and it's a notification)
    if (request.id === undefined) return;

    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  function onData(chunk: Buffer): void {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      processLine(line);
    }
  }

  function onEnd(): void {
    // Process any remaining data in buffer
    if (buffer.trim()) {
      processLine(buffer);
    }
    running = false;
  }

  return {
    start(): void {
      if (running) return;
      running = true;

      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', onData);
      process.stdin.on('end', onEnd);
      process.stdin.resume();

      // Log to stderr (MCP convention — stdout is for protocol only)
      process.stderr.write(
        `[aibot-discovery] MCP server started (protocol ${server.handleRequest({ jsonrpc: '2.0', id: 0, method: 'initialize' }).result ? 'ok' : 'error'})\n`
      );
    },

    stop(): void {
      running = false;
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
    },
  };
}
