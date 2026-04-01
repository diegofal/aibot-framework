import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bot, InputFile } from 'grammy';
import { type AgentInfo, AgentRegistry } from '../agent-registry';
import { CollaborationSessionManager } from '../collaboration-session';
import { CollaborationTracker } from '../collaboration-tracker';
import type { BotConfig, Config } from '../config';
import { resolveAgentConfig, resolveAgentConfigWithTenant } from '../config';
import {
  FailoverLLMClient,
  type LLMClient,
  LLMClientWithFallback,
  createLLMClient,
} from '../core/llm-client';
import type { SkillRegistry } from '../core/skill-registry';
import type { CronService } from '../cron';
import type { Logger } from '../logger';
import { McpAgentBridge } from '../mcp/agent-bridge';
import type { McpServerConfig } from '../mcp/client';
import { McpClientPool } from '../mcp/client-pool';
import { MediaHandler } from '../media';
import type { MemoryManager } from '../memory/manager';
import { MessageBuffer } from '../message-buffer';
import type { OllamaClient } from '../ollama';
import type { SessionManager } from '../session';
import { SoulLoader } from '../soul';
import type { Tool, ToolDefinition } from '../tools/types';

import { ConversationsService } from '../conversations/service';
import { KarmaService } from '../karma/service';
import { ProductionsService } from '../productions/service';
import { AnalyticsService } from '../tenant/analytics-service';
import { CustomizationService } from '../tenant/customization';
import type { TenantManagerConfig } from '../tenant/manager';
import type { Tenant } from '../tenant/manager';
import { TemplateService } from '../tenant/template-service';
import type { BillingProvider } from '../tenant/types';
import type { UsageEventType } from '../tenant/types';
import { WebhookService } from '../tenant/webhook-service';
import { ActivityStream } from './activity-stream';
import { type AgentFeedback, AgentFeedbackStore } from './agent-feedback-store';
import { AgentLoop, type AgentLoopResult, type AgentLoopState } from './agent-loop';
import { AskHumanStore, type PendingQuestionInfo } from './ask-human-store';
import {
  AskPermissionStore,
  type PermissionHistoryEntry,
  type PermissionRequestInfo,
} from './ask-permission-store';
import { BotResetService } from './bot-reset';
import { CollaborationManager } from './collaboration';
import { ContextCompactor } from './context-compaction';
import { ConversationPipeline } from './conversation-pipeline';
import { GroupActivation } from './group-activation';
import { HandlerRegistrar } from './handler-registrar';
import { HookEmitter } from './hooks';
import { InlineApprovalStore } from './inline-approval';
import { LlmQueryLog } from './llm-query-log';
import { MemoryFlusher } from './memory-flush';
import { runStartupSoulCheck } from './soul-health-check';
import { SystemPromptBuilder } from './system-prompt-builder';
import { TelegramPoller } from './telegram-poller';
import { sendLongMessage } from './telegram-utils';
import { TenantFacade } from './tenant-facade';
import { ToolAuditLog } from './tool-audit-log';
import { ToolRegistry } from './tool-registry';
import type { BotContext, SeenUser } from './types';
import { UserDirectory } from './user-directory';

export class BotManager {
  // Shared mutable state
  private bots: Map<string, Bot> = new Map();
  private runningBots: Set<string> = new Set();
  private activeModels: Map<string, string> = new Map();
  private tools: Tool[] = [];
  private toolDefinitions: ToolDefinition[] = [];
  private soulLoaders: Map<string, SoulLoader> = new Map();
  private botLoggers: Map<string, Logger> = new Map();
  private seenUsers: Map<string, Map<number, Map<number, SeenUser>>> = new Map();
  private handledMessageIds: Set<string> = new Set();
  private llmClients: Map<string, LLMClient> = new Map();

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
  private llmQueryLog: LlmQueryLog;
  private tenantFacade: TenantFacade;
  private activityStream: ActivityStream;
  private botResetService: BotResetService;
  private mcpClientPool: McpClientPool;
  private mcpAgentBridge: McpAgentBridge;
  private templateService?: TemplateService;
  private customizationService?: CustomizationService;
  private webhookService?: WebhookService;
  private analyticsService?: AnalyticsService;
  private userDirectory: UserDirectory;
  private inlineApprovalStore: InlineApprovalStore;
  private hookEmitter: HookEmitter;
  private botContext!: BotContext;
  private mcpConnected = false;
  private restartAttempts = new Map<string, number[]>();
  private restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pollAbortControllers = new Map<string, AbortController>();

