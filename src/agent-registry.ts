export interface AgentInfo {
  botId: string;
  name: string;
  telegramUserId: number;
  telegramUsername: string;
  skills: string[];
  description?: string;
  tools?: string[];
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
    this.telegramIdMap.set(info.telegramUserId, info.botId);
  }

  unregister(botId: string): void {
    const info = this.agents.get(botId);
    if (info) {
      this.telegramIdMap.delete(info.telegramUserId);
      this.agents.delete(botId);
    }
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
      if (agent.telegramUsername.toLowerCase() === normalized) {
        return agent;
      }
    }
    return undefined;
  }

  isKnownBot(telegramUserId: number): boolean {
    return this.telegramIdMap.has(telegramUserId);
  }

  listOtherAgents(excludeBotId: string): AgentInfo[] {
    return Array.from(this.agents.values()).filter((a) => a.botId !== excludeBotId);
  }
}
