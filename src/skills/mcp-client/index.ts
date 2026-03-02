/**
 * MCP Client Skill — provides list_mcp_servers and call_mcp_tool handlers.
 *
 * These handlers are loaded by the external skill loader and delegate
 * to the McpClientPool stored in skill state.
 */

import type { McpClientPool } from '../../mcp/client-pool';

interface SkillContext {
  state: Map<string, unknown>;
  config: Record<string, unknown>;
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  data: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
  };
}

/**
 * List all MCP server connections and their tools.
 */
export async function list_mcp_servers(
  _args: Record<string, unknown>,
  ctx: SkillContext
): Promise<string> {
  const pool = ctx.data.get<McpClientPool>('mcpClientPool');
  if (!pool) {
    return 'MCP client pool not available. No MCP servers configured.';
  }

  const status = pool.getStatus();
  if (status.length === 0) {
    return 'No MCP servers configured.';
  }

  const lines: string[] = [`MCP Servers (${pool.connectedCount}/${pool.size} connected):\n`];

  for (const server of status) {
    lines.push(`- **${server.name}** [${server.status}]`);
    if (server.serverInfo) {
      lines.push(`  Server: ${server.serverInfo.name} v${server.serverInfo.version}`);
    }
    if (server.toolCount > 0) {
      const client = pool.getClient(server.name);
      if (client) {
        const toolNames = client.tools.map((t) => t.name).join(', ');
        lines.push(`  Tools (${server.toolCount}): ${toolNames}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Call a tool on a connected MCP server.
 */
export async function call_mcp_tool(
  args: Record<string, unknown>,
  ctx: SkillContext
): Promise<string> {
  const pool = ctx.data.get<McpClientPool>('mcpClientPool');
  if (!pool) {
    return 'MCP client pool not available.';
  }

  const serverName = args.server as string;
  const toolName = args.tool as string;
  const toolArgs = (args.arguments as Record<string, unknown>) ?? {};

  if (!serverName || !toolName) {
    return 'Missing required arguments: server, tool';
  }

  const result = await pool.callTool(serverName, toolName, toolArgs);

  const textParts = result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text);

  const output = textParts.join('\n') || '(empty response)';

  if (result.isError) {
    return `Error: ${output}`;
  }

  return output;
}