  constructor(
    private skillRegistry: SkillRegistry,
    private logger: Logger,
    private ollamaClient: OllamaClient,
    private config: Config,
    private sessionManager: SessionManager,
    private cronService: CronService,
    private memoryManager?: MemoryManager,
    private configPath = './config/config.json'
  ) {
    this.agentRegistry = new AgentRegistry();

    const dataDir = config.paths.data;
    const collabConfig = config.collaboration;
    const collabDataDir = join(dataDir, 'collaboration');
    this.collaborationTracker = new CollaborationTracker(
      collabConfig.maxRounds,
      collabConfig.cooldownMs,
      collabDataDir
    );
    this.collaborationSessions = new CollaborationSessionManager(
      collabConfig.sessionTtlMs,
      collabDataDir
    );

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

    // Initialize LLM query log
    this.llmQueryLog = new LlmQueryLog(join(dataDir, 'llm-query-log'), logger);

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

    // Initialize activity stream for real-time visibility (with persistent LLM stats)
    this.activityStream = new ActivityStream(undefined, join(dataDir, 'llm-stats'));

    // Initialize MCP client pool
    this.mcpClientPool = new McpClientPool(logger);
    const mcpServers = config.mcp?.servers ?? [];
    for (const serverEntry of mcpServers) {
      const serverConfig: McpServerConfig = {
        name: serverEntry.name,
        transport: serverEntry.transport,
        command: serverEntry.command,
        args: serverEntry.args,
        env: serverEntry.env,
        url: serverEntry.url,
        headers: serverEntry.headers,
        timeout: serverEntry.timeout,
        autoReconnect: serverEntry.autoReconnect,
        toolPrefix: serverEntry.toolPrefix,
        allowedTools: serverEntry.allowedTools,
        deniedTools: serverEntry.deniedTools,
      };
      this.mcpClientPool.addServer(serverConfig);
    }
    if (mcpServers.length > 0) {
      logger.info({ count: mcpServers.length }, 'MCP server configs registered');
    }

    // Initialize MCP agent bridge for external agent collaboration
    this.mcpAgentBridge = new McpAgentBridge(this.agentRegistry, this.collaborationTracker, logger);

    // Initialize bot reset service
    this.botResetService = new BotResetService({
      sessionManager,
      memoryManager,
      agentFeedbackStore: this.agentFeedbackStore,
      askHumanStore: this.askHumanStore,
      askPermissionStore: this.askPermissionStore,
      karmaService: this.karmaService,
      conversationsService: this.conversationsService,
      toolAuditLog: this.toolAuditLog,
      collaborationTracker: this.collaborationTracker,
      collaborationSessions: this.collaborationSessions,
      activityStream: this.activityStream,
      logger,
      config,
      configPath: this.configPath,
      builtinSkillsPath: config.paths.skills,
      productionsBaseDir: config.productions?.baseDir ?? './productions',
    });

    // Initialize user directory
    this.userDirectory = new UserDirectory(dataDir, logger);
    logger.info('User directory initialized');

    // Initialize inline approval store (persisted to disk for confirm-level tool approvals)
    this.inlineApprovalStore = new InlineApprovalStore(join(dataDir, 'inline-approval'));

    // Initialize lifecycle hook emitter
    this.hookEmitter = new HookEmitter();

    // Diagnostic: warn about bots with soul files in legacy config/ path
    this.checkSoulSourceConsistency();

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
      messageBuffer: null, // set below after MessageBuffer is created
      searchEnabled: config.soul.search?.enabled ?? false,

      bots: this.bots,
      runningBots: this.runningBots,
      activeModels: this.activeModels,
      tools: this.tools,
      toolDefinitions: this.toolDefinitions,
      soulLoaders: this.soulLoaders,
      botLoggers: this.botLoggers,
      seenUsers: this.seenUsers,
      handledMessageIds: this.handledMessageIds,
      llmClients: this.llmClients,
      askHumanStore: this.askHumanStore,
      askPermissionStore: this.askPermissionStore,
      agentFeedbackStore: this.agentFeedbackStore,
      toolAuditLog: this.toolAuditLog,
      llmQueryLog: this.llmQueryLog,
      productionsService: this.productionsService,
      conversationsService: this.conversationsService,
      activityStream: this.activityStream,
      mcpClientPool: this.mcpClientPool,
      mcpAgentBridge: this.mcpAgentBridge,
      tenantFacade: this.tenantFacade,
      userDirectory: this.userDirectory,
      inlineApprovalStore: this.inlineApprovalStore,
      hooks: this.hookEmitter,

      getActiveModel: (botId: string) => this.getActiveModel(botId),
      getLLMClient: (botId: string) => this.getLLMClient(botId),
      getSoulLoader: (botId: string) => this.getSoulLoader(botId),
      getBotLogger: (botId: string) => this.getBotLogger(botId),
      resolveBotId: (targetBotId: string) => this.resolveBotId(targetBotId),
    };
    this.botContext = ctx;

    // Initialize modules in dependency order
    this.toolRegistry = new ToolRegistry(ctx);
    this.systemPromptBuilder = new SystemPromptBuilder(ctx, this.toolRegistry);
    this.memoryFlusher = new MemoryFlusher(ctx);
    this.groupActivation = new GroupActivation(ctx);
    const contextCompactor = new ContextCompactor(ctx, this.memoryFlusher);
    this.conversationPipeline = new ConversationPipeline(
      ctx,
      this.systemPromptBuilder,
      this.memoryFlusher,
      this.toolRegistry,
      contextCompactor
    );
    this.collaborationManager = new CollaborationManager(
      ctx,
      this.systemPromptBuilder,
      this.toolRegistry
    );
    this.handlerRegistrar = new HandlerRegistrar(
      ctx,
      this.conversationPipeline,
      this.groupActivation,
      this.memoryFlusher,
      this.toolRegistry,
      this.askHumanStore,
      this.conversationsService
    );
    this.agentLoop = new AgentLoop(ctx, this.systemPromptBuilder, this.toolRegistry);

