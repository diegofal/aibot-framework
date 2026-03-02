/**
 * McpClientPool — manages lifecycle of multiple McpClient instances.
 *
 * Holds a shared pool of connections. Each bot can access the pool
 * to discover and call MCP tools.
 */

import type { Logger } from '../logger';
import { McpClient, type McpClientStatus, type McpServerConfig } from './client';
import type { McpToolCallResult, McpToolDef } from './types';

export interface McpClientInfo {
  name: string;
  status: McpClientStatus;
  toolCount: number;
  serverInfo: { name: string; version: string } | null;
  prefix: string;
}

export class McpClientPool {
  private clients: Map<string, McpClient> = new Map();

  constructor(private logger: Logger) {}

  /** Add a server configuration and return the client (does NOT connect yet) */
  addServer(config: McpServerConfig): McpClient {
    if (this.clients.has(config.name)) {
      throw new Error(`MCP server "${config.name}" already registered`);
    }
    const client = new McpClient(config, this.logger.child({ mcpServer: config.name }));
    this.clients.set(config.name, client);
    return client;
  }

  /** Connect all registered servers (errors are logged but don't prevent others) */
  async connectAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.clients.values()).map((client) => client.connect())
    );

    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        const name = Array.from(this.clients.keys())[i];
        this.logger.warn(
          { server: name, err: result.reason },
          'Failed to connect MCP server (will retry if autoReconnect)'
        );
      }
    }
  }

  /** Disconnect all clients */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.clients.values()).map((client) => client.disconnect())
    );
    this.clients.clear();
  }

  /** Disconnect and remove a specific server */
  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      await client.disconnect();
      this.clients.delete(name);
    }
  }

  /** Get a client by server name */
  getClient(name: string): McpClient | undefined {
    return this.clients.get(name);
  }

  /** Get all connected tools across all servers, with server prefix */
  getAllTools(): Array<{ serverName: string; prefix: string; tool: McpToolDef }> {
    const result: Array<{ serverName: string; prefix: string; tool: McpToolDef }> = [];
    for (const [name, client] of this.clients) {
      if (client.status !== 'connected') continue;
      for (const tool of client.tools) {
        result.push({ serverName: name, prefix: client.prefix, tool });
      }
    }
    return result;
  }

  /** Call a tool, routing to the correct client by server name */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      return {
        content: [{ type: 'text', text: `MCP server "${serverName}" not found` }],
        isError: true,
      };
    }
    if (client.status !== 'connected') {
      return {
        content: [
          {
            type: 'text',
            text: `MCP server "${serverName}" not connected (status: ${client.status})`,
          },
        ],
        isError: true,
      };
    }
    return client.callTool(toolName, args);
  }

  /** Get status info for all registered servers */
  getStatus(): McpClientInfo[] {
    return Array.from(this.clients.entries()).map(([name, client]) => ({
      name,
      status: client.status,
      toolCount: client.tools.length,
      serverInfo: client.serverInfo,
      prefix: client.prefix,
    }));
  }

  /** Number of registered servers */
  get size(): number {
    return this.clients.size;
  }

  /** Number of connected servers */
  get connectedCount(): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.status === 'connected') count++;
    }
    return count;
  }
}
