/**
 * MCP Tool Adapter — converts MCP tool definitions into framework Tool objects.
 *
 * Naming convention: `mcp_<prefix>_<toolName>`
 * Follows the same pattern as external-tool-adapter.ts.
 */

import type { Logger } from '../logger';
import type { Tool, ToolResult } from '../tools/types';
import type { McpClientPool } from './client-pool';
import type { McpToolDef } from './types';

/**
 * Create a framework Tool from an MCP tool definition.
 * The tool delegates execution to McpClientPool.callTool().
 */
export function adaptMcpTool(
  serverName: string,
  prefix: string,
  mcpTool: McpToolDef,
  pool: McpClientPool,
  logger: Logger
): Tool {
  const namespacedName = `mcp_${sanitizePrefix(prefix)}_${mcpTool.name}`;

  return {
    definition: {
      type: 'function',
      function: {
        name: namespacedName,
        description: `[MCP:${prefix}] ${mcpTool.description}`,
        parameters: {
          type: 'object',
          properties: mcpTool.inputSchema.properties ?? {},
          required: mcpTool.inputSchema.required,
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const result = await pool.callTool(serverName, mcpTool.name, args);

        // Extract text content from MCP result
        const textParts = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text);

        const content = textParts.join('\n') || '(empty response)';

        return {
          success: !result.isError,
          content,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { server: serverName, tool: mcpTool.name, err: message },
          'MCP tool call error'
        );
        return {
          success: false,
          content: `MCP tool error: ${message}`,
        };
      }
    },
  };
}

/**
 * Convert all connected MCP tools in a pool to framework Tool objects.
 */
export function adaptAllMcpTools(pool: McpClientPool, logger: Logger): Tool[] {
  const allMcpTools = pool.getAllTools();
  return allMcpTools.map(({ serverName, prefix, tool }) =>
    adaptMcpTool(serverName, prefix, tool, pool, logger)
  );
}

/**
 * Parse a namespaced MCP tool name back to server + original tool name.
 * Input: `mcp_github_create_issue` → { prefix: 'github', toolName: 'create_issue' }
 * Returns null if the name doesn't match the MCP pattern.
 */
export function parseMcpToolName(
  namespacedName: string
): { prefix: string; toolName: string } | null {
  const match = namespacedName.match(/^mcp_([^_]+)_(.+)$/);
  if (!match) return null;
  return { prefix: match[1], toolName: match[2] };
}

/**
 * Sanitize a prefix for use in tool names (lowercase, replace non-alphanum with underscore).
 */
function sanitizePrefix(prefix: string): string {
  return prefix.toLowerCase().replace(/[^a-z0-9]/g, '_');
}
