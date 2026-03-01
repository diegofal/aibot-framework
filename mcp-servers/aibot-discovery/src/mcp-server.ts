/**
 * MCP Server Protocol Handler
 *
 * Implements the MCP (Model Context Protocol) JSON-RPC interface.
 * Handles initialize, tools/list, tools/call, and ping methods.
 *
 * Reference: https://spec.modelcontextprotocol.io/
 */

import type { AgentDataLoader } from './agent-data.js';

// JSON-RPC 2.0 types
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// MCP tool definition
interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// MCP tool call result
interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpServer {
  handleRequest(request: JsonRpcRequest): JsonRpcResponse;
}

const SERVER_INFO = {
  name: 'aibot-agent-discovery',
  version: '0.1.0',
};

const PROTOCOL_VERSION = '2024-11-05';

const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'discover_agents',
    description:
      'List all agents in the aibot ecosystem with their capabilities, status, and tags. ' +
      'Returns an array of agent summaries. Filter by capability keyword or status.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description:
            "Filter by capability keyword (e.g., 'job-search', 'content', 'crypto', 'monetization')",
        },
        status: {
          type: 'string',
          enum: ['active', 'disabled', 'all'],
          description: 'Filter by agent status. Default: active',
        },
      },
    },
  },
  {
    name: 'get_agent_card',
    description:
      'Get detailed information about a specific agent including skills, identity, ' +
      'agent loop configuration, and tags.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description:
            "The agent identifier (e.g., 'job-seeker', 'myfirstmillion', 'openclone', 'moltbook')",
        },
      },
      required: ['agent_id'],
    },
  },
];

function handleDiscoverAgents(
  loader: AgentDataLoader,
  args: Record<string, unknown>
): McpToolResult {
  const capability = args.capability as string | undefined;
  const status = args.status as string | undefined;

  const agents = loader.listAgents({ capability, status });

  if (agents.length === 0) {
    const filterDesc = [
      capability ? `capability="${capability}"` : null,
      status ? `status="${status}"` : null,
    ]
      .filter(Boolean)
      .join(', ');

    return {
      content: [
        {
          type: 'text',
          text: filterDesc ? `No agents found matching filters: ${filterDesc}` : 'No agents found.',
        },
      ],
    };
  }

  const summary = agents.map((a) => ({
    id: a.id,
    name: a.name,
    status: a.status,
    description: a.description,
    skills: a.skills,
    tags: a.tags,
    identity: a.identity,
  }));

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ agents: summary, count: agents.length }, null, 2),
      },
    ],
  };
}

function handleGetAgentCard(loader: AgentDataLoader, args: Record<string, unknown>): McpToolResult {
  const agentId = args.agent_id as string | undefined;

  if (!agentId) {
    return {
      content: [{ type: 'text', text: 'Error: agent_id is required' }],
      isError: true,
    };
  }

  const agent = loader.getAgent(agentId);

  if (!agent) {
    // List available IDs to help the caller
    const available = loader
      .listAgents({ status: 'all' })
      .map((a) => a.id)
      .join(', ');
    return {
      content: [
        {
          type: 'text',
          text: `Agent "${agentId}" not found. Available agents: ${available}`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(agent, null, 2) }],
  };
}

export function createMcpServer(loader: AgentDataLoader): McpServer {
  return {
    handleRequest(request: JsonRpcRequest): JsonRpcResponse {
      const { id, method, params } = request;

      // Notifications (no id) — acknowledge silently
      if (id === undefined || id === null) {
        // MCP sends notifications like "notifications/initialized" — no response needed
        // But we return an empty object to avoid breaking the transport
        return { jsonrpc: '2.0', id: null, result: {} };
      }

      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {
                tools: {},
              },
              serverInfo: SERVER_INFO,
            },
          };

        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };

        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: TOOL_DEFINITIONS,
            },
          };

        case 'tools/call': {
          const toolName = (params as Record<string, unknown>)?.name as string;
          const toolArgs = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<
            string,
            unknown
          >;

          if (toolName === 'discover_agents') {
            return { jsonrpc: '2.0', id, result: handleDiscoverAgents(loader, toolArgs) };
          }

          if (toolName === 'get_agent_card') {
            return { jsonrpc: '2.0', id, result: handleGetAgentCard(loader, toolArgs) };
          }

          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Unknown tool: ${toolName}`,
            },
          };
        }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
      }
    },
  };
}
