import type { Bot, Context } from 'grammy';
import type { AgentRegistry } from '../agent-registry';
import type { CollaborationTracker } from '../collaboration-tracker';
import type { CollaborationSessionManager } from '../collaboration-session';
import type { BotConfig, Config } from '../config';
import type { SkillRegistry } from '../core/skill-registry';
import type { CronService } from '../cron';
import type { Logger } from '../logger';
import type { MediaHandler } from '../media';
import type { MemoryManager } from '../memory/manager';
import type { MessageBuffer } from '../message-buffer';
import type { OllamaClient } from '../ollama';
import type { SessionManager } from '../session';
import type { SoulLoader } from '../soul';
import type { Tool, ToolDefinition } from '../tools/types';
import type { LLMClient } from '../core/llm-client';

export interface SeenUser {
  id: number;
  firstName: string;
  username?: string;
  lastSeen: number;
}

/**
 * Shared context passed to all bot modules.
 * Contains references to all services and mutable state shared by reference.
 */
export interface BotContext {
  readonly config: Config;
  readonly ollamaClient: OllamaClient;
  readonly sessionManager: SessionManager;
  readonly skillRegistry: SkillRegistry;
  readonly cronService: CronService;
  readonly memoryManager: MemoryManager | undefined;
  readonly agentRegistry: AgentRegistry;
  readonly collaborationTracker: CollaborationTracker;
  readonly collaborationSessions: CollaborationSessionManager;
  readonly logger: Logger;
  readonly mediaHandler: MediaHandler | null;
  readonly messageBuffer: MessageBuffer;
  readonly searchEnabled: boolean;

  // Per-bot mutable state (shared by reference)
  readonly bots: Map<string, Bot>;
  readonly activeModels: Map<string, string>;
  readonly tools: Tool[];
  readonly toolDefinitions: ToolDefinition[];
  readonly soulLoaders: Map<string, SoulLoader>;
  readonly defaultSoulLoader: SoulLoader;
  readonly botLoggers: Map<string, Logger>;
  readonly seenUsers: Map<number, Map<number, SeenUser>>;
  readonly handledMessageIds: Set<string>;
  readonly llmClients: Map<string, LLMClient>;

  // Helper methods
  getActiveModel(botId: string): string;
  getLLMClient(botId: string): LLMClient;
  getSoulLoader(botId: string): SoulLoader;
  getBotLogger(botId: string): Logger;
  resolveBotId(targetBotId: string): string | undefined;
}
