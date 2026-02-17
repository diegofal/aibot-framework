import { Bot } from 'grammy';
import { AgentRegistry, type AgentInfo } from '../agent-registry';
import type { BotConfig, Config } from '../config';
import { resolveAgentConfig } from '../config';
import { CollaborationTracker } from '../collaboration-tracker';
import { CollaborationSessionManager } from '../collaboration-session';
import type { SkillRegistry } from '../core/skill-registry';
import type { CronService } from '../cron';
import type { Logger } from '../logger';
import { MediaHandler } from '../media';
import type { MemoryManager } from '../memory/manager';
import { MessageBuffer } from '../message-buffer';
import type { OllamaClient } from '../ollama';
import type { SessionManager } from '../session';
import { SoulLoader } from '../soul';
import type { Tool, ToolDefinition } from '../tools/types';

import type { BotContext, SeenUser } from './types';
import { ToolRegistry } from './tool-registry';
import { SystemPromptBuilder } from './system-prompt-builder';
import { MemoryFlusher } from './memory-flush';
import { GroupActivation } from './group-activation';
import { ConversationPipeline } from './conversation-pipeline';
import { CollaborationManager } from './collaboration';
import { HandlerRegistrar } from './handler-registrar';

export class BotManager {
  // Shared mutable state
  private bots: Map<string, Bot> = new Map();
  private activeModels: Map<string, string> = new Map();
  private tools: Tool[] = [];
  private toolDefinitions: ToolDefinition[] = [];
  private soulLoaders: Map<string, SoulLoader> = new Map();
  private botLoggers: Map<string, Logger> = new Map();
  private seenUsers: Map<number, Map<number, SeenUser>> = new Map();
  private handledMessageIds: Set<string> = new Set();
  private defaultSoulLoader: SoulLoader;

  // Infrastructure
  private messageBuffer: MessageBuffer;
  private mediaHandler: MediaHandler | null = null;
  readonly agentRegistry: AgentRegistry;
  private collaborationTracker: CollaborationTracker;
  private collaborationSessions: CollaborationSessionManager;

  // Modules
  private toolRegistry: ToolRegistry;
  private memoryFlusher: MemoryFlusher;
  private groupActivation: GroupActivation;
  private systemPromptBuilder: SystemPromptBuilder;
  private conversationPipeline: ConversationPipeline;
  private collaborationManager: CollaborationManager;
  private handlerRegistrar: HandlerRegistrar;

