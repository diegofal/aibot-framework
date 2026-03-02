/**
 * Shared MCP protocol types — used by both client and server modules.
 * Protocol version: 2024-11-05
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05';

// ─── JSON-RPC 2.0 Base ───

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ─── MCP Tool Types ───

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolCallResult {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
}

// ─── MCP Capabilities ───

export interface McpServerCapabilities {
  tools?: Record<string, never>;
  resources?: Record<string, never>;
  prompts?: Record<string, never>;
}

export interface McpClientCapabilities {
  roots?: Record<string, never>;
  sampling?: Record<string, never>;
}

// ─── MCP Handshake ───

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
}

// ─── JSON-RPC Helpers ───

let _nextId = 1;

export function createJsonRpcRequest(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id: _nextId++, method, params };
}

export function createJsonRpcNotification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

export function createJsonRpcResponse(
  id: string | number | null,
  result: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function createJsonRpcErrorResponse(
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'jsonrpc' in msg &&
    (msg as JsonRpcResponse).jsonrpc === '2.0' &&
    ('result' in msg || 'error' in msg)
  );
}

export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'jsonrpc' in msg &&
    'method' in msg &&
    'id' in msg &&
    (msg as JsonRpcResponse).jsonrpc === '2.0'
  );
}

/** Reset ID counter (for tests) */
export function _resetIdCounter(): void {
  _nextId = 1;
}
