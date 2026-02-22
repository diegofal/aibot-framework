import { existsSync, unlinkSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
import { createLLMClient, OllamaLLMClient, type LLMClient } from '../core/llm-client';

import type { BotContext, SeenUser } from './types';
import { ToolRegistry } from './tool-registry';
import { SystemPromptBuilder } from './system-prompt-builder';
import { sendLongMessage } from './telegram-utils';
import { MemoryFlusher } from './memory-flush';
import { GroupActivation } from './group-activation';
import { ConversationPipeline } from './conversation-pipeline';
import { CollaborationManager } from './collaboration';
import { HandlerRegistrar } from './handler-registrar';
import { AgentLoop, type AgentLoopResult, type AgentLoopState } from './agent-loop';
import { AskHumanStore, type PendingQuestionInfo } from './ask-human-store';
import { AgentFeedbackStore, type AgentFeedback } from './agent-feedback-store';
import { ProductionsService } from '../productions/service';
import { runStartupSoulCheck } from './soul-health-check';

export class BotManager {
  // Shared mutable state
  private bots: Map<string, Bot> = new Map();
  private runningBots: Set<string> = new Set();
  private activeModels: Map<string, string> = new Map();
  private tools: Tool[] = [];
  private toolDefinitions: ToolDefinition[] = [];
  private soulLoaders: Map<string, SoulLoader> = new Map();
  private botLoggers: Map<string, Logger> = new Map();
  private seenUsers: Map<number, Map<number, SeenUser>> = new Map();
  private handledMessageIds: Set<string> = new Set();
  private defaultSoulLoader: SoulLoader;
  private llmClients: Map<string, LLMClient> = new Map();
  private defaultLLMClient: LLMClient;

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
  private agentLoop: AgentLoop;
  private askHumanStore: AskHumanStore;
  private agentFeedbackStore: AgentFeedbackStore;
  private productionsService?: ProductionsService;

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
    this.defaultLLMClient = new OllamaLLMClient(ollamaClient);
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

    // Initialize ask-human store early so it's available in BotContext
    this.askHumanStore = new AskHumanStore(logger);

    // Initialize agent feedback store
    this.agentFeedbackStore = new AgentFeedbackStore(logger);

    // Initialize productions service if enabled
    if (config.productions?.enabled !== false) {
      this.productionsService = new ProductionsService(config, logger);
      logger.info({ baseDir: config.productions.baseDir }, 'Productions service initialized');
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
      runningBots: this.runningBots,
      activeModels: this.activeModels,
      tools: this.tools,
      toolDefinitions: this.toolDefinitions,
      soulLoaders: this.soulLoaders,
      defaultSoulLoader: this.defaultSoulLoader,
      botLoggers: this.botLoggers,
      seenUsers: this.seenUsers,
      handledMessageIds: this.handledMessageIds,
      llmClients: this.llmClients,
      askHumanStore: this.askHumanStore,
      agentFeedbackStore: this.agentFeedbackStore,
      productionsService: this.productionsService,

      getActiveModel: (botId: string) => this.getActiveModel(botId),
      getLLMClient: (botId: string) => this.getLLMClient(botId),
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
      ctx, this.conversationPipeline, this.groupActivation, this.memoryFlusher, this.toolRegistry, this.askHumanStore
    );
    this.agentLoop = new AgentLoop(ctx, this.systemPromptBuilder, this.toolRegistry);

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
      {
        store: this.askHumanStore,
        getBotInstance: (botId: string) => this.bots.get(botId),
        getBotName: (botId: string) => this.config.bots.find((b) => b.id === botId)?.name ?? botId,
      },
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

  getLLMClient(botId: string): LLMClient {
    return this.llmClients.get(botId) ?? this.defaultLLMClient;
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
    if (this.runningBots.has(targetBotId)) return targetBotId;
    const byUsername = this.agentRegistry.getByTelegramUsername(targetBotId);
    if (byUsername && this.runningBots.has(byUsername.botId)) return byUsername.botId;
    for (const botCfg of this.config.bots) {
      if (botCfg.name.toLowerCase() === targetBotId.toLowerCase() && this.runningBots.has(botCfg.id)) {
        return botCfg.id;
      }
    }
    return undefined;
  }

  async startBot(config: BotConfig): Promise<void> {
    if (this.runningBots.has(config.id)) {
      this.logger.warn({ botId: config.id }, 'Bot already running');
      return;
    }

    try {
      const botLogger = this.getBotLogger(config.id);

      // Shared setup: LLM client, soul loader, model
      const resolved = resolveAgentConfig(this.config, config);
      this.activeModels.set(config.id, resolved.model);

      // Ensure workDir exists
      mkdirSync(resolved.workDir, { recursive: true });

      const llmClient = createLLMClient(
        {
          llmBackend: resolved.llmBackend,
          claudeTimeout: config.agentLoop?.claudeTimeout
            ?? this.config.agentLoop.claudeTimeout,
        },
        this.ollamaClient,
        botLogger,
      );
      this.llmClients.set(config.id, llmClient);
      botLogger.info({ backend: llmClient.backend }, 'Per-agent LLM client initialized');

      const perBotSoulLoader = new SoulLoader(
        { ...this.config.soul, dir: resolved.soulDir },
        botLogger
      );
      await perBotSoulLoader.initialize();
      this.soulLoaders.set(config.id, perBotSoulLoader);
      botLogger.info({ soulDir: resolved.soulDir }, 'Per-agent soul loader initialized');

      // Load agent feedback from disk
      this.agentFeedbackStore.loadFromDisk(config.id, resolved.soulDir);

      // Background soul health check + memory consolidation (non-blocking)
      const healthCheckConfig = this.config.soul.healthCheck;
      if (healthCheckConfig.enabled) {
        runStartupSoulCheck({
          botId: config.id,
          soulDir: resolved.soulDir,
          cooldownMs: healthCheckConfig.cooldownMs,
          claudePath: this.config.improve?.claudePath ?? 'claude',
          timeout: this.config.improve?.timeout ?? 120_000,
          logger: botLogger,
          consolidateMemory: healthCheckConfig.consolidateMemory,
        }).catch(err => botLogger.warn({ err }, 'Soul health check failed (non-fatal)'));
      }

      const token = config.token?.trim();
      let mode: 'telegram' | 'headless' = 'headless';

      if (token) {
        try {
          await this.startTelegramBot({ ...config, token }, botLogger);
          mode = 'telegram';
        } catch (err) {
          botLogger.warn({ err }, 'Telegram token invalid — starting in headless mode');
          this.registerHeadless(config, botLogger);
        }
      } else {
        this.registerHeadless(config, botLogger);
      }

      this.runningBots.add(config.id);
      // Wake the agent loop so it picks up the new bot immediately
      if (this.config.agentLoop.enabled) this.agentLoop.wakeUp();
      this.logger.info({ botId: config.id, name: config.name, mode }, 'Bot started successfully');
    } catch (error) {
      this.logger.error({ error, botId: config.id }, 'Failed to start bot');
      throw error;
    }
  }

  private async startTelegramBot(config: BotConfig, botLogger: Logger): Promise<void> {
    const bot = new Bot(config.token);

    // Validate token by calling getMe before starting polling.
    // If the token is invalid, this throws and prevents the bot from being marked as running.
    const me = await bot.api.getMe();

    bot.catch((error) => {
      botLogger.error({ error, botId: config.id }, 'Bot error');
    });

    // Register all handlers via HandlerRegistrar
    this.handlerRegistrar.registerAll(bot, config);

    // Start polling and handle async failures (e.g. 409 conflict after ungraceful shutdown)
    const pollingPromise = bot.start();
    this.bots.set(config.id, bot);

    pollingPromise.catch(async (err) => {
      const is409 = err?.error_code === 409 || err?.message?.includes('409');
      if (is409) {
        botLogger.warn({ botId: config.id }, 'Polling hit 409 conflict, retrying in 3s...');
        await new Promise((r) => setTimeout(r, 3000));
        try {
          // Create a fresh bot instance for the retry
          this.bots.delete(config.id);
          const retryBot = new Bot(config.token);
          retryBot.catch((error) => {
            botLogger.error({ error, botId: config.id }, 'Bot error');
          });
          this.handlerRegistrar.registerAll(retryBot, config);
          const retryPromise = retryBot.start();
          this.bots.set(config.id, retryBot);
          retryPromise.catch((retryErr) => {
            botLogger.error({ error: retryErr, botId: config.id }, 'Polling retry failed, bot stopped');
            this.cleanupBot(config.id);
          });
          botLogger.info({ botId: config.id }, 'Polling retry started');
        } catch (retryErr) {
          botLogger.error({ error: retryErr, botId: config.id }, 'Polling retry setup failed');
          this.cleanupBot(config.id);
        }
      } else {
        botLogger.error({ error: err, botId: config.id }, 'Polling failed, bot stopped');
        this.cleanupBot(config.id);
      }
    });

    // Register in agent registry with the already-validated bot info
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
  }

  private registerHeadless(config: BotConfig, botLogger: Logger): void {
    this.agentRegistry.register({
      botId: config.id,
      name: config.name,
      skills: config.skills,
      description: config.description,
      tools: this.toolRegistry.getDefinitionsForBot(config.id).map((d) => d.function.name),
    });
    botLogger.info('Registered headless bot in agent registry');
  }

  private cleanupBot(botId: string): void {
    this.bots.delete(botId);
    this.runningBots.delete(botId);
    this.activeModels.delete(botId);
    this.llmClients.delete(botId);
    this.soulLoaders.delete(botId);
    this.agentRegistry.unregister(botId);
  }

  async stopBot(botId: string): Promise<void> {
    if (!this.runningBots.has(botId)) return;

    const bot = this.bots.get(botId);
    if (bot) {
      await bot.stop();
    }
    this.cleanupBot(botId);
    this.botLoggers.delete(botId);
    this.logger.info({ botId }, 'Bot stopped');
  }

  async resetBot(botId: string): Promise<{
    ok: true;
    cleared: {
      sessions: number;
      goals: boolean;
      memoryLogs: number;
      versions: boolean;
      coreMemory: boolean;
      index: boolean;
    };
  }> {
    const botConfig = this.config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      throw new Error(`Bot not found: ${botId}`);
    }
    if (this.runningBots.has(botId)) {
      throw new Error('Stop the agent before resetting');
    }

    const resolved = resolveAgentConfig(this.config, botConfig);
    const soulDir = resolved.soulDir;
    const cleared = {
      sessions: 0,
      goals: false,
      memoryLogs: 0,
      versions: false,
      coreMemory: false,
      index: false,
    };

    // 1. Clear sessions
    cleared.sessions = this.sessionManager.clearBotSessions(botId);

    // 2. Delete GOALS.md
    const goalsPath = join(soulDir, 'GOALS.md');
    if (existsSync(goalsPath)) {
      unlinkSync(goalsPath);
      cleared.goals = true;
    }

    // 3. Delete all .md files in memory/
    const memoryDir = join(soulDir, 'memory');
    if (existsSync(memoryDir)) {
      for (const file of readdirSync(memoryDir)) {
        if (file.endsWith('.md')) {
          unlinkSync(join(memoryDir, file));
          cleared.memoryLogs++;
        }
      }
    }

    // 4. Delete .versions/ recursively
    const versionsDir = join(soulDir, '.versions');
    if (existsSync(versionsDir)) {
      rmSync(versionsDir, { recursive: true });
      cleared.versions = true;
    }

    // 5. Clear core memory
    if (this.memoryManager) {
      this.memoryManager.clearCoreMemory();
      cleared.coreMemory = true;
    }

    // 6. Clear index
    if (this.memoryManager) {
      this.memoryManager.clearIndex();
      cleared.index = true;
    }

    this.logger.info({ botId, cleared }, 'Bot reset completed');
    return { ok: true, cleared };
  }

  async sendMessage(chatId: number, text: string, botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`Bot not found: ${botId}`);
    await sendLongMessage(t => bot.api.sendMessage(chatId, t), text);
  }

  isRunning(botId: string): boolean {
    return this.runningBots.has(botId);
  }

  getBotIds(): string[] {
    return Array.from(this.runningBots);
  }

  async stopAll(): Promise<void> {
    this.agentLoop.stop();
    this.messageBuffer.dispose();
    this.collaborationTracker.dispose();
    this.collaborationSessions.dispose();
    this.askHumanStore.dispose();
    for (const botId of this.runningBots) {
      this.agentRegistry.unregister(botId);
      const bot = this.bots.get(botId);
      if (bot) {
        await bot.stop();
      }
      this.logger.info({ botId }, 'Bot stopped');
    }
    this.bots.clear();
    this.runningBots.clear();
  }

  // Agent loop
  startAgentLoop(): void {
    this.agentLoop.start();
  }

  async runAgentLoopAll(): Promise<AgentLoopResult[]> {
    return this.agentLoop.runNow();
  }

  async runAgentLoop(botId: string): Promise<AgentLoopResult> {
    return this.agentLoop.runOne(botId);
  }

  getAgentLoopState(): AgentLoopState {
    return this.agentLoop.getState();
  }

  wakeAgentLoop(): void {
    this.agentLoop.wakeUp();
  }

  // Ask-human delegates
  getAskHumanPending(): Array<PendingQuestionInfo & { botName: string }> {
    return this.askHumanStore.getAll().map((q) => ({
      ...q,
      botName: this.config.bots.find((b) => b.id === q.botId)?.name ?? q.botId,
    }));
  }

  getAskHumanCount(): number {
    return this.askHumanStore.getPendingCount();
  }

  answerAskHuman(id: string, answer: string): boolean {
    const ok = this.askHumanStore.answerById(id, answer);
    if (ok) this.agentLoop.wakeUp();
    return ok;
  }

  dismissAskHuman(id: string): boolean {
    const ok = this.askHumanStore.dismissById(id);
    if (ok) this.agentLoop.wakeUp();
    return ok;
  }

  // Agent feedback delegates
  submitAgentFeedback(botId: string, content: string): AgentFeedback {
    const entry = this.agentFeedbackStore.submit(botId, content);
    this.agentLoop.wakeUp();
    return entry;
  }

  getAgentFeedback(botId: string, opts?: { status?: string; limit?: number; offset?: number }): AgentFeedback[] {
    return this.agentFeedbackStore.getAll(botId, opts);
  }

  getAgentFeedbackPendingCount(): number {
    return this.agentFeedbackStore.getPendingCount();
  }

  dismissAgentFeedback(botId: string, id: string): boolean {
    return this.agentFeedbackStore.dismiss(botId, id);
  }

  getAgentFeedbackBotIds(): string[] {
    return this.agentFeedbackStore.getBotIds();
  }

  // Dynamic tools (for web API)
  getDynamicToolStore() {
    return this.toolRegistry.getDynamicToolStore();
  }

  getDynamicToolRegistry() {
    return this.toolRegistry.getDynamicToolRegistry();
  }

  getProductionsService(): ProductionsService | undefined {
    return this.productionsService;
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
