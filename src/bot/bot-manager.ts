import { existsSync, unlinkSync, rmSync, readdirSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bot, GrammyError } from 'grammy';
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
import { AskPermissionStore, type PermissionRequestInfo, type PermissionHistoryEntry } from './ask-permission-store';
import { AgentFeedbackStore, type AgentFeedback } from './agent-feedback-store';
import { ToolAuditLog } from './tool-audit-log';
import { ProductionsService } from '../productions/service';
import { ConversationsService } from '../conversations/service';
import { KarmaService } from '../karma/service';
import { runStartupSoulCheck } from './soul-health-check';
import type { TenantManagerConfig } from '../tenant/manager';
import type { BillingProvider } from '../tenant/billing';
import type { Tenant, UsageEventType } from '../tenant/types';
import { TenantFacade } from './tenant-facade';

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
  private askPermissionStore: AskPermissionStore;
  private agentFeedbackStore: AgentFeedbackStore;
  private productionsService?: ProductionsService;
  private conversationsService: ConversationsService;
  private karmaService?: KarmaService;
  private toolAuditLog: ToolAuditLog;
  private tenantFacade: TenantFacade;
  private restartAttempts = new Map<string, number[]>();
  private pollAbortControllers = new Map<string, AbortController>();

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

    const dataDir = config.paths.data;
    const collabConfig = config.collaboration;
    const collabDataDir = join(dataDir, 'collaboration');
    this.collaborationTracker = new CollaborationTracker(
      collabConfig.maxRounds,
      collabConfig.cooldownMs,
      collabDataDir,
    );
    this.collaborationSessions = new CollaborationSessionManager(collabConfig.sessionTtlMs, collabDataDir);

    if (config.media?.enabled) {
      this.mediaHandler = new MediaHandler(config.media, logger);
      this.logger.info('Media handler initialized');
    }

    // Initialize conversations service
    this.conversationsService = new ConversationsService(config.conversations.baseDir);

    // Initialize ask-human store early so it's available in BotContext
    this.askHumanStore = new AskHumanStore(logger, join(dataDir, 'ask-human'), {
      onTimeout: (_questionId, botId, conversationId) => {
        if (conversationId) {
          this.conversationsService.markInboxStatus(botId, conversationId, 'timed_out');
        }
      },
      onDismiss: (_questionId, botId, conversationId) => {
        if (conversationId) {
          this.conversationsService.markInboxStatus(botId, conversationId, 'dismissed');
        }
      },
    });

    // Initialize ask-permission store
    this.askPermissionStore = new AskPermissionStore(logger, join(dataDir, 'ask-permission'));

    // Initialize agent feedback store
    this.agentFeedbackStore = new AgentFeedbackStore(logger);

    // Initialize tool audit log
    this.toolAuditLog = new ToolAuditLog(join(dataDir, 'tool-audit'), logger);

    // Initialize productions service if enabled
    if (config.productions?.enabled !== false) {
      this.productionsService = new ProductionsService(config, logger);
      logger.info({ baseDir: config.productions.baseDir }, 'Productions service initialized');
    }

    // Initialize karma service if enabled
    if (config.karma?.enabled !== false) {
      this.karmaService = new KarmaService(config.karma, logger);
      logger.info({ baseDir: config.karma.baseDir }, 'Karma service initialized');
    }

    // Initialize tenant facade
    this.tenantFacade = new TenantFacade({
      config,
      logger,
      runningBots: this.runningBots,
      stopBot: (botId: string) => this.stopBot(botId),
      startBot: (botConfig: BotConfig) => this.startBot(botConfig),
    });

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
      askPermissionStore: this.askPermissionStore,
      agentFeedbackStore: this.agentFeedbackStore,
      toolAuditLog: this.toolAuditLog,
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
      ctx, this.conversationPipeline, this.groupActivation, this.memoryFlusher, this.toolRegistry, this.askHumanStore, this.conversationsService
    );
    this.agentLoop = new AgentLoop(ctx, this.systemPromptBuilder, this.toolRegistry);

    // Wire karma service into modules that need it
    if (this.karmaService) {
      this.agentLoop.setKarmaService(this.karmaService);
      this.systemPromptBuilder.setKarmaService(this.karmaService);
      this.toolRegistry.setKarmaService(this.karmaService);
      this.collaborationManager.setKarmaService(this.karmaService);
    }

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
        conversationsService: this.conversationsService,
      },
      {
        store: this.askPermissionStore,
        getBotInstance: (botId: string) => this.bots.get(botId),
        getBotName: (botId: string) => this.config.bots.find((b) => b.id === botId)?.name ?? botId,
      },
    );

    // Create message buffer (needs handleConversation callback)
    this.messageBuffer = new MessageBuffer(
      config.buffer,
      (gramCtx, botCfg, sessionKey, userText, images, sessionText, isVoice) =>
        this.conversationPipeline.handleConversation(gramCtx, botCfg, sessionKey, userText, images, sessionText, isVoice),
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

      // Add to runningBots BEFORE starting to close the race window where
      // a concurrent startBot() could overlap (runningBots.has() returns false).
      this.runningBots.add(config.id);

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
      // Wake the agent loop so it picks up the new bot immediately
      if (this.config.agentLoop.enabled) this.agentLoop.wakeUp();
      this.logger.info({ botId: config.id, name: config.name, mode }, 'Bot started successfully');
    } catch (error) {
      this.runningBots.delete(config.id);
      this.logger.error({ error, botId: config.id }, 'Failed to start bot');
      throw error;
    }
  }

  private abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  /** Brief pause between polls to prevent Telegram server-side session overlap → 409 */
  private static readonly POLL_INTERVAL_MS = 500;

  /**
   * Custom polling loop that replaces grammy's bot.start().
   * Calls getUpdates directly and feeds updates to bot.handleUpdate().
   * grammy's handlePollingError is never invoked — we handle 409 with backoff.
   */
  private async pollLoop(bot: Bot, botId: string, signal: AbortSignal, logger: Logger): Promise<void> {
    let offset = 0;
    let consecutive409 = 0;
    let first409At = 0;
    const MAX_409_CONSECUTIVE = 20;
    const MAX_409_DURATION_MS = 5 * 60_000;

    // Match grammy's internal behavior: clear any webhook before polling
    await bot.api.deleteWebhook();

    while (!signal.aborted) {
      try {
        const updates = await bot.api.getUpdates({ offset, limit: 100, timeout: 30 }, signal);

        // Success — reset 409 tracking
        consecutive409 = 0;
        first409At = 0;

        if (updates.length === 0) {
          // Inter-poll pause before next getUpdates (prevents session overlap → 409)
          if (!signal.aborted) await this.abortableSleep(BotManager.POLL_INTERVAL_MS, signal);
          continue;
        }

        // Advance offset BEFORE handling (prevents infinite crash loop on poisoned update)
        offset = updates[updates.length - 1].update_id + 1;

        for (const update of updates) {
          try {
            await bot.handleUpdate(update);
          } catch (err) {
            logger.error({ err, updateId: update.update_id, botId }, 'Error handling update (non-fatal)');
          }
        }
      } catch (err) {
        if (signal.aborted) break;

        // Classify the error
        const is409 = err instanceof GrammyError && err.error_code === 409;
        const is401 = err instanceof GrammyError && err.error_code === 401;
        const is429 = err instanceof GrammyError && err.error_code === 429;

        if (is401) {
          throw err; // Bad token — unrecoverable
        }

        if (is409) {
          consecutive409++;
          if (first409At === 0) first409At = Date.now();

          const elapsed = Date.now() - first409At;
          if (consecutive409 >= MAX_409_CONSECUTIVE || elapsed >= MAX_409_DURATION_MS) {
            logger.error({ botId, consecutive409, elapsedMs: elapsed },
              'Sustained 409 conflict — giving up');
            throw err;
          }

          const delay = Math.min(3_000 * consecutive409, 30_000);
          if (consecutive409 <= 2) {
            logger.debug({ botId, attempt: consecutive409, delay }, 'getUpdates 409 — backing off');
          } else {
            logger.warn({ botId, attempt: consecutive409, delay }, 'getUpdates 409 — backing off');
          }
          await this.abortableSleep(delay, signal);
          continue;
        }

        if (is429) {
          const retryAfter = (err as GrammyError & { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 10;
          logger.warn({ botId, retryAfter }, 'Rate limited — respecting retry_after');
          await this.abortableSleep(retryAfter * 1000, signal);
          continue;
        }

        // Other transient errors — brief backoff
        logger.warn({ err, botId }, 'getUpdates error — retrying in 3s');
        await this.abortableSleep(3_000, signal);
      }

      // Brief pause between polls to prevent Telegram session overlap → 409
      if (!signal.aborted) await this.abortableSleep(BotManager.POLL_INTERVAL_MS, signal);
    }
  }

  private async startTelegramBot(config: BotConfig, botLogger: Logger): Promise<void> {
    const bot = new Bot(config.token);

    // Validate token by calling getMe before starting polling.
    // If the token is invalid, this throws and prevents the bot from being marked as running.
    const me = await bot.api.getMe();

    // Required for bot.handleUpdate() to work — grammy checks this.me internally
    bot.botInfo = me;

    bot.catch((error) => {
      botLogger.error({ error, botId: config.id }, 'Bot error');
    });

    // Register all handlers via HandlerRegistrar
    this.handlerRegistrar.registerAll(bot, config);

    // Store bot instance before starting the poll loop
    this.bots.set(config.id, bot);

    // Custom polling loop — replaces bot.start() entirely.
    // grammy's handlePollingError treats 409 as fatal (throws, kills loop).
    // Our pollLoop handles 409 with backoff and never crashes on transient conflicts.
    const ac = new AbortController();
    this.pollAbortControllers.set(config.id, ac);

    const pollingPromise = this.pollLoop(bot, config.id, ac.signal, botLogger);

    pollingPromise.catch(async (err) => {
      botLogger.error({ error: err, botId: config.id }, 'Polling failed');

      await this.cleanupBot(config.id);

      // Track restart attempts (sliding 5-min window)
      const now = Date.now();
      const recent = (this.restartAttempts.get(config.id) ?? [])
        .filter(t => now - t < 5 * 60_000);

      if (recent.length >= 3) {
        botLogger.error({ botId: config.id, attempts: recent.length },
          'Max auto-restart attempts reached (3 in 5 min). Manual restart required.');
        this.restartAttempts.delete(config.id);
        return;
      }
      this.restartAttempts.set(config.id, [...recent, now]);

      const delay = 10_000;
      botLogger.info({ botId: config.id, delay, attempt: recent.length + 1 },
        'Scheduling auto-restart...');
      setTimeout(async () => {
        const botConfig = this.config.bots.find(b => b.id === config.id);
        if (!botConfig || this.runningBots.has(config.id)) return;
        try {
          await this.startBot(botConfig);
          botLogger.info({ botId: config.id }, 'Auto-restart succeeded');
        } catch (e) {
          botLogger.error({ error: e, botId: config.id }, 'Auto-restart failed');
        }
      }, delay);
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

  private async cleanupBot(botId: string): Promise<void> {
    // Abort the custom poll loop (if running) — we never called bot.start(),
    // so bot.stop() would either no-op or issue a getUpdates that could itself 409.
    const ac = this.pollAbortControllers.get(botId);
    if (ac) { ac.abort(); this.pollAbortControllers.delete(botId); }
    this.bots.delete(botId);
    this.runningBots.delete(botId);
    this.activeModels.delete(botId);
    this.llmClients.delete(botId);
    this.soulLoaders.delete(botId);
    this.agentRegistry.unregister(botId);
  }

  async stopBot(botId: string): Promise<void> {
    if (!this.runningBots.has(botId)) return;

    await this.cleanupBot(botId);
    this.restartAttempts.delete(botId);
    this.botLoggers.delete(botId);
    this.logger.info({ botId }, 'Bot stopped');
  }

  async resetBot(botId: string): Promise<{
    ok: true;
    cleared: {
      sessions: number;
      soulRestored: boolean;
      goals: boolean;
      memoryDir: boolean;
      versions: boolean;
      coreMemory: boolean;
      index: boolean;
      feedback: boolean;
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
      soulRestored: false,
      goals: false,
      memoryDir: false,
      versions: false,
      coreMemory: false,
      index: false,
      feedback: false,
    };

    // 1. Clear sessions
    cleared.sessions = this.sessionManager.clearBotSessions(botId);

    // 2. Restore soul files from .baseline/ (or delete if no baseline)
    const baselineDir = join(soulDir, '.baseline');
    const soulFiles = ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md'] as const;
    const hasBaseline = existsSync(baselineDir);

    for (const file of soulFiles) {
      const baselinePath = join(baselineDir, file);
      const currentPath = join(soulDir, file);
      if (hasBaseline && existsSync(baselinePath)) {
        copyFileSync(baselinePath, currentPath);
        cleared.soulRestored = true;
      } else if (existsSync(currentPath)) {
        unlinkSync(currentPath);
      }
    }

    // 3. Delete GOALS.md
    const goalsPath = join(soulDir, 'GOALS.md');
    if (existsSync(goalsPath)) {
      unlinkSync(goalsPath);
      cleared.goals = true;
    }

    // 4. Delete MEMORY.md at soul root
    const rootMemoryPath = join(soulDir, 'MEMORY.md');
    if (existsSync(rootMemoryPath)) {
      unlinkSync(rootMemoryPath);
    }

    // 5. Recursively delete memory/ and recreate empty
    const memoryDir = join(soulDir, 'memory');
    if (existsSync(memoryDir)) {
      rmSync(memoryDir, { recursive: true });
      cleared.memoryDir = true;
    }
    mkdirSync(memoryDir, { recursive: true });

    // 6. Delete .versions/ recursively
    const versionsDir = join(soulDir, '.versions');
    if (existsSync(versionsDir)) {
      rmSync(versionsDir, { recursive: true });
      cleared.versions = true;
    }

    // 7. Delete feedback.jsonl + clear in-memory feedback store
    const feedbackPath = join(soulDir, 'feedback.jsonl');
    if (existsSync(feedbackPath)) {
      unlinkSync(feedbackPath);
      cleared.feedback = true;
    }
    this.agentFeedbackStore.clearForBot(botId);

    // 8. Clear core memory
    if (this.memoryManager) {
      this.memoryManager.clearCoreMemory();
      cleared.coreMemory = true;
    }

    // 9. Clear index
    if (this.memoryManager) {
      this.memoryManager.clearIndex();
      cleared.index = true;
    }

    // 10. Clear ask-human store for this bot
    this.askHumanStore.clearForBot(botId);

    // 11. Clear ask-permission store for this bot
    this.askPermissionStore.clearForBot(botId);

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
    this.askPermissionStore.dispose();
    // Abort all custom poll loops
    for (const [botId, ac] of this.pollAbortControllers) {
      ac.abort();
      this.logger.info({ botId }, 'Bot stopped');
    }
    this.pollAbortControllers.clear();
    for (const botId of this.runningBots) {
      this.agentRegistry.unregister(botId);
    }
    this.bots.clear();
    this.runningBots.clear();
  }

  /** Gracefully stop all: drain agent loop (wait for executing cycles), then full cleanup */
  async gracefulStopAll(timeoutMs?: number): Promise<void> {
    // Phase 1: Drain agent loop — executing bots finish their current cycle
    await this.agentLoop.gracefulStop(timeoutMs);
    // Phase 2: Full cleanup (same as stopAll)
    this.messageBuffer.dispose();
    this.collaborationTracker.dispose();
    this.collaborationSessions.dispose();
    this.askHumanStore.dispose();
    this.askPermissionStore.dispose();
    for (const [botId, ac] of this.pollAbortControllers) {
      ac.abort();
      this.logger.info({ botId }, 'Bot stopped (graceful)');
    }
    this.pollAbortControllers.clear();
    for (const botId of this.runningBots) {
      this.agentRegistry.unregister(botId);
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
    const result = this.askHumanStore.answerById(id, answer);
    if (result.ok) {
      // Write the answer to the inbox conversation and mark as answered
      if (result.conversationId && result.botId) {
        this.conversationsService.addMessage(result.botId, result.conversationId, 'human', answer);
        this.conversationsService.markInboxStatus(result.botId, result.conversationId, 'answered');
      }
      this.agentLoop.wakeUp();
    }
    return result.ok;
  }

  dismissAskHuman(id: string): boolean {
    const result = this.askHumanStore.dismissById(id);
    if (result.ok) {
      this.agentLoop.wakeUp();
    }
    return result.ok;
  }

  // Ask-permission delegates
  getPermissionsPending(): Array<PermissionRequestInfo & { botName: string }> {
    return this.askPermissionStore.getAll().map((r) => ({
      ...r,
      botName: this.config.bots.find((b) => b.id === r.botId)?.name ?? r.botId,
    }));
  }

  getPermissionsCount(): number {
    return this.askPermissionStore.getPendingCount();
  }

  approvePermission(id: string, note?: string): boolean {
    const ok = this.askPermissionStore.approveById(id, note);
    if (ok) this.agentLoop.wakeUp();
    return ok;
  }

  denyPermission(id: string, note?: string): boolean {
    const ok = this.askPermissionStore.denyById(id, note);
    if (ok) this.agentLoop.wakeUp();
    return ok;
  }

  getPermissionsHistory(limit?: number): Array<PermissionHistoryEntry & { botName: string }> {
    return this.askPermissionStore.getHistory(limit).map((e) => ({
      ...e,
      botName: this.config.bots.find((b) => b.id === e.botId)?.name ?? e.botId,
    }));
  }

  getPermissionHistoryById(id: string): (PermissionHistoryEntry & { botName: string }) | undefined {
    const entry = this.askPermissionStore.getHistoryById(id);
    if (!entry) return undefined;
    return {
      ...entry,
      botName: this.config.bots.find((b) => b.id === entry.botId)?.name ?? entry.botId,
    };
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

  getAgentFeedbackById(botId: string, feedbackId: string): AgentFeedback | null {
    return this.agentFeedbackStore.getById(botId, feedbackId);
  }

  addAgentFeedbackThreadMessage(botId: string, feedbackId: string, role: 'human' | 'bot', content: string) {
    return this.agentFeedbackStore.addThreadMessage(botId, feedbackId, role, content);
  }

  getAgentFeedbackBotIds(): string[] {
    return this.agentFeedbackStore.getBotIds();
  }

  getAvailableToolNames(): string[] {
    return this.toolDefinitions.map((d) => d.function.name);
  }

  // Dynamic tools (for web API)
  getDynamicToolStore() {
    return this.toolRegistry.getDynamicToolStore();
  }

  getDynamicToolRegistry() {
    return this.toolRegistry.getDynamicToolRegistry();
  }

  async initializeExternalSkills(): Promise<void> {
    await this.toolRegistry.initializeExternalSkills();
  }

  getExternalSkillNames(): string[] {
    return this.toolRegistry.getExternalSkillNames();
  }

  getExternalSkills(): import('../core/external-skill-loader').LoadedExternalSkill[] {
    return this.toolRegistry.getExternalSkills();
  }

  getConversationsService(): ConversationsService {
    return this.conversationsService;
  }

  getProductionsService(): ProductionsService | undefined {
    return this.productionsService;
  }

  getKarmaService(): KarmaService | undefined {
    return this.karmaService;
  }

  getOllamaClient(): OllamaClient {
    return this.ollamaClient;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
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

  // --- Tenant Management (delegates to TenantFacade) ---

  initializeTenantManager(config: TenantManagerConfig, billing?: BillingProvider): void {
    this.tenantFacade.initializeTenantManager(config, billing);
  }

  getTenantManager() { return this.tenantFacade.getTenantManager(); }
  isMultiTenant() { return this.tenantFacade.isMultiTenant(); }
  createTenant(name: string, email: string, plan?: Tenant['plan']) { return this.tenantFacade.createTenant(name, email, plan); }
  getTenant(tenantId: string) { return this.tenantFacade.getTenant(tenantId); }
  getTenantByApiKey(apiKey: string) { return this.tenantFacade.getTenantByApiKey(apiKey); }
  listTenants() { return this.tenantFacade.listTenants(); }
  updateTenant(tenantId: string, updates: Partial<Omit<Tenant, 'id' | 'createdAt'>>) { return this.tenantFacade.updateTenant(tenantId, updates); }
  deleteTenant(tenantId: string) { return this.tenantFacade.deleteTenant(tenantId); }
  regenerateTenantApiKey(tenantId: string) { return this.tenantFacade.regenerateTenantApiKey(tenantId); }

  // --- Usage Metering ---

  recordUsage(tenantId: string, botId: string, type: UsageEventType, quantity?: number, metadata?: Record<string, unknown>) { this.tenantFacade.recordUsage(tenantId, botId, type, quantity, metadata); }
  getTenantUsage(tenantId: string) { return this.tenantFacade.getTenantUsage(tenantId); }
  checkQuota(tenantId: string, type: 'messages' | 'apiCalls' | 'storage', amount?: number) { return this.tenantFacade.checkQuota(tenantId, type, amount); }

  // --- Bot Lifecycle with Tenant Awareness ---

  startBotWithTenant(botConfig: BotConfig) { return this.tenantFacade.startBotWithTenant(botConfig); }
  getTenantBots(tenantId: string) { return this.tenantFacade.getTenantBots(tenantId); }
  getRunningTenantBots(tenantId: string) { return this.tenantFacade.getRunningTenantBots(tenantId); }

  // --- Billing Integration ---

  getBillingProvider() { return this.tenantFacade.getBillingProvider(); }
  createBillingCustomer(tenantId: string) { return this.tenantFacade.createBillingCustomer(tenantId); }
}
