import type { ChannelStatus } from './bot/telegram-errors';

export interface AgentInfo {
  botId: string;
  name: string;
  telegramUserId?: number;
  telegramUsername?: string;
  skills: string[];
  description?: string;
  tools?: string[];
  /** MCP endpoint URL for external agents reachable via MCP */
  mcpEndpoint?: string;
  /** MCP server name for routing through McpClientPool */
  mcpServerName?: string;
  /** Tenant ID for multi-tenant isolation (bots can only collaborate within same tenant) */
  tenantId?: string;
  /** Outcome of the last channel start: telegram/ok, or why the bot is headless. */
  channel?: ChannelStatus;
}

/**
 * Shared registry that maps Telegram user IDs to bot IDs.
 * Populated when each bot starts; used for bot-to-bot detection.
 */
export class AgentRegistry {
  private agents: Map<string, AgentInfo> = new Map();
  private telegramIdMap: Map<number, string> = new Map();

  register(info: AgentInfo): void {
    this.agents.set(info.botId, info);
    if (info.telegramUserId) {
      this.telegramIdMap.set(info.telegramUserId, info.botId);
    }
  }

  unregister(botId: string): void {
    const info = this.agents.get(botId);
    if (info) {
      if (info.telegramUserId) {
        this.telegramIdMap.delete(info.telegramUserId);
      }
      this.agents.delete(botId);
    }
  }

  /** Record the channel outcome for a registered bot. False when the bot is unknown. */
  setChannel(botId: string, channel: ChannelStatus): boolean {
    const info = this.agents.get(botId);
    if (!info) return false;
    info.channel = channel;
    return true;
  }

  getByBotId(botId: string): AgentInfo | undefined {
    return this.agents.get(botId);
  }

  getByTelegramUserId(userId: number): AgentInfo | undefined {
    const botId = this.telegramIdMap.get(userId);
    return botId ? this.agents.get(botId) : undefined;
  }

  getByTelegramUsername(username: string): AgentInfo | undefined {
    const normalized = username.replace(/^@/, '').toLowerCase();
    for (const agent of this.agents.values()) {
      if (agent.telegramUsername?.toLowerCase() === normalized) {
        return agent;
      }
    }
    return undefined;
  }

  isKnownBot(telegramUserId: number): boolean {
    return this.telegramIdMap.has(telegramUserId);
  }

  listOtherAgents(excludeBotId: string, tenantId?: string): AgentInfo[] {
    return Array.from(this.agents.values()).filter((a) => {
      if (a.botId === excludeBotId) return false;
      // In multi-tenant mode, only discover agents from the same tenant
      if (tenantId && a.tenantId !== tenantId) return false;
      return true;
    });
  }
}