  constructor(
    private skillRegistry: SkillRegistry,
    private logger: Logger,
    private ollamaClient: OllamaClient,
    private config: Config,
    private sessionManager: SessionManager,
    soulLoader: SoulLoader,
    private cronService: CronService,
    private memoryManager?: MemoryManager
  ) {
    this.defaultSoulLoader = soulLoader;
    this.agentRegistry = new AgentRegistry();

    const collabConfig = config.collaboration;
    this.collaborationTracker = new CollaborationTracker(
      collabConfig.maxRounds,
      collabConfig.cooldownMs,
    );
    this.collaborationSessions = new CollaborationSessionManager(collabConfig.sessionTtlMs);

    if (config.media?.enabled) {
      this.mediaHandler = new MediaHandler(config.media, logger);
      this.logger.info('Media handler initialized');
    }

    // Build shared BotContext
    const ctx: BotContext = {
      config,
      ollamaClient,
      sessionManager,
      skillRegistry,
      cronService,
      memoryManager,
      agentRegistry: this.agentRegistry,
      collaborationTracker: this.collaborationTracker,
      collaborationSessions: this.collaborationSessions,
      logger,
      mediaHandler: this.mediaHandler,
      messageBuffer: null as any, // set below after MessageBuffer is created
      searchEnabled: config.soul.search?.enabled ?? false,

      bots: this.bots,
      activeModels: this.activeModels,
      tools: this.tools,
      toolDefinitions: this.toolDefinitions,
      soulLoaders: this.soulLoaders,
      defaultSoulLoader: this.defaultSoulLoader,
      botLoggers: this.botLoggers,
      seenUsers: this.seenUsers,
      handledMessageIds: this.handledMessageIds,

      getActiveModel: (botId: string) => this.getActiveModel(botId),
      getSoulLoader: (botId: string) => this.getSoulLoader(botId),
      getBotLogger: (botId: string) => this.getBotLogger(botId),
      resolveBotId: (targetBotId: string) => this.resolveBotId(targetBotId),
    };

    // Initialize modules in dependency order
    this.toolRegistry = new ToolRegistry(ctx);
    this.systemPromptBuilder = new SystemPromptBuilder(ctx, this.toolRegistry);
    this.memoryFlusher = new MemoryFlusher(ctx);
    this.groupActivation = new GroupActivation(ctx);
    this.conversationPipeline = new ConversationPipeline(
      ctx, this.systemPromptBuilder, this.memoryFlusher, this.toolRegistry
    );
    this.collaborationManager = new CollaborationManager(
      ctx, this.systemPromptBuilder, this.toolRegistry
    );
    this.handlerRegistrar = new HandlerRegistrar(
      ctx, this.conversationPipeline, this.groupActivation, this.memoryFlusher, this.toolRegistry
    );

    // Initialize tools (with lazy callbacks for circular deps)
    this.toolRegistry.initializeAll(
      () => this.collaborationManager,
      () => ({
        discoverAgents: (excludeBotId: string) => this.collaborationManager.discoverAgents(excludeBotId),
        collaborationStep: (sessionId: string | undefined, targetBotId: string, message: string, sourceBotId: string) =>
          this.collaborationManager.collaborationStep(sessionId, targetBotId, message, sourceBotId),
        endSession: (sessionId: string) => this.collaborationSessions.end(sessionId),
        sendVisibleMessage: (chatId: number, sourceBotId: string, targetBotId: string, message: string) =>
          this.collaborationManager.sendVisibleMessage(chatId, sourceBotId, targetBotId, message),
      }),
    );

    // Create message buffer (needs handleConversation callback)
    this.messageBuffer = new MessageBuffer(
      config.buffer,
      (gramCtx, botCfg, sessionKey, userText, images, sessionText) =>
        this.conversationPipeline.handleConversation(gramCtx, botCfg, sessionKey, userText, images, sessionText),
      this.logger
    );

    // Wire messageBuffer into BotContext
    (ctx as any).messageBuffer = this.messageBuffer;
  }

  // --- Public API (unchanged) ---

  getActiveModel(botId: string): string {
    return this.activeModels.get(botId) ?? this.config.ollama.models.primary;
  }

  getSoulLoader(botId: string): SoulLoader {
    return this.soulLoaders.get(botId) ?? this.defaultSoulLoader;
  }

  private getBotLogger(botId: string): Logger {
    let botLogger = this.botLoggers.get(botId);
    if (!botLogger) {
      botLogger = this.logger.child({ botId });
      this.botLoggers.set(botId, botLogger);
    }
    return botLogger;
  }

  private resolveBotId(targetBotId: string): string | undefined {
    if (this.bots.has(targetBotId)) return targetBotId;
    const byUsername = this.agentRegistry.getByTelegramUsername(targetBotId);
    if (byUsername && this.bots.has(byUsername.botId)) return byUsername.botId;
    for (const botCfg of this.config.bots) {
      if (botCfg.name.toLowerCase() === targetBotId.toLowerCase() && this.bots.has(botCfg.id)) {
        return botCfg.id;
      }
    }
    return undefined;
  }