    // Wire karma service into modules that need it
    if (this.karmaService) {
      this.agentLoop.setKarmaService(this.karmaService);
      this.systemPromptBuilder.setKarmaService(this.karmaService);
      this.toolRegistry.setKarmaService(this.karmaService);
      this.collaborationManager.setKarmaService(this.karmaService);
    }

    // Initialize evolution modules — gated by config.evolution.enabled
    if (config.evolution?.enabled) {
      const evoConfig = config.evolution;
      const enabledModules: string[] = [];

      if (evoConfig.outcomeLedger.enabled) {
        const { OutcomeLedger } = require('./outcome-ledger');
        const ledger = new OutcomeLedger(join(dataDir, 'outcome-ledger'), logger);
        this.agentLoop.setOutcomeLedger(ledger);
        enabledModules.push('outcomeLedger');
      }

      if (evoConfig.traitRegisters.enabled) {
        const { TraitRegisters } = require('./trait-registers');
        const registers = new TraitRegisters(join(dataDir, 'tenants/__admin__/bots'), logger);
        this.agentLoop.setTraitRegisters(registers);
        enabledModules.push('traitRegisters');
      }

      if (evoConfig.sensors.enabled) {
        const { SensorManager } = require('./sensors/sensor-manager');
        const sensorMgr = new SensorManager(logger, dataDir);
        sensorMgr.configure(evoConfig.sensors);
        this.agentLoop.setSensorManager(sensorMgr);
        enabledModules.push('sensors');
      }

      if (evoConfig.skillCrystallizer.enabled) {
        const { SkillCrystallizer } = require('./skill-crystallizer');
        const dynamicStore = (this as Record<string, unknown>).dynamicToolStore ?? null;
        const crystallizer = new SkillCrystallizer(dynamicStore, logger);
        this.agentLoop.setSkillCrystallizer(crystallizer);
        enabledModules.push('skillCrystallizer');
      }

      if (evoConfig.knowledgeMesh.enabled) {
        const { KnowledgeMesh } = require('./knowledge-mesh');
        const mesh = new KnowledgeMesh(join(dataDir, 'shared', 'knowledge-mesh.jsonl'), logger);
        this.agentLoop.setKnowledgeMesh(mesh);
        this.toolRegistry.setKnowledgeMesh(mesh);
        enabledModules.push('knowledgeMesh');
      }

      if (evoConfig.goalGenealogy.enabled) {
        const { GoalGenealogy } = require('./goal-genealogy');
        this.agentLoop.setGoalGenealogy(new GoalGenealogy());
        enabledModules.push('goalGenealogy');
      }

      logger.info({ modules: enabledModules }, 'Evolution modules initialized');
    }

    // Initialize tools (with lazy callbacks for circular deps)
    this.toolRegistry.initializeAll(
      () => this.collaborationManager,
      () => ({
        isTargetAvailable: (targetBotId: string) =>
          this.collaborationManager.isTargetAvailable(targetBotId),
        discoverAgents: (excludeBotId: string) =>
          this.collaborationManager.discoverAgents(excludeBotId),
        collaborationStep: (
          sessionId: string | undefined,
          targetBotId: string,
          message: string,
          sourceBotId: string
        ) =>
          this.collaborationManager.collaborationStep(sessionId, targetBotId, message, sourceBotId),
        endSession: (sessionId: string) => this.collaborationSessions.end(sessionId),
        sendVisibleMessage: (
          chatId: number,
          sourceBotId: string,
          targetBotId: string,
          message: string
        ) =>
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
      }
    );

    // Give skill command handlers the ability to call registered tools
    this.skillRegistry.setToolExecutor(async (name, args) => {
      const tool = this.tools.find((t: Tool) => t.definition.function.name === name);
      if (!tool) return undefined;
      return tool.execute(args, this.logger);
    });

    // Wire dynamic tool registry, tool registry, and agent loop into reset service (available after initializeAll)
    this.botResetService.setDynamicToolRegistry(this.toolRegistry.getDynamicToolRegistry());
    this.botResetService.setToolRegistry(this.toolRegistry);
    this.botResetService.setAgentLoop(this.agentLoop);

    // Create message buffer (needs handleConversation callback)
    this.messageBuffer = new MessageBuffer(
      config.buffer,
      async (gramCtx, botCfg, sessionKey, userText, images, sessionText, isVoice) => {
        await this.conversationPipeline.handleConversation(
          gramCtx,
          botCfg,
          sessionKey,
          userText,
          images,
          sessionText,
          isVoice
        );
        this.requestImmediateAgentRun(botCfg.id);
      },
      this.logger
    );

    // Wire messageBuffer into BotContext
    ctx.messageBuffer = this.messageBuffer;
  }

  // --- Public API (unchanged) ---

