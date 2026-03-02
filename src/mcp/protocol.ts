/**
 * MCP Transport implementations: stdio (spawn child process) and SSE (HTTP).
 *
 * Each transport implements a common interface for sending JSON-RPC messages
 * and receiving responses.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { JsonRpcMessage, JsonRpcResponse } from './types';
import { isJsonRpcResponse } from './types';

// ─── Transport Interface ───

export interface McpTransport extends EventEmitter {
  /** Send a JSON-RPC message to the remote endpoint */
  send(message: JsonRpcMessage): void;

  /** Start the transport (spawn process, open connection, etc.) */
  start(): Promise<void>;

  /** Shut down the transport gracefully */
  close(): Promise<void>;

  /** Whether the transport is currently connected */
  readonly connected: boolean;
}

// Transport emits these events:
//   'message' → (msg: JsonRpcMessage) — any incoming JSON-RPC message
//   'error' → (err: Error) — transport-level error
//   'close' → () — transport closed

// ─── Stdio Transport ───

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class McpStdioTransport extends EventEmitter implements McpTransport {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private _connected = false;

  constructor(private options: StdioTransportOptions) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  async start(): Promise<void> {
    const { command, args = [], env } = this.options;

    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    this.proc = proc;
    this._connected = true;

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      this.processBuffer();
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      // Log stderr but don't treat as fatal
      const text = chunk.toString('utf-8').trim();
      if (text) {
        this.emit('error', new Error(`MCP server stderr: ${text}`));
      }
    });

    proc.on('error', (err) => {
      this._connected = false;
      this.emit('error', err);
    });

    proc.on('close', (code) => {
      this._connected = false;
      this.emit('close', code);
    });
  }

  send(message: JsonRpcMessage): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error('Stdio transport not connected');
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    if (this.proc) {
      this._connected = false;
      this.proc.stdin?.end();
      this.proc.kill('SIGTERM');

      // Wait a bit for graceful shutdown, then force kill
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.proc?.kill('SIGKILL');
          resolve();
        }, 3000);

        this.proc!.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.proc = null;
    }
  }

  private processBuffer(): void {
    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line) {
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          this.emit('message', msg);
        } catch {
          this.emit('error', new Error(`Invalid JSON from MCP server: ${line.slice(0, 200)}`));
        }
      }

      newlineIdx = this.buffer.indexOf('\n');
    }
  }
}

// ─── SSE Transport ───

export interface SseTransportOptions {
  url: string;
  headers?: Record<string, string>;
}

export class McpSseTransport extends EventEmitter implements McpTransport {
  private _connected = false;
  private abortController: AbortController | null = null;
  private messageEndpoint: string | null = null;
  private sseBuffer = '';

  constructor(private options: SseTransportOptions) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();
    const { url, headers = {} } = this.options;

    // Connect to SSE endpoint
    const response = await fetch(url, {
      headers: {
        Accept: 'text/event-stream',
        ...headers,
      },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('SSE response has no body');
    }

    this._connected = true;

    // Read SSE stream in background
    this.readSseStream(response.body).catch((err) => {
      if (err.name !== 'AbortError') {
        this.emit('error', err);
      }
      this._connected = false;
      this.emit('close');
    });
  }

  send(message: JsonRpcMessage): void {
    if (!this._connected) {
      throw new Error('SSE transport not connected');
    }

    // For SSE transport, we POST JSON-RPC messages to the message endpoint
    const endpoint = this.messageEndpoint ?? this.options.url;

    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.options.headers ?? {}),
      },
      body: JSON.stringify(message),
    }).catch((err) => {
      this.emit('error', new Error(`Failed to send MCP message: ${err.message}`));
    });
  }

  async close(): Promise<void> {
    this._connected = false;
    this.abortController?.abort();
    this.abortController = null;
    this.messageEndpoint = null;
  }

  private async readSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.sseBuffer += decoder.decode(value, { stream: true });
        this.processSseBuffer();
      }
    } finally {
      reader.releaseLock();
      this._connected = false;
      this.emit('close');
    }
  }

  private processSseBuffer(): void {
    // SSE events are separated by double newlines
    const parts = this.sseBuffer.split('\n\n');
    // Keep the last incomplete part in the buffer
    this.sseBuffer = parts.pop() ?? '';

    for (const part of parts) {
      const lines = part.split('\n');
      let eventType = 'message';
      let data = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data += line.slice(5).trim();
        }
      }

      if (!data) continue;

      if (eventType === 'endpoint') {
        // The server tells us where to POST messages
        this.messageEndpoint = new URL(data, this.options.url).href;
      } else if (eventType === 'message') {
        try {
          const msg = JSON.parse(data) as JsonRpcMessage;
          this.emit('message', msg);
        } catch {
          this.emit('error', new Error(`Invalid SSE JSON: ${data.slice(0, 200)}`));
        }
      }
    }
  }
}

/**
 * Wait for a specific JSON-RPC response by request ID.
 * Resolves when the response arrives, rejects on timeout.
 */
export function waitForResponse(
  transport: McpTransport,
  requestId: string | number,
  timeoutMs: number
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      transport.removeListener('message', onMessage);
      reject(new Error(`MCP response timeout after ${timeoutMs}ms for request ${requestId}`));
    }, timeoutMs);

    function onMessage(msg: JsonRpcMessage) {
      if (isJsonRpcResponse(msg) && msg.id === requestId) {
        clearTimeout(timer);
        transport.removeListener('message', onMessage);
        resolve(msg);
      }
    }

    transport.on('message', onMessage);
  });
}
