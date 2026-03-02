/**
 * McpAgentBridge — enables agent-to-agent communication via MCP.
 *
 * External agents that expose an MCP server can be registered here.
 * Internal bots can then discover and interact with them as if they
 * were regular collaborators.
 */

import type { AgentRegistry } from '../agent-registry';
import type { CollaborationTracker } from '../collaboration-tracker';
import type { Logger } from '../logger';
import { McpClient, type McpServerConfig } from './client';
import type { McpToolCallResult } from './types';

export interface ExternalAgent {
  /** Unique identifier for this external agent */
  agentId: string;
  /** Human-readable name */
  name: string;
  /** Description of the agent's capabilities */
  description?: string;
  /** MCP server config to connect to this agent */
  mcpConfig: McpServerConfig;
}

export interface ExternalAgentInfo {
  agentId: string;
  name: string;
  description?: string;
  status: 'connected' | 'disconnected' | 'error';
  tools: string[];
}

export class McpAgentBridge {
  private agents: Map<string, { config: ExternalAgent; client: McpClient }> = new Map();

  constructor(
    private agentRegistry: AgentRegistry,
    private collaborationTracker: CollaborationTracker,
    private logger: Logger
  ) {}

  /** Register an external agent and connect to its MCP server */
  async registerAgent(agent: ExternalAgent): Promise<void> {
    if (this.agents.has(agent.agentId)) {
      throw new Error(`External agent "${agent.agentId}" already registered`);
    }

    const client = new McpClient(
      agent.mcpConfig,
      this.logger.child({ externalAgent: agent.agentId })
    );

    this.agents.set(agent.agentId, { config: agent, client });

    try {
      await client.connect();

      // Register in the shared agent registry so other bots can discover it
      this.agentRegistry.register({
        botId: agent.agentId,
        name: agent.name,
        skills: ['mcp-external'],
        description: agent.description,
        tools: client.tools.map((t) => t.name),
      });

      this.logger.info(
        { agentId: agent.agentId, toolCount: client.tools.length },
        'External MCP agent registered and connected'
      );
    } catch (err) {
      this.logger.warn({ agentId: agent.agentId, err }, 'Failed to connect to external MCP agent');
    }
  }

  /** Unregister and disconnect an external agent */
  async unregisterAgent(agentId: string): Promise<void> {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    await entry.client.disconnect();
    this.agentRegistry.unregister(agentId);
    this.agents.delete(agentId);

    this.logger.info({ agentId }, 'External MCP agent unregistered');
  }

  /** Call a tool on an external agent */
  async callTool(
    agentId: string,
    toolName: string,
    args: Record<string, unknown>,
    sourceBotId?: string
  ): Promise<McpToolCallResult> {
    const entry = this.agents.get(agentId);
    if (!entry) {
      return {
        content: [{ type: 'text', text: `External agent "${agentId}" not found` }],
        isError: true,
      };
    }

    if (entry.client.status !== 'connected') {
      return {
        content: [{ type: 'text', text: `External agent "${agentId}" not connected` }],
        isError: true,
      };
    }

    // Rate limiting via collaboration tracker (chatId = 0 for internal/MCP collaborations)
    if (sourceBotId) {
      const check = this.collaborationTracker.checkAndRecord(sourceBotId, agentId, 0);
      if (!check.allowed) {
        return {
          content: [
            { type: 'text', text: `Collaboration rate limit: ${check.reason ?? 'exceeded'}` },
          ],
          isError: true,
        };
      }
    }

    return entry.client.callTool(toolName, args);
  }

  /** List all registered external agents with their status */
  listAgents(): ExternalAgentInfo[] {
    return Array.from(this.agents.entries()).map(([agentId, { config, client }]) => ({
      agentId,
      name: config.name,
      description: config.description,
      status:
        client.status === 'connected'
          ? 'connected'
          : client.status === 'error'
            ? 'error'
            : 'disconnected',
      tools: client.tools.map((t) => t.name),
    }));
  }

  /** Disconnect all external agents */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.agents.keys()).map((id) => this.unregisterAgent(id)));
  }

  get size(): number {
    return this.agents.size;
  }
}