  getActiveModel(botId: string): string {
    return this.activeModels.get(botId) ?? this.config.ollama.models.primary;
  }

  getLLMClient(botId: string): LLMClient {
    const client = this.llmClients.get(botId);
    if (!client) {
      throw new Error(`No LLMClient registered for bot "${botId}". Was startBot() called?`);
    }
    return client;
  }

  getSoulLoader(botId: string): SoulLoader {
    const loader = this.soulLoaders.get(botId);
    if (!loader) {
      throw new Error(`No SoulLoader registered for bot "${botId}". Was startBot() called?`);
    }
    return loader;
  }

  /** Like getSoulLoader but returns undefined if bot is not started. */
  findSoulLoader(botId: string): SoulLoader | undefined {
    return this.soulLoaders.get(botId);
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
      if (
        botCfg.name.toLowerCase() === targetBotId.toLowerCase() &&
        this.runningBots.has(botCfg.id)
      ) {
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
      // Use tenant-aware config resolution when tenantId is present
      const resolved =
        config.tenantId && this.config.multiTenant?.enabled
          ? resolveAgentConfigWithTenant(this.config, undefined, config, config.tenantId)
          : resolveAgentConfig(this.config, config);
      this.activeModels.set(config.id, resolved.model);

      // Soul migration: copy from legacy config/soul/{id} to data/ if needed
      const legacySoulDir = join(this.config.soul.dir, config.id);
      if (resolved.soulDir !== legacySoulDir && existsSync(legacySoulDir)) {
        if (!existsSync(resolved.soulDir)) {
          cpSync(legacySoulDir, resolved.soulDir, { recursive: true });
          botLogger.info(
            { from: legacySoulDir, to: resolved.soulDir },
            'Soul migrated from legacy config/ to data/'
          );
        } else {
          botLogger.warn(
            { legacy: legacySoulDir, current: resolved.soulDir },
            'Soul exists in BOTH legacy config/ and data/. Using data/.'
          );
        }
      }

      // Ensure workDir and soulDir exist (creates tenant dirs for multi-tenant)
      mkdirSync(resolved.workDir, { recursive: true });
      mkdirSync(resolved.soulDir, { recursive: true });

      // Persist resolved paths back to botConfig so ProductionsService and other
      // services can find tenant-scoped directories
      if (config.tenantId) {
        config.soulDir = resolved.soulDir;
        config.workDir = resolved.workDir;
      }

      const llmClient = createLLMClient(
        {
          llmBackend: resolved.llmBackend,
          claudeModel: this.config.claudeCli?.model,
          claudeTimeout: config.agentLoop?.claudeTimeout ?? this.config.agentLoop.claudeTimeout,
          failoverConfig: this.config.failover,
        },
        this.ollamaClient,
        botLogger
      );
      if (llmClient instanceof LLMClientWithFallback || llmClient instanceof FailoverLLMClient) {
        llmClient.onFallback = (event) => {
          this.activityStream.publish({
            type: 'llm:fallback',
            botId: config.id,
            timestamp: Date.now(),
            data: {
              primaryBackend: event.primaryBackend,
              fallbackBackend: event.fallbackBackend,
              error: event.error,
              method: event.method,
            },
          });
        };
      }
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
          claudeModel: this.config.claudeCli?.model,
          timeout: this.config.improve?.timeout ?? 300_000,
          logger: botLogger,
          consolidateMemory: healthCheckConfig.consolidateMemory,
          llmBackend: healthCheckConfig.llmBackend,
          model: healthCheckConfig.model,
          ollamaClient: healthCheckConfig.llmBackend === 'ollama' ? this.ollamaClient : undefined,
        }).catch((err) => botLogger.warn({ err }, 'Soul health check failed (non-fatal)'));
      }

      // Background security audit (non-blocking, 24h cooldown)
      const securityConfig = this.config.security;
      if (securityConfig?.auditOnStartup !== false) {
        this.runSecurityAudit(config.id, resolved.soulDir, botLogger).catch((err) =>
          botLogger.warn({ err }, 'Security audit failed (non-fatal)')
        );
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
      // Connect MCP servers (once, on first bot start) and register their tools
      if (!this.mcpConnected && this.mcpClientPool.size > 0) {
        this.mcpConnected = true;
        this.mcpClientPool
          .connectAll()
          .then(() => {
            this.toolRegistry.registerMcpTools();
            this.logger.info(
              { connected: this.mcpClientPool.connectedCount },
              'MCP servers connected and tools registered'
            );
          })
          .catch((err) => {
            this.logger.warn({ err }, 'MCP connect failed (non-fatal)');
          });
      }

      // Wake the agent loop so it picks up the new bot immediately
      if (this.config.agentLoop.enabled) this.agentLoop.wakeUp();

      // Emit webhook for bot start (fire-and-forget)
      if (config.tenantId && this.webhookService) {
        this.webhookService
          .emit(
            config.tenantId,
            'bot.started',
            {
              botId: config.id,
              mode,
            },
            config.id
          )
          .catch(() => {});
      }

      this.logger.info({ botId: config.id, name: config.name, mode }, 'Bot started successfully');
    } catch (error) {
      this.runningBots.delete(config.id);
      this.logger.error({ error, botId: config.id }, 'Failed to start bot');
      throw error;
    }
  }

  // Polling logic extracted to TelegramPoller (src/bot/telegram-poller.ts)

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
    // TelegramPoller handles 409 with backoff and never crashes on transient conflicts.
    const ac = new AbortController();
    this.pollAbortControllers.set(config.id, ac);

    const poller = new TelegramPoller(botLogger);
    const pollingPromise = poller.start(bot, config.id, ac.signal);

    pollingPromise.catch(async (err) => {
      botLogger.error({ error: err, botId: config.id }, 'Polling failed');

      await this.cleanupBot(config.id);

      // Track restart attempts (sliding 5-min window)
      const now = Date.now();
      const recent = (this.restartAttempts.get(config.id) ?? []).filter(
        (t) => now - t < 5 * 60_000
      );

      if (recent.length >= 3) {
        botLogger.error(
          { botId: config.id, attempts: recent.length },
          'Max auto-restart attempts reached (3 in 5 min). Manual restart required.'
        );
        this.restartAttempts.delete(config.id);
        return;
      }
      this.restartAttempts.set(config.id, [...recent, now]);

      const delay = 10_000;
      botLogger.info(
        { botId: config.id, delay, attempt: recent.length + 1 },
        'Scheduling auto-restart...'
      );
      const timer = setTimeout(async () => {
        this.restartTimers.delete(config.id);
        const botConfig = this.config.bots.find((b) => b.id === config.id);
        if (!botConfig || this.runningBots.has(config.id)) return;
        try {
          await this.startBot(botConfig);
          botLogger.info({ botId: config.id }, 'Auto-restart succeeded');
        } catch (e) {
          botLogger.error({ error: e, botId: config.id }, 'Auto-restart failed');
        }
      }, delay);
      this.restartTimers.set(config.id, timer);
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
      tenantId: config.tenantId,
    });
    botLogger.info(
      { telegramUserId: me.id, username: me.username },
      'Registered in agent registry'
    );
  }

  private async runSecurityAudit(botId: string, soulDir: string, logger: Logger): Promise<void> {
    const cooldownMs = this.config.security?.cooldownMs ?? 86_400_000;
    const cooldownFile = join(soulDir, '.last-security-audit');

    // Check cooldown
    try {
      const lastCheck = Number(readFileSync(cooldownFile, 'utf-8').trim());
      if (Number.isFinite(lastCheck) && Date.now() - lastCheck < cooldownMs) {
        logger.debug({ botId }, 'Security audit: skipping (cooldown)');
        return;
      }
    } catch {
      /* no cooldown file */
    }

    const { runSecurityAudit, formatReportText } = await import('./security/audit');

    const report = await runSecurityAudit({
      botDir: soulDir,
      configPath: this.configPath,
    });

    // Log results
    if (report.summary.critical > 0) {
      logger.warn({ botId, summary: report.summary }, 'Security audit: CRITICAL issues found');
    } else if (report.summary.warn > 0) {
      logger.info({ botId, summary: report.summary }, 'Security audit: warnings found');
    } else {
      logger.info({ botId }, 'Security audit: clean');
    }

    // Surface in activity stream
    if (this.activityStream) {
      this.activityStream.publish({
        type: 'security:audit',
        botId,
        timestamp: Date.now(),
        data: {
          summary: report.summary,
          durationMs: report.meta.durationMs,
          findings: report.findings.slice(0, 5).map((f: { severity: string; title: string }) => ({
            severity: f.severity,
            title: f.title,
          })),
        },
      });
    }

    // Write cooldown
    writeFileSync(cooldownFile, String(Date.now()), 'utf-8');
  }

  private registerHeadless(config: BotConfig, botLogger: Logger): void {
    this.agentRegistry.register({
      botId: config.id,
      name: config.name,
      skills: config.skills,
      description: config.description,
      tools: this.toolRegistry.getDefinitionsForBot(config.id).map((d) => d.function.name),
      tenantId: config.tenantId,
    });
    botLogger.info('Registered headless bot in agent registry');
  }

  private async cleanupBot(botId: string): Promise<void> {
    // Cancel any pending auto-restart timer
    const restartTimer = this.restartTimers.get(botId);
    if (restartTimer) {
      clearTimeout(restartTimer);
      this.restartTimers.delete(botId);
    }
    // Drain pending collaboration tasks before unregistering
    await this.collaborationManager.drainPending(botId);
    // Abort the custom poll loop (if running) — we never called bot.start(),
    // so bot.stop() would either no-op or issue a getUpdates that could itself 409.
    const ac = this.pollAbortControllers.get(botId);
    if (ac) {
      ac.abort();
      this.pollAbortControllers.delete(botId);
    }
    this.bots.delete(botId);
    this.runningBots.delete(botId);
    this.activeModels.delete(botId);
    this.llmClients.delete(botId);
    this.soulLoaders.delete(botId);
    this.agentRegistry.unregister(botId);
  }

  async stopBot(botId: string): Promise<void> {
    if (!this.runningBots.has(botId)) return;

    // Cancel any pending auto-restart timer
    const restartTimer = this.restartTimers.get(botId);
    if (restartTimer) {
      clearTimeout(restartTimer);
      this.restartTimers.delete(botId);
    }
    // Emit webhook for bot stop (fire-and-forget)
    const botConfig = this.config.bots.find((b) => b.id === botId);
    if (botConfig?.tenantId && this.webhookService) {
      this.webhookService.emit(botConfig.tenantId, 'bot.stopped', { botId }, botId).catch(() => {});
    }

    await this.cleanupBot(botId);
    this.restartAttempts.delete(botId);
    this.botLoggers.delete(botId);
    this.logger.info({ botId }, 'Bot stopped');
  }

  async resetBot(botId: string) {
    const botConfig = this.config.bots.find((b) => b.id === botId);
    if (!botConfig) {
      throw new Error(`Bot not found: ${botId}`);
    }
    if (this.runningBots.has(botId)) {
      throw new Error('Stop the agent before resetting');
    }

    const resolved = resolveAgentConfig(this.config, botConfig);
    return this.botResetService.reset(botId, resolved.soulDir);
  }

  async sendMessage(chatId: number, text: string, botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`Bot not found: ${botId}`);
    await sendLongMessage((t) => bot.api.sendMessage(chatId, t), text);
  }

  /**
   * Process a cron instruction through the full conversation pipeline.
   * Creates a synthetic InboundMessage + Channel and delegates to handleChannelMessage.
   */
  async handleCronInstruction(chatId: number, text: string, botId: string): Promise<string> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`Bot not found for cron instruction: ${botId}`);

    const msg: import('../channel/types').InboundMessage = {
      messageId: `cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelKind: 'telegram',
      text,
      chatId: String(chatId),
      chatType: 'private',
      sender: { id: String(chatId), firstName: 'Cron' },
      timestamp: Date.now(),
    };

    const channel: import('../channel/types').Channel = {
      kind: 'telegram',
      async sendText(t: string) {
        await sendLongMessage((chunk) => bot.api.sendMessage(chatId, chunk), t);
      },
      async showTyping() {
        await bot.api.sendChatAction(chatId, 'typing');
      },
    };

    return this.handleChannelMessage(msg, channel, botId);
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
    this.activityStream.llmStats.flushToDisk();
    // Disconnect MCP agent bridge and servers
    await this.mcpAgentBridge.disconnectAll().catch(() => {});
    await this.mcpClientPool.disconnectAll().catch(() => {});
    this.mcpConnected = false;
    // Cancel all pending restart timers
    for (const [, timer] of this.restartTimers) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();
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
    this.activityStream.llmStats.flushToDisk();
    // Disconnect MCP agent bridge and servers
    await this.mcpAgentBridge.disconnectAll().catch(() => {});
    await this.mcpClientPool.disconnectAll().catch(() => {});
    this.mcpConnected = false;
    // Cancel all pending restart timers
    for (const [, timer] of this.restartTimers) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();
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

  getEvolutionState(botId: string) {
    return this.agentLoop.getEvolutionState(botId);
  }

  wakeAgentLoop(): void {
    this.agentLoop.wakeUp();
  }

  /** Request an immediate agent loop run for a specific bot (e.g. after user message) */
  requestImmediateAgentRun(botId: string): void {
    if (this.config.agentLoop.enabled) {
      this.agentLoop.requestImmediateRun(botId);
    }
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

  requeuePermission(id: string): boolean {
    const ok = this.askPermissionStore.requeueById(id);
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

  getAgentFeedback(
    botId: string,
    opts?: { status?: string; limit?: number; offset?: number }
  ): AgentFeedback[] {
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

  addAgentFeedbackThreadMessage(
    botId: string,
    feedbackId: string,
    role: 'human' | 'bot',
    content: string
  ) {
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

  // Agent proposals (for web API)
  getAgentProposalStore() {
    return this.toolRegistry.getAgentProposalStore();
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

  getActivityStream(): ActivityStream {
    return this.activityStream;
  }

  getLlmStats(botId?: string) {
    if (botId) {
      return this.activityStream.llmStats.getStats(botId) ?? null;
    }
    return this.activityStream.llmStats.getAllStats();
  }

  getMemoryManager(): MemoryManager | undefined {
    return this.memoryManager;
  }

  getOllamaClient(): OllamaClient {
    return this.ollamaClient;
  }

  getLlmQueryLog(): LlmQueryLog {
    return this.llmQueryLog;
  }

  /** Warn about bots that have soul files in the legacy config/soul/ path */
  private checkSoulSourceConsistency(): void {
    const legacyBaseDir = this.config.soul.dir;
    for (const bot of this.config.bots) {
      if (bot.soulDir) continue; // explicitly configured, skip
      const legacyDir = join(legacyBaseDir, bot.id);
      if (existsSync(legacyDir)) {
        const resolved = resolveAgentConfig(this.config, bot);
        if (resolved.soulDir !== legacyDir) {
          this.logger.warn(
            { botId: bot.id, legacyDir, resolvedDir: resolved.soulDir },
            'Soul files found in legacy config/ path — will be migrated on startBot'
          );
        }
      }
    }
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getInlineApprovalStore(): InlineApprovalStore {
    return this.inlineApprovalStore;
  }

  getMcpClientPool(): McpClientPool {
    return this.mcpClientPool;
  }

  buildSystemPrompt(options: import('./system-prompt-builder').SystemPromptOptions): string {
    return this.systemPromptBuilder.build(options);
  }

  /**
   * Build a system prompt for the given botId in conversation mode (channel-agnostic).
   * Used by A2A protocol executor for headless message processing.
   */
  async getSystemPrompt(botId: string): Promise<string> {
    const botConfig = this.config.bots.find((b: BotConfig) => b.id === botId);
    if (!botConfig) throw new Error(`Bot not found: ${botId}`);
    return this.systemPromptBuilder.build({
      mode: 'conversation',
      botId,
      botConfig,
      isGroup: false,
    });
  }

  async prefetchMemoryContext(query: string, botId: string): Promise<string | null> {
    return this.conversationPipeline.prefetchMemoryContext(
      query,
      false,
      this.getBotLogger(botId),
      botId
    );
  }

  /**
   * Channel-agnostic conversation entry point.
   * Accepts an InboundMessage + Channel instead of grammy Context.
   */
  async handleChannelMessage(
    msg: import('../channel/types').InboundMessage,
    channel: import('../channel/types').Channel,
    botId: string
  ): Promise<string> {
    const botConfig = this.config.bots.find((b) => b.id === botId);
    if (!botConfig) throw new Error(`Bot not found: ${botId}`);

    // Derive session key for the channel message
    const sessionKey = this.sessionManager.serializeKey({
      botId,
      chatType: msg.chatType,
      chatId: Number(msg.chatId) || 0,
      userId: Number(msg.sender.id) || undefined,
      threadId: msg.threadId ? Number(msg.threadId) : undefined,
    });

    // Webhook/analytics emission is handled inside ConversationPipeline
    // to cover both Telegram and channel-agnostic paths uniformly.
    return this.conversationPipeline.handleChannelMessage(msg, channel, botConfig, sessionKey);
  }

  // Collaboration delegates
  async sendVisibleMessage(
    chatId: number,
    sourceBotId: string,
    targetBotId: string,
    message: string
  ): Promise<void> {
    return this.collaborationManager.sendVisibleMessage(chatId, sourceBotId, targetBotId, message);
  }

  async handleDelegation(
    targetBotId: string,
    chatId: number,
    message: string,
    sourceBotId: string
  ): Promise<string> {
    return this.collaborationManager.handleDelegation(targetBotId, chatId, message, sourceBotId);
  }

  discoverAgents(excludeBotId: string): Array<AgentInfo & { model?: string }> {
    return this.collaborationManager.discoverAgents(excludeBotId);
  }

  async collaborationStep(
    sessionId: string | undefined,
    targetBotId: string,
    message: string,
    sourceBotId: string
  ): Promise<{ sessionId: string; response: string }> {
    return this.collaborationManager.collaborationStep(
      sessionId,
      targetBotId,
      message,
      sourceBotId
    );
  }

  async initiateCollaboration(
    sourceBotId: string,
    targetBotId: string,
    topic: string,
    maxTurns?: number
  ): Promise<{ sessionId: string; transcript: string; turns: number }> {
    return this.collaborationManager.initiateCollaboration(
      sourceBotId,
      targetBotId,
      topic,
      maxTurns
    );
  }

  // --- Tenant Management (delegates to TenantFacade) ---

  initializeTenantManager(config: TenantManagerConfig, billing?: BillingProvider): void {
    this.tenantFacade.initializeTenantManager(config, billing);

    // Initialize BaaS services when multi-tenant is enabled
    this.templateService = new TemplateService(config.dataDir, this.logger);
    this.customizationService = new CustomizationService(config.dataDir, this.logger);
    this.webhookService = new WebhookService(config.dataDir, this.logger);
    this.analyticsService = new AnalyticsService(config.dataDir);

    // Wire customization into system prompt builder
    this.systemPromptBuilder.setCustomizationService(this.customizationService);

    // Expose BaaS services to pipeline via shared BotContext
    // biome-ignore lint/suspicious/noExplicitAny: BotContext has readonly fields; runtime injection required for BaaS services
    (this.botContext as any).webhookService = this.webhookService;
    // biome-ignore lint/suspicious/noExplicitAny: BotContext has readonly fields; runtime injection required for BaaS services
    (this.botContext as any).analyticsService = this.analyticsService;
    // biome-ignore lint/suspicious/noExplicitAny: BotContext has readonly fields; runtime injection required for BaaS services
    (this.botContext as any).customizationService = this.customizationService;

    this.logger.info('BaaS services initialized (templates, customization, webhooks, analytics)');
  }

  getTemplateService() {
    return this.templateService;
  }
  getCustomizationService() {
    return this.customizationService;
  }
  getWebhookService() {
    return this.webhookService;
  }
  getAnalyticsService() {
    return this.analyticsService;
  }
  getTenantManager() {
    return this.tenantFacade.getTenantManager();
  }
  isMultiTenant() {
    return this.tenantFacade.isMultiTenant();
  }
  createTenant(name: string, email: string, plan?: Tenant['plan']) {
    return this.tenantFacade.createTenant(name, email, plan);
  }
  getTenant(tenantId: string) {
    return this.tenantFacade.getTenant(tenantId);
  }
  getTenantByApiKey(apiKey: string) {
    return this.tenantFacade.getTenantByApiKey(apiKey);
  }
  listTenants() {
    return this.tenantFacade.listTenants();
  }
  updateTenant(tenantId: string, updates: Partial<Omit<Tenant, 'id' | 'createdAt'>>) {
    return this.tenantFacade.updateTenant(tenantId, updates);
  }
  deleteTenant(tenantId: string) {
    return this.tenantFacade.deleteTenant(tenantId);
  }
  regenerateTenantApiKey(tenantId: string) {
    return this.tenantFacade.regenerateTenantApiKey(tenantId);
  }

  // --- Usage Metering ---

  recordUsage(
    tenantId: string,
    botId: string,
    type: UsageEventType,
    quantity?: number,
    metadata?: Record<string, unknown>
  ) {
    this.tenantFacade.recordUsage(tenantId, botId, type, quantity, metadata);
  }
  getTenantUsage(tenantId: string) {
    return this.tenantFacade.getTenantUsage(tenantId);
  }
  checkQuota(tenantId: string, type: 'messages' | 'apiCalls' | 'storage', amount?: number) {
    return this.tenantFacade.checkQuota(tenantId, type, amount);
  }

  // --- Bot Lifecycle with Tenant Awareness ---

  startBotWithTenant(botConfig: BotConfig) {
    return this.tenantFacade.startBotWithTenant(botConfig);
  }
  getTenantBots(tenantId: string) {
    return this.tenantFacade.getTenantBots(tenantId);
  }
  getRunningTenantBots(tenantId: string) {
    return this.tenantFacade.getRunningTenantBots(tenantId);
  }

  // --- Operator: Skill Command Execution ---

  /**
   * Execute a skill command headlessly (no Telegram context required).
   * Usable from API endpoints, cron jobs, or internal triggers.
   */
  async executeSkillCommand(
    botId: string,
    skillId: string,
    command: string,
    args: string[] = []
  ): Promise<string> {
    if (!this.runningBots.has(botId)) {
      throw new Error(`Bot ${botId} is not running`);
    }

    const skill = this.skillRegistry.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    const botConfig = this.config.bots.find((b) => b.id === botId);
    if (!botConfig || !botConfig.skills.includes(skillId)) {
      throw new Error(`Bot ${botId} does not have skill ${skillId} enabled`);
    }

    const cmdHandler = skill.commands?.[command];
    if (!cmdHandler) {
      throw new Error(`Command not found: ${command} in skill ${skillId}`);
    }

    const baseContext = this.skillRegistry.getContext(skillId);
    if (!baseContext) {
      throw new Error(`Skill context not initialized: ${skillId}`);
    }

    const bot = this.bots.get(botId);
    const telegramClient: import('../core/types').TelegramClient = {
      async sendMessage(chatId, text, options?) {
        if (bot) await bot.api.sendMessage(chatId, text, options as Record<string, unknown>);
      },
      async sendDocument(chatId, document, options?) {
        if (bot) {
          const opts = (options || {}) as Record<string, unknown>;
          const file = Buffer.isBuffer(document)
            ? new InputFile(new Uint8Array(document), opts.filename as string | undefined)
            : document;
          await bot.api.sendDocument(
            chatId,
            file as Parameters<typeof bot.api.sendDocument>[1],
            opts as Record<string, unknown>
          );
        }
      },
      async answerCallbackQuery() {
        /* no-op for headless */
      },
      async editMessageText() {
        /* no-op for headless */
      },
    };

    const resolved = resolveAgentConfig(this.config, botConfig);

    // Build operational state for skills
    const botState: import('../core/types').SkillContext['botState'] = {};
    if (this.karmaService) {
      botState.karmaBlock = this.karmaService.renderForPrompt(botId);
    }
    const loopState = this.agentLoop.getState();
    const schedule = loopState.botSchedules.find((s) => s.botId === botId);
    if (schedule?.recentActionsSummary?.length) {
      botState.recentActionsDigest = schedule.recentActionsSummary.join('\n');
    }

    const skillContext: import('../core/types').SkillContext = {
      ...baseContext,
      telegram: telegramClient,
      soulDir: resolved.soulDir,
      botId,
      workDir: resolved.workDir,
      botState,
    };

    const result = await cmdHandler.handler(args, skillContext);
    return result || '(no output)';
  }

  // --- Billing Integration ---

  getBillingProvider() {
    return this.tenantFacade.getBillingProvider();
  }
  createBillingCustomer(tenantId: string) {
    return this.tenantFacade.createBillingCustomer(tenantId);
  }
  handleWebhook(payload: unknown, signature: string) {
    return this.tenantFacade.handleWebhook(payload, signature);
  }
}
