/**
 * McpClient — connects to a single MCP server, performs handshake,
 * discovers tools, and executes tool calls.
 */

import type { Logger } from '../logger';
import type { McpTransport } from './protocol';
import { McpSseTransport, McpStdioTransport, waitForResponse } from './protocol';
import {
  MCP_PROTOCOL_VERSION,
  type McpInitializeResult,
  type McpToolCallResult,
  type McpToolDef,
  createJsonRpcNotification,
  createJsonRpcRequest,
} from './types';

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeout: number;
  autoReconnect: boolean;
  toolPrefix?: string;
  allowedTools?: string[];
  deniedTools?: string[];
}

export type McpClientStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export class McpClient {
  private transport: McpTransport | null = null;
  private _status: McpClientStatus = 'disconnected';
  private _tools: McpToolDef[] = [];
  private _serverInfo: McpInitializeResult['serverInfo'] | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_DELAY = 60_000;

  constructor(
    readonly serverConfig: McpServerConfig,
    private logger: Logger
  ) {}

  get status(): McpClientStatus {
    return this._status;
  }

  get tools(): McpToolDef[] {
    return this._tools;
  }

  get serverInfo(): McpInitializeResult['serverInfo'] | null {
    return this._serverInfo;
  }

  get prefix(): string {
    return this.serverConfig.toolPrefix ?? this.serverConfig.name;
  }

  /** Connect to the server, perform handshake, discover tools */
  async connect(): Promise<void> {
    if (this._status === 'connected') return;

    this._status = 'connecting';
    this.clearReconnectTimer();

    try {
      // Create transport
      this.transport = this.createTransport();

      // Wire transport events
      this.transport.on('error', (err: Error) => {
        this.logger.warn(
          { server: this.serverConfig.name, err: err.message },
          'MCP transport error'
        );
      });

      this.transport.on('close', () => {
        const wasConnected = this._status === 'connected';
        this._status = 'disconnected';
        this.logger.info({ server: this.serverConfig.name }, 'MCP server disconnected');

        if (wasConnected && this.serverConfig.autoReconnect) {
          this.scheduleReconnect();
        }
      });

      await this.transport.start();

      const handshakeStart = Date.now();
      this.logger.debug(
        { server: this.serverConfig.name, timeout: this.serverConfig.timeout },
        'MCP handshake starting'
      );

      // MCP handshake: initialize
      const initReq = createJsonRpcRequest('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'aibot-framework', version: '1.0.0' },
      });

      this.transport.send(initReq);

      const initResp = await waitForResponse(this.transport, initReq.id, this.serverConfig.timeout);

      if (initResp.error) {
        throw new Error(`Initialize failed: ${initResp.error.message}`);
      }

      const initResult = initResp.result as McpInitializeResult;
      this._serverInfo = initResult.serverInfo;

      // Send initialized notification
      this.transport.send(createJsonRpcNotification('notifications/initialized'));

      // Discover tools
      await this.refreshTools();

      this._status = 'connected';
      this.reconnectAttempts = 0;
      this.logger.info(
        {
          server: this.serverConfig.name,
          serverInfo: this._serverInfo,
          toolCount: this._tools.length,
          handshakeMs: Date.now() - handshakeStart,
        },
        'MCP client connected'
      );
    } catch (err) {
      this._status = 'error';
      this.logger.error({ server: this.serverConfig.name, err }, 'Failed to connect to MCP server');

      // Clean up failed transport
      await this.transport?.close().catch(() => {});
      this.transport = null;

      if (this.serverConfig.autoReconnect) {
        this.scheduleReconnect();
      }

      throw err;
    }
  }

  /** Refresh the list of available tools from the server */
  async refreshTools(): Promise<McpToolDef[]> {
    if (!this.transport?.connected) {
      throw new Error('Not connected');
    }

    const listReq = createJsonRpcRequest('tools/list');
    this.transport.send(listReq);

    const listResp = await waitForResponse(this.transport, listReq.id, this.serverConfig.timeout);

    if (listResp.error) {
      throw new Error(`tools/list failed: ${listResp.error.message}`);
    }

    const allTools = (listResp.result as { tools: McpToolDef[] }).tools ?? [];

    // Apply allow/deny filters
    const hasFilters = !!(
      this.serverConfig.allowedTools?.length || this.serverConfig.deniedTools?.length
    );
    this._tools = allTools.filter((t) => {
      if (this.serverConfig.allowedTools?.length) {
        return this.serverConfig.allowedTools.includes(t.name);
      }
      if (this.serverConfig.deniedTools?.length) {
        return !this.serverConfig.deniedTools.includes(t.name);
      }
      return true;
    });

    this.logger.info(
      {
        server: this.serverConfig.name,
        rawCount: allTools.length,
        filteredCount: this._tools.length,
        filtersApplied: hasFilters,
      },
      'MCP tools refreshed'
    );

    return this._tools;
  }

  /** Call a tool on the remote server */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!this.transport?.connected) {
      throw new Error(`MCP server ${this.serverConfig.name} not connected`);
    }

    const startMs = Date.now();
    this.logger.debug(
      { server: this.serverConfig.name, toolName, argsKeys: Object.keys(args) },
      'MCP tool call starting'
    );

    const callReq = createJsonRpcRequest('tools/call', {
      name: toolName,
      arguments: args,
    });

    this.transport.send(callReq);

    const callResp = await waitForResponse(this.transport, callReq.id, this.serverConfig.timeout);
    const durationMs = Date.now() - startMs;

    if (callResp.error) {
      this.logger.error(
        { server: this.serverConfig.name, toolName, durationMs, error: callResp.error.message },
        'MCP tool call failed'
      );
      return {
        content: [{ type: 'text', text: `MCP error: ${callResp.error.message}` }],
        isError: true,
      };
    }

    const result = callResp.result as McpToolCallResult;
    const contentLength =
      result.content?.reduce((sum, c) => sum + ('text' in c ? c.text.length : 0), 0) ?? 0;
    this.logger.debug(
      {
        server: this.serverConfig.name,
        toolName,
        durationMs,
        isError: result.isError,
        contentLength,
      },
      'MCP tool call completed'
    );

    return result;
  }

  /** Disconnect from the server */
  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    this._status = 'disconnected';

    if (this.transport) {
      await this.transport.close().catch(() => {});
      this.transport = null;
    }

    this._tools = [];
    this._serverInfo = null;
  }

  private createTransport(): McpTransport {
    if (this.serverConfig.transport === 'stdio') {
      if (!this.serverConfig.command) {
        throw new Error(
          `MCP server "${this.serverConfig.name}": stdio transport requires 'command'`
        );
      }
      return new McpStdioTransport({
        command: this.serverConfig.command,
        args: this.serverConfig.args,
        env: this.serverConfig.env,
      });
    }

    if (this.serverConfig.transport === 'sse') {
      if (!this.serverConfig.url) {
        throw new Error(`MCP server "${this.serverConfig.name}": sse transport requires 'url'`);
      }
      return new McpSseTransport({
        url: this.serverConfig.url,
        headers: this.serverConfig.headers,
      });
    }

    throw new Error(`Unknown transport: ${this.serverConfig.transport}`);
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, McpClient.MAX_RECONNECT_DELAY);
    this.reconnectAttempts++;

    this.logger.info(
      { server: this.serverConfig.name, delay, attempt: this.reconnectAttempts },
      'Scheduling MCP reconnect'
    );

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // connect() already schedules next reconnect on failure
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
