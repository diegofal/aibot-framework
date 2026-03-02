/**
 * McpServer — exposes bot tools to external MCP clients.
 *
 * Supports HTTP/SSE transport (for Claude Desktop, Cursor, etc.).
 * Provides auth, rate limiting, and tool allow/deny lists.
 */

import type { Logger } from '../logger';
import type { Tool, ToolDefinition, ToolResult } from '../tools/types';
import {
  MCP_PROTOCOL_VERSION,
  type McpToolDef,
  createJsonRpcErrorResponse,
  createJsonRpcResponse,
  isJsonRpcRequest,
} from './types';

export interface McpServerConfig {
  enabled: boolean;
  port: number;
  host: string;
  exposedTools?: string[];
  hiddenTools: string[];
  authToken?: string;
  maxCallsPerMinute: number;
}

export interface McpServerDeps {
  config: McpServerConfig;
  getTools: () => Tool[];
  getDefinitions: () => ToolDefinition[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  logger: Logger;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class McpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private sseClients: Set<ReadableStreamDefaultController<Uint8Array>> = new Set();
  private rateLimits: Map<string, RateLimitEntry> = new Map();
  private _running = false;

  constructor(private deps: McpServerDeps) {}

  get running(): boolean {
    return this._running;
  }

  /** Start the HTTP/SSE MCP server */
  async start(): Promise<void> {
    if (this._running) return;

    const { config, logger } = this.deps;

    this.server = Bun.serve({
      port: config.port,
      hostname: config.host,
      fetch: async (req) => {
        const url = new URL(req.url);

        // Auth check
        if (config.authToken) {
          const authHeader = req.headers.get('Authorization');
          const token = authHeader?.replace(/^Bearer\s+/i, '');
          if (token !== config.authToken) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        // SSE endpoint — clients connect here for server-initiated messages
        if (url.pathname === '/sse' && req.method === 'GET') {
          return this.handleSse();
        }

        // JSON-RPC message endpoint — clients POST messages here
        if (url.pathname === '/message' && req.method === 'POST') {
          return this.handleJsonRpc(req);
        }

        // Health check
        if (url.pathname === '/health') {
          return Response.json({ status: 'ok', protocol: MCP_PROTOCOL_VERSION });
        }

        return new Response('Not Found', { status: 404 });
      },
    });

    this._running = true;
    logger.info({ port: config.port, host: config.host }, 'MCP server started');
  }

  /** Stop the server */
  async stop(): Promise<void> {
    if (!this._running) return;

    // Close all SSE connections
    for (const controller of this.sseClients) {
      try {
        controller.close();
      } catch {}
    }
    this.sseClients.clear();

    this.server?.stop();
    this.server = null;
    this._running = false;
    this.deps.logger.info('MCP server stopped');
  }

  private handleSse(): Response {
    const encoder = new TextEncoder();
    let controllerRef: ReadableStreamDefaultController<Uint8Array>;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllerRef = controller;
        this.sseClients.add(controller);

        // Send the endpoint event so clients know where to POST
        const port = this.deps.config.port;
        const host = this.deps.config.host;
        controller.enqueue(
          encoder.encode(`event: endpoint\ndata: http://${host}:${port}/message\n\n`)
        );
      },
      cancel: () => {
        this.sseClients.delete(controllerRef);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  private async handleJsonRpc(req: Request): Promise<Response> {
    // Rate limiting
    const clientIp = req.headers.get('x-forwarded-for') ?? 'unknown';
    if (!this.checkRateLimit(clientIp)) {
      return Response.json(createJsonRpcErrorResponse(null, -32000, 'Rate limit exceeded'), {
        status: 429,
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(createJsonRpcErrorResponse(null, -32700, 'Parse error'), {
        status: 400,
      });
    }

    if (!isJsonRpcRequest(body)) {
      return Response.json(createJsonRpcErrorResponse(null, -32600, 'Invalid Request'), {
        status: 400,
      });
    }

    const id = body.id;
    const method = body.method;

    switch (method) {
      case 'initialize':
        return Response.json(
          createJsonRpcResponse(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'aibot-mcp-server', version: '1.0.0' },
          })
        );

      case 'notifications/initialized':
        return new Response(null, { status: 204 });

      case 'tools/list': {
        const tools = this.getFilteredToolDefs();
        return Response.json(createJsonRpcResponse(id, { tools }));
      }

      case 'tools/call': {
        const params = body.params as
          | { name: string; arguments?: Record<string, unknown> }
          | undefined;

        if (!params?.name) {
          return Response.json(createJsonRpcErrorResponse(id, -32602, 'Missing tool name'));
        }

        // Verify the tool is exposed
        const allowedNames = new Set(this.getFilteredToolDefs().map((t) => t.name));
        if (!allowedNames.has(params.name)) {
          return Response.json(
            createJsonRpcErrorResponse(id, -32602, `Tool not available: ${params.name}`)
          );
        }

        try {
          const result = await this.deps.executeTool(params.name, params.arguments ?? {});
          return Response.json(
            createJsonRpcResponse(id, {
              content: [{ type: 'text', text: result.content }],
              isError: !result.success,
            })
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json(
            createJsonRpcResponse(id, {
              content: [{ type: 'text', text: `Tool error: ${msg}` }],
              isError: true,
            })
          );
        }
      }

      default:
        return Response.json(createJsonRpcErrorResponse(id, -32601, `Unknown method: ${method}`));
    }
  }

  /** Get tool definitions filtered by expose/hidden config */
  private getFilteredToolDefs(): McpToolDef[] {
    const { config } = this.deps;
    const defs = this.deps.getDefinitions();
    const hidden = new Set(config.hiddenTools);

    return defs
      .filter((d) => {
        const name = d.function.name;
        if (hidden.has(name)) return false;
        if (config.exposedTools?.length) {
          return config.exposedTools.includes(name);
        }
        return true;
      })
      .map((d) => ({
        name: d.function.name,
        description: d.function.description,
        inputSchema: {
          type: 'object' as const,
          properties: d.function.parameters.properties,
          required: d.function.parameters.required,
        },
      }));
  }

  private checkRateLimit(clientId: string): boolean {
    const { maxCallsPerMinute } = this.deps.config;
    const now = Date.now();
    const entry = this.rateLimits.get(clientId);

    if (!entry || now - entry.windowStart > 60_000) {
      this.rateLimits.set(clientId, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= maxCallsPerMinute) {
      return false;
    }

    entry.count++;
    return true;
  }
}
