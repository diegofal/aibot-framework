import type { Bot, Context } from 'grammy';
import type { AgentRegistry } from '../agent-registry';
import type { CollaborationSessionManager } from '../collaboration-session';
import type { CollaborationTracker } from '../collaboration-tracker';
import type { BotConfig, Config } from '../config';
import type { ConversationsService } from '../conversations/service';
import type { LLMClient } from '../core/llm-client';
import type { SkillRegistry } from '../core/skill-registry';
import type { CronService } from '../cron';
import type { Logger } from '../logger';
import type { McpAgentBridge } from '../mcp/agent-bridge';
import type { McpClientPool } from '../mcp/client-pool';
import type { MediaHandler } from '../media';
import type { MemoryManager } from '../memory/manager';
import type { MessageBuffer } from '../message-buffer';
import type { OllamaClient } from '../ollama';
import type { ProductionsService } from '../productions/service';
import type { RelayService } from '../relay/service';
import type { SessionManager } from '../session';
import type { SoulLoader } from '../soul';
import type { Tool, ToolDefinition } from '../tools/types';
import type { ActivityStream } from './activity-stream';
import type { AgentFeedbackStore } from './agent-feedback-store';
import type { BackendCircuitBreaker } from './agent-retry-engine';
import type { AskHumanStore } from './ask-human-store';
import type { AskPermissionStore } from './ask-permission-store';
import type { InlineApprovalStore } from './inline-approval';
import type { LlmQueryLog } from './llm-query-log';
import type { TenantFacade } from './tenant-facade';
import type { ToolAuditLog } from './tool-audit-log';
import type { UserDirectory } from './user-directory';

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
  /** Curiosity: record a message from the operator as a navigator directive (operator surfaces only). */
  readonly recordOperatorMessage?: (botId: string, text: string) => void;
  /** Wake the bot's agent loop now without crediting feedback (ask_human answered on Telegram). */
  readonly wakeAgentLoop?: (botId: string) => void;
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
  messageBuffer: MessageBuffer | null;
  readonly searchEnabled: boolean;

  // Per-bot mutable state (shared by reference)
  readonly bots: Map<string, Bot>;
  readonly runningBots: Set<string>;
  readonly activeModels: Map<string, string>;
  readonly tools: Tool[];
  readonly toolDefinitions: ToolDefinition[];
  readonly soulLoaders: Map<string, SoulLoader>;
  readonly botLoggers: Map<string, Logger>;
  readonly seenUsers: Map<string, Map<number, Map<number, SeenUser>>>;
  readonly handledMessageIds: Set<string>;
  readonly llmClients: Map<string, LLMClient>;
  readonly askHumanStore: AskHumanStore;
  readonly askPermissionStore: AskPermissionStore;
  readonly agentFeedbackStore: AgentFeedbackStore;
  readonly toolAuditLog?: ToolAuditLog;
  readonly llmQueryLog?: LlmQueryLog;
  readonly productionsService?: ProductionsService;
  readonly conversationsService?: ConversationsService;
  readonly activityStream?: ActivityStream;
  readonly mcpClientPool?: McpClientPool;
  readonly mcpAgentBridge?: McpAgentBridge;
  readonly tenantFacade?: TenantFacade;
  readonly webhookService?: import('../tenant/webhook-service').WebhookService;
  readonly analyticsService?: import('../tenant/analytics-service').AnalyticsService;
  readonly customizationService?: import('../tenant/customization').CustomizationService;
  readonly userDirectory?: UserDirectory;
  /** Person-to-person relays (src/relay/): send_message and Telegram reply-to routing. */
  readonly relayService?: RelayService;
  /** The operator's Google/Microsoft accounts (src/personal-accounts/): calendar and mail tools. */
  readonly personalAccounts?: import('../personal-accounts/service').PersonalAccountService;
  readonly inlineApprovalStore?: InlineApprovalStore;
  readonly hooks?: import('./hooks').HookEmitter;
  /**
   * Fleet-wide per-backend breaker for 429/quota errors. Owned by BotManager
   * (AgentLoop creates and publishes one when absent) so every runtime —
   * planner, strategist, cycle executor, future task workers — consults and
   * feeds the same circuit.
   */
  circuitBreaker?: BackendCircuitBreaker;
  /**
   * Task workers (docs/plans/goal-tasks-architecture-plan.md). Absent until the
   * pool is wired; `isEnabledFor(botId)` gates every use.
   */
  workerPool?: import('../workers/types').WorkerPoolApi;
  /**
   * The fleet watcher's broadcasts (src/watcher/broadcast.ts), set by
   * `BotManager.setWatcherBroadcasts` once the watcher exists. Absent = no
   * "## Fleet broadcast" planner block.
   */
  watcherBroadcasts?: WatcherBroadcastSource;
  /**
   * The fleet watcher's view of a bot right now (phase 4), set by
   * `BotManager.setWatcherSelfState`. Absent = no "## Your current state"
   * block in the planners or the conversation prompt.
   */
  watcherSelfState?: WatcherSelfStateSource;

  // Helper methods
  getActiveModel(botId: string): string;
  getLLMClient(botId: string): LLMClient;
  getSoulLoader(botId: string): SoulLoader;
  getBotLogger(botId: string): Logger;
  resolveBotId(targetBotId: string): string | undefined;
}

/** What the agent loop reads of the fleet watcher's broadcasts (`Broadcaster`). */
export interface WatcherBroadcastSource {
  /** Delivered to the bot, not yet shown to a planner, recent. */
  pendingFor(
    botId: string
  ): Array<{ id: string; kind: 'wake' | 'directive' | 'goal' | 'question'; text: string }>;
  markShown(ids: string[], cycleId?: string): void;
}

/** What the planners and the conversation prompt read of the watcher's self-model (`Watcher.selfStateFor`). */
export interface WatcherSelfStateSource {
  selfStateFor(botId: string): import('./agent-loop-prompts').SelfStateInput | undefined;
}