  async startBot(config: BotConfig): Promise<void> {
    if (this.bots.has(config.id)) {
      this.logger.warn({ botId: config.id }, 'Bot already running');
      return;
    }

    try {
      const bot = new Bot(config.token);
      const botLogger = this.getBotLogger(config.id);

      const resolved = resolveAgentConfig(this.config, config);
      this.activeModels.set(config.id, resolved.model);

      const perBotSoulLoader = new SoulLoader(
        { ...this.config.soul, dir: resolved.soulDir },
        botLogger
      );
      await perBotSoulLoader.initialize();
      this.soulLoaders.set(config.id, perBotSoulLoader);
      botLogger.info({ soulDir: resolved.soulDir }, 'Per-agent soul loader initialized');

      bot.catch((error) => {
        botLogger.error({ error, botId: config.id }, 'Bot error');
      });

      // Register all handlers via HandlerRegistrar
      this.handlerRegistrar.registerAll(bot, config);

      bot.start();
      this.bots.set(config.id, bot);

      // Register in agent registry
      try {
        const me = await bot.api.getMe();
        this.agentRegistry.register({
          botId: config.id,
          name: config.name,
          telegramUserId: me.id,
          telegramUsername: me.username ?? config.id,
          skills: config.skills,
          description: config.description,
          tools: this.toolRegistry.getDefinitionsForBot(config.id).map((d) => d.function.name),
        });
        botLogger.info(
          { telegramUserId: me.id, username: me.username },
          'Registered in agent registry'
        );
      } catch (err) {
        botLogger.warn({ err }, 'Failed to register in agent registry (non-fatal)');
      }

      this.logger.info({ botId: config.id, name: config.name }, 'Bot started successfully');
    } catch (error) {
      this.logger.error({ error, botId: config.id }, 'Failed to start bot');
      throw error;
    }
  }

  async stopBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) return;

    await bot.stop();
    this.bots.delete(botId);
    this.activeModels.delete(botId);
    this.soulLoaders.delete(botId);
    this.botLoggers.delete(botId);
    this.agentRegistry.unregister(botId);
    this.logger.info({ botId }, 'Bot stopped');
  }

  async sendMessage(chatId: number, text: string, botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`Bot not found: ${botId}`);
    await bot.api.sendMessage(chatId, text);
  }

  isRunning(botId: string): boolean {
    return this.bots.has(botId);
  }

  getBotIds(): string[] {
    return Array.from(this.bots.keys());
  }

  async stopAll(): Promise<void> {
    this.messageBuffer.dispose();
    this.collaborationTracker.dispose();
    this.collaborationSessions.dispose();
    for (const [botId, bot] of this.bots.entries()) {
      this.agentRegistry.unregister(botId);
      await bot.stop();
      this.logger.info({ botId }, 'Bot stopped');
    }
    this.bots.clear();
  }

  // Collaboration delegates
  async sendVisibleMessage(chatId: number, sourceBotId: string, targetBotId: string, message: string): Promise<void> {
    return this.collaborationManager.sendVisibleMessage(chatId, sourceBotId, targetBotId, message);
  }

  async handleDelegation(targetBotId: string, chatId: number, message: string, sourceBotId: string): Promise<string> {
    return this.collaborationManager.handleDelegation(targetBotId, chatId, message, sourceBotId);
  }

  discoverAgents(excludeBotId: string): Array<AgentInfo & { model?: string }> {
    return this.collaborationManager.discoverAgents(excludeBotId);
  }

  async collaborationStep(
    sessionId: string | undefined,
    targetBotId: string,
    message: string,
    sourceBotId: string,
  ): Promise<{ sessionId: string; response: string }> {
    return this.collaborationManager.collaborationStep(sessionId, targetBotId, message, sourceBotId);
  }

  async initiateCollaboration(
    sourceBotId: string,
    targetBotId: string,
    topic: string,
    maxTurns?: number,
  ): Promise<{ sessionId: string; transcript: string; turns: number }> {
    return this.collaborationManager.initiateCollaboration(sourceBotId, targetBotId, topic, maxTurns);
  }
}
