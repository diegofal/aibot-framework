import { resolve } from 'node:path';
import {
  type LoadedExternalSkill,
  discoverProductionSkillPaths,
  discoverSkillDirs,
  loadExternalSkill,
} from '../core/external-skill-loader';
import { type ExternalToolCronDeps, adaptExternalTool } from '../core/external-tool-adapter';
import type { KarmaService } from '../karma/service';
import type { Logger } from '../logger';
import { adaptAllMcpTools } from '../mcp/tool-adapter';
import type { Tool, ToolDefinition, ToolResult } from '../tools/types';
import { ToolExecutor } from './tool-executor';
import type { BotContext } from './types';

import { AgentProposalStore } from '../tools/agent-proposal-store';
import { createArchiveFileTool } from '../tools/archive-file';
import { type AskHumanDeps, createAskHumanTool } from '../tools/ask-human';
import { type AskPermissionDeps, createAskPermissionTool } from '../tools/ask-permission';
import { createBrowserTool } from '../tools/browser';
import {
  createCalendarAvailabilityTool,
  createCalendarListTool,
  createCalendarScheduleTool,
} from '../tools/calendar';
import { createCollaborateTool } from '../tools/collaborate';
import { createCoreMemoryTools } from '../tools/core-memory';
import { createCreateAgentTool } from '../tools/create-agent';
import { createCreateToolTool } from '../tools/create-tool';
import { createCronTool } from '../tools/cron';
import { createDatetimeTool } from '../tools/datetime';
import { createDelegationTool } from '../tools/delegate';
import { DynamicToolStore } from '../tools/dynamic-tool-store';
import { createExecTool } from '../tools/exec';
import { createFileEditTool, createFileReadTool, createFileWriteTool } from '../tools/file';
import { createGoalsTool } from '../tools/goals';
import { createImproveTool } from '../tools/improve';
import { createMemoryGetTool } from '../tools/memory-get';
import { createMemorySearchTool } from '../tools/memory-search';
import { createMoltbookRegisterTool } from '../tools/moltbook';
import { createPhoneCallTool } from '../tools/phone-call';
import { createProcessTool } from '../tools/process';
import { createProductionLogTool } from '../tools/production-log';
import { createRecallMemoryTool } from '../tools/recall-memory';
import { createRedditHotTool, createRedditReadTool, createRedditSearchTool } from '../tools/reddit';
import { createSignalCompletionTool } from '../tools/signal-completion';
import {
  createSaveMemoryTool,
  createUpdateIdentityTool,
  createUpdateSoulTool,
} from '../tools/soul';
import {
  createTwitterPostTool,
  createTwitterReadTool,
  createTwitterSearchTool,
} from '../tools/twitter';
import { createWebFetchTool } from '../tools/web-fetch';
import { createWebSearchTool } from '../tools/web-search';
import { DynamicToolRegistry } from './dynamic-tool-registry';

// ─── Tool Category System ───

export const TOOL_CATEGORY_NAMES = [
  'web',
  'memory',
  'soul',
  'files',
  'system',
  'social',
  'calendar',
  'communication',
  'browser',
  'production',
  'mcp',
] as const;

export type ToolCategory = (typeof TOOL_CATEGORY_NAMES)[number];

export const TOOL_CATEGORIES: Record<ToolCategory, string[]> = {
  web: ['web_search', 'web_fetch'],
  memory: [
    'memory_search',
    'memory_get',
    'recall_memory',
    'core_memory_append',
    'core_memory_replace',
    'core_memory_search',
    'save_memory',
  ],
  soul: ['update_soul', 'update_identity', 'manage_goals', 'improve'],
  files: ['file_read', 'file_write', 'file_edit'],
  system: ['exec', 'process', 'get_datetime', 'cron'],
  social: [
    'reddit_search',
    'reddit_hot',
    'reddit_read',
    'twitter_search',
    'twitter_read',
    'twitter_post',
  ],
  calendar: ['calendar_list', 'calendar_availability', 'calendar_schedule'],
  communication: [
    'ask_human',
    'ask_permission',
    'phone_call',
    'delegate_to_bot',
    'collaborate',
    'moltbook_register',
    'create_agent',
  ],
  browser: ['browser'],
  production: ['read_production_log', 'archive_file', 'create_tool', 'signal_completion'],
  mcp: [], // Dynamically populated by registerMcpTools()
};

/** Tools always sent to the executor regardless of category selection */
export const ALWAYS_INCLUDED_TOOLS = new Set(['get_datetime', 'ask_human', 'ask_permission']);

/** Reverse map: tool name → category */
export const TOOL_TO_CATEGORY: Map<string, ToolCategory> = (() => {
  const map = new Map<string, ToolCategory>();
  for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
    for (const tool of tools) {
      map.set(tool, category as ToolCategory);
    }
  }
  return map;
})();

export class ToolRegistry {
  private dynamicToolRegistry: DynamicToolRegistry | null = null;
  private dynamicToolStore: DynamicToolStore | null = null;
  private agentProposalStore: AgentProposalStore | null = null;
  /** Loaded external skills metadata (for per-bot filtering + web API) */
  private externalSkills: LoadedExternalSkill[] = [];
  /** Maps namespaced tool name → originating skill ID */
  private externalToolToSkill: Map<string, string> = new Map();
  private karmaService?: KarmaService;

  constructor(private ctx: BotContext) {}

  setKarmaService(ks: KarmaService): void {
    this.karmaService = ks;
  }

  /**
   * Initialize all tools based on config. Populates ctx.tools and ctx.toolDefinitions.
   * Delegation/collaboration tools receive lazy callbacks to avoid circular deps.
   */
  initializeAll(
    getDelegationHandler: () => import('../tools/delegate').DelegationHandler,
    getCollaborateHandler: () => import('../tools/collaborate').CollaborateHandler,
    askHumanDeps?: AskHumanDeps,
    askPermissionDeps?: AskPermissionDeps
  ): void {
    const { config, logger } = this.ctx;
    const tools = this.ctx.tools;

    // Web tools
    const webToolsConfig = config.webTools;
    if (webToolsConfig?.enabled) {
      if (webToolsConfig.search?.apiKey) {
        tools.push(
          createWebSearchTool({
            apiKey: webToolsConfig.search.apiKey,
            maxResults: webToolsConfig.search.maxResults,
            timeout: webToolsConfig.search.timeout,
            cacheTtlMs: webToolsConfig.search.cacheTtlMs,
          })
        );
        logger.info('Web search tool initialized');
      }

      if (webToolsConfig.fetch) {
        tools.push(
          createWebFetchTool({
            maxContentLength: webToolsConfig.fetch.maxContentLength,
            timeout: webToolsConfig.fetch.timeout,
            cacheTtlMs: webToolsConfig.fetch.cacheTtlMs,
          })
        );
        logger.info('Web fetch tool initialized');
      }
    } else {
      logger.debug('Web tools disabled');
    }

    // Soul tools
    if (config.soul.enabled) {
      const soulResolver = (botId: string) => this.ctx.getSoulLoader(botId);
      tools.push(
        createSaveMemoryTool(soulResolver),
        createUpdateSoulTool(soulResolver),
        createUpdateIdentityTool(soulResolver),
        createGoalsTool(soulResolver)
      );
      logger.info('Soul tools initialized (including goals)');
    }

    // Memory search tools
    if (this.ctx.searchEnabled && this.ctx.memoryManager) {
      tools.push(
        createMemorySearchTool(this.ctx.memoryManager),
        createMemoryGetTool(this.ctx.memoryManager)
      );
      logger.info('Memory search tools initialized');

      // Core memory tools (structured identity storage)
      const coreMemory = this.ctx.memoryManager.getCoreMemory();
      if (coreMemory) {
        const coreTools = createCoreMemoryTools(coreMemory);
        tools.push(...coreTools);
        logger.info({ coreToolCount: coreTools.length }, 'Core memory tools initialized');

        // Self-directed memory retrieval tool
        tools.push(createRecallMemoryTool(coreMemory));
        logger.info('Recall memory tool initialized');
      }
    }

    // Exec tool
    if (config.exec.enabled) {
      tools.push(
        createExecTool({
          timeout: config.exec.timeout,
          maxOutputLength: config.exec.maxOutputLength,
          workdir: config.exec.workdir,
          allowedPatterns: config.exec.allowedPatterns,
          deniedPatterns: config.exec.deniedPatterns,
          processToolConfig: config.processTools.enabled
            ? {
                maxSessions: config.processTools.maxSessions,
                finishedTtlMs: config.processTools.finishedTtlMs,
                maxOutputChars: config.processTools.maxOutputChars,
              }
            : undefined,
        })
      );
      logger.info('Exec tool initialized');
    }

    // File tools
    if (config.fileTools.enabled) {
      const fileConfig = {
        basePath: config.fileTools.basePath,
        maxFileSizeBytes: config.fileTools.maxFileSizeBytes,
        deniedPatterns: config.fileTools.deniedPatterns,
      };
      tools.push(
        createFileReadTool({ ...fileConfig, allowedPaths: config.fileTools.allowedPaths }),
        createFileWriteTool(fileConfig),
        createFileEditTool(fileConfig)
      );
      logger.info({ basePath: config.fileTools.basePath }, 'File tools initialized');
    }

    // Process tool
    if (config.processTools.enabled) {
      tools.push(
        createProcessTool({
          maxSessions: config.processTools.maxSessions,
          finishedTtlMs: config.processTools.finishedTtlMs,
          maxOutputChars: config.processTools.maxOutputChars,
        })
      );
      logger.info('Process tool initialized');
    }

    // Browser tool
    if (config.browserTools?.enabled) {
      tools.push(createBrowserTool({ ...config.browserTools }));
      logger.info('Browser tool initialized');
    }

    // Datetime tool
    if (config.datetime.enabled) {
      tools.push(
        createDatetimeTool({
          timezone: config.datetime.timezone,
          locale: config.datetime.locale,
        })
      );
      logger.info('Datetime tool initialized');
    }

    // Phone call tool
    if (config.phoneCall?.enabled) {
      tools.push(
        createPhoneCallTool({
          accountSid: config.phoneCall.accountSid,
          authToken: config.phoneCall.authToken,
          fromNumber: config.phoneCall.fromNumber,
          defaultNumber: config.phoneCall.defaultNumber,
          language: config.phoneCall.language,
          voice: config.phoneCall.voice,
          contactsFile: config.phoneCall.contactsFile,
        })
      );
      logger.info('Phone call tool initialized');
    }

    // Reddit tools
    if (config.reddit?.enabled) {
      tools.push(
        createRedditSearchTool(config.reddit),
        createRedditHotTool(config.reddit),
        createRedditReadTool(config.reddit)
      );
      logger.info('Reddit tools initialized (search, hot, read)');
    }

    // Twitter tools
    if (config.twitter?.enabled) {
      tools.push(createTwitterSearchTool(config.twitter), createTwitterReadTool(config.twitter));
      // Post tool only when write credentials are present
      if (config.twitter.accessToken && config.twitter.accessSecret) {
        tools.push(createTwitterPostTool(config.twitter));
        logger.info('Twitter tools initialized (search, read, post)');
      } else {
        logger.info(
          'Twitter tools initialized (search, read — post disabled: no write credentials)'
        );
      }
    }

    // Calendar tools
    if (config.calendar?.enabled) {
      tools.push(
        createCalendarListTool(config.calendar),
        createCalendarAvailabilityTool(config.calendar),
        createCalendarScheduleTool(config.calendar)
      );
      logger.info(
        { provider: config.calendar.provider },
        'Calendar tools initialized (list, availability, schedule)'
      );
    }

    // Cron tool
    if (config.cron.enabled) {
      tools.push(createCronTool(this.ctx.cronService));
      logger.info('Cron tool initialized');
    }

    // Delegation tool (multiple bots required)
    if (config.bots.length > 1) {
      tools.push(createDelegationTool(getDelegationHandler));
      logger.info('Delegation tool initialized');
    }

    // Collaborate tool (collaboration enabled + multiple bots)
    if (config.collaboration.enabled && config.bots.length > 1) {
      tools.push(createCollaborateTool(getCollaborateHandler));
      logger.info('Collaborate tool initialized');
    }

    // Improve tool
    if (config.improve.enabled) {
      tools.push(
        createImproveTool({
          claudePath: config.improve.claudePath,
          timeout: config.improve.timeout,
          maxOutputLength: config.improve.maxOutputLength,
          soulDir: config.improve.soulDir,
          allowedFocus: config.improve.allowedFocus,
        })
      );
      logger.info('Improve tool initialized');
    }

    // ask_human tool
    if (askHumanDeps) {
      tools.push(createAskHumanTool(askHumanDeps));
      logger.info('ask_human tool initialized');
    }

    // ask_permission tool
    if (askPermissionDeps) {
      tools.push(createAskPermissionTool(askPermissionDeps));
      logger.info('ask_permission tool initialized');
    }

    // Productions tools
    if (this.ctx.productionsService) {
      tools.push(createProductionLogTool(this.ctx.productionsService));
      tools.push(createArchiveFileTool(this.ctx.productionsService));
      tools.push(createSignalCompletionTool());
      logger.info(
        'Production tools initialized (read_production_log, archive_file, signal_completion)'
      );
    }

    // Moltbook registration tool
    tools.push(createMoltbookRegisterTool());
    logger.info('moltbook_register tool initialized');

    // Dynamic tools (create_tool + approved dynamic tools)
    const dtConfig = config.dynamicTools;
    if (dtConfig?.enabled) {
      this.dynamicToolStore = new DynamicToolStore(dtConfig.storePath);
      this.dynamicToolRegistry = new DynamicToolRegistry(this.ctx, this.dynamicToolStore, logger);
      tools.push(createCreateToolTool(this.dynamicToolStore, dtConfig.maxToolsPerBot));
      logger.info('create_tool registered');
      // Load approved dynamic tools (adds to ctx.tools[] via dynamicToolRegistry)
      this.dynamicToolRegistry.initialize();
    }

    // Agent proposals (create_agent tool)
    const apConfig = config.agentProposals;
    if (apConfig?.enabled) {
      this.agentProposalStore = new AgentProposalStore(apConfig.storePath);
      tools.push(
        createCreateAgentTool(
          this.agentProposalStore,
          config.bots,
          apConfig.maxAgents,
          apConfig.maxProposalsPerBot
        )
      );
      logger.info('create_agent registered');
    }

    // Populate definitions
    this.ctx.toolDefinitions.length = 0;
    this.ctx.toolDefinitions.push(...tools.map((t) => t.definition));

    if (tools.length > 0) {
      logger.info(
        { toolCount: tools.length, tools: this.ctx.toolDefinitions.map((d) => d.function.name) },
        'Tools initialized'
      );
    }
  }

  /**
   * Register MCP tools from connected MCP servers.
   * Called after McpClientPool.connectAll() completes.
   */
  registerMcpTools(): void {
    const { logger } = this.ctx;
    const pool = this.ctx.mcpClientPool;

    // Remove existing MCP tools first (idempotent re-registration)
    const oldMcpNames = TOOL_CATEGORIES.mcp;
    if (oldMcpNames.length > 0) {
      const oldSet = new Set(oldMcpNames);
      this.ctx.tools = this.ctx.tools.filter((t) => !oldSet.has(t.definition.function.name));
      for (const name of oldMcpNames) {
        TOOL_TO_CATEGORY.delete(name);
      }
      TOOL_CATEGORIES.mcp = [];
    }

    if (!pool || pool.connectedCount === 0) {
      // Re-sync definitions (MCP tools were removed)
      this.ctx.toolDefinitions.length = 0;
      this.ctx.toolDefinitions.push(...this.ctx.tools.map((t) => t.definition));
      logger.info('MCP tools cleared (no connected servers)');
      return;
    }

    const mcpTools = adaptAllMcpTools(pool, logger);
    if (mcpTools.length === 0) {
      this.ctx.toolDefinitions.length = 0;
      this.ctx.toolDefinitions.push(...this.ctx.tools.map((t) => t.definition));
      logger.info('MCP tools cleared (no tools from connected servers)');
      return;
    }

    // Track MCP tool names in the category for pre-selection
    const mcpToolNames: string[] = [];

    for (const tool of mcpTools) {
      this.ctx.tools.push(tool);
      const name = tool.definition.function.name;
      mcpToolNames.push(name);
      TOOL_TO_CATEGORY.set(name, 'mcp');
    }

    // Update the mcp category list
    TOOL_CATEGORIES.mcp = mcpToolNames;

    // Re-sync definitions
    this.ctx.toolDefinitions.length = 0;
    this.ctx.toolDefinitions.push(...this.ctx.tools.map((t) => t.definition));

    logger.info({ mcpToolCount: mcpTools.length, tools: mcpToolNames }, 'MCP tools registered');
  }

  /**
   * Discover, load, and register external skills from configured skill folders.
   * Each skill's tools are namespaced (skillId_toolName) and added to ctx.tools[].
   */
  async initializeExternalSkills(): Promise<void> {
    const { config, logger } = this.ctx;

    // Collect from configured skillsFolders.paths
    const configuredPaths = config.skillsFolders?.paths ?? [];
    const configuredDirs = discoverSkillDirs(configuredPaths);

    // Collect from auto-discovered production directories
    const productionEntries = discoverProductionSkillPaths(
      config.productions?.baseDir ?? './productions'
    );
    const productionDirs = discoverSkillDirs(productionEntries.map((e) => e.path));

    // Build botName lookup: resolved dir → botName
    const dirToBotName = new Map<string, string>();
    for (const entry of productionEntries) {
      const resolved = resolve(entry.path);
      for (const dir of productionDirs) {
        if (resolve(dir).startsWith(resolved)) {
          dirToBotName.set(resolve(dir), entry.botName);
        }
      }
    }

    // Deduplicate by resolved absolute path
    const seen = new Set<string>();
    const allDirs: string[] = [];
    for (const dir of [...configuredDirs, ...productionDirs]) {
      const abs = resolve(dir);
      if (!seen.has(abs)) {
        seen.add(abs);
        allDirs.push(dir);
      }
    }

    if (allDirs.length === 0) {
      if (configuredPaths.length > 0 || productionEntries.length > 0) {
        logger.info(
          { configuredPaths, productionPaths: productionEntries.map((e) => e.path) },
          'No external skills found'
        );
      }
      return;
    }

    logger.info(
      {
        count: allDirs.length,
        configuredPaths,
        productionPaths: productionEntries.map((e) => e.path),
      },
      'Discovered external skill directories'
    );

    for (const dir of allDirs) {
      try {
        const loaded = await loadExternalSkill(dir, logger);
        const { manifest, handlers, warnings } = loaded;

        // Tag with bot name if from a production directory
        const botName = dirToBotName.get(resolve(dir));
        if (botName) {
          loaded.botName = botName;
        }

        if (warnings.length > 0) {
          const hasMissingEnv = warnings.some((w) => w.startsWith('Missing env var'));
          const hasMissingBin = warnings.some((w) => w.startsWith('Missing binary'));
          if (hasMissingEnv || hasMissingBin) {
            logger.info(
              { skillId: manifest.id, warnings },
              'Skipping external skill due to missing requirements'
            );
            continue;
          }
          logger.warn({ skillId: manifest.id, warnings }, 'External skill loaded with warnings');
        }

        // Build per-skill shared state and config
        const skillState = new Map<string, unknown>();
        const skillConfig: Record<string, unknown> = manifest.config ?? {};

        // Merge framework-level skill config if available
        const frameworkConfig = config.skills?.config?.[manifest.id];
        if (frameworkConfig && typeof frameworkConfig === 'object') {
          Object.assign(skillConfig, frameworkConfig);
        }

        // Build cron deps if CronService is available (enables reminders skill, etc.)
        const cronDeps: ExternalToolCronDeps | undefined = this.ctx.cronService
          ? { cronService: this.ctx.cronService }
          : undefined;

        let toolCount = 0;
        for (const toolDef of manifest.tools) {
          const handler = handlers[toolDef.name];
          if (typeof handler !== 'function') continue;

          const tool = adaptExternalTool(
            manifest.id,
            toolDef,
            handler,
            skillConfig,
            skillState,
            logger,
            cronDeps
          );

          this.ctx.tools.push(tool);
          this.externalToolToSkill.set(tool.definition.function.name, manifest.id);
          toolCount++;
        }

        this.externalSkills.push(loaded);
        logger.info({ skillId: manifest.id, toolCount, dir }, 'External skill loaded');
      } catch (err) {
        logger.error({ dir, err }, 'Failed to load external skill');
      }
    }

    // Re-sync definitions after adding external tools
    this.ctx.toolDefinitions.length = 0;
    this.ctx.toolDefinitions.push(...this.ctx.tools.map((t) => t.definition));

    logger.info(
      { externalSkillCount: this.externalSkills.length, totalTools: this.ctx.tools.length },
      'External skills initialization complete'
    );
  }

  /**
   * Get IDs of all loaded external skills (for web API / UI).
   */
  getExternalSkillNames(): string[] {
    return this.externalSkills.map((s) => s.manifest.id);
  }

  /**
   * Get full metadata for all loaded external skills (for web API).
   */
  getExternalSkills(): LoadedExternalSkill[] {
    return this.externalSkills;
  }

  getTools(): Tool[] {
    return this.ctx.tools;
  }

  getDefinitions(): ToolDefinition[] {
    return this.ctx.toolDefinitions;
  }

  /**
   * Get the set of disabled tool names for a bot (from config.bots[].disabledTools).
   */
  getDisabledSet(botId: string): Set<string> {
    const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
    return new Set(botConfig?.disabledTools ?? []);
  }

  /**
   * Get the full excluded set for a bot: disabledTools + disabledSkills + dynamic scope exclusions.
   */
  private getExcludedSet(botId: string): Set<string> {
    const disabled = this.getDisabledSet(botId);

    // Expand disabledSkills → individual tool names
    const botConfig = this.ctx.config.bots.find((b) => b.id === botId);
    const disabledSkills = botConfig?.disabledSkills ?? [];
    if (disabledSkills.length > 0) {
      const skillSet = new Set(disabledSkills);
      for (const [toolName, skillId] of this.externalToolToSkill) {
        if (skillSet.has(skillId)) {
          disabled.add(toolName);
        }
      }
    }

    if (!this.dynamicToolRegistry) return disabled;
    const dynamicExcluded = this.dynamicToolRegistry.getExcludedNamesForBot(botId);
    if (dynamicExcluded.size === 0) return disabled;
    const merged = new Set(disabled);
    for (const name of dynamicExcluded) merged.add(name);
    return merged;
  }

  /**
   * Get tool definitions filtered for a specific bot (respects disabledTools + dynamic scope).
   */
  getDefinitionsForBot(botId: string): ToolDefinition[] {
    const excluded = this.getExcludedSet(botId);
    if (excluded.size === 0) return this.ctx.toolDefinitions;
    return this.ctx.toolDefinitions.filter((d) => !excluded.has(d.function.name));
  }

  /**
   * Get tool definitions filtered by selected categories for a specific bot.
   * Uncategorized tools (external/dynamic) always pass through.
   * Falls back to getDefinitionsForBot() when categories is empty/undefined.
   */
  getDefinitionsByCategories(
    categories: ToolCategory[] | undefined,
    botId: string
  ): ToolDefinition[] {
    if (!categories || categories.length === 0) {
      return this.getDefinitionsForBot(botId);
    }
    const selectedCategories = new Set(categories);
    const baseDefs = this.getDefinitionsForBot(botId);
    return baseDefs.filter((d) => {
      const name = d.function.name;
      if (ALWAYS_INCLUDED_TOOLS.has(name)) return true;
      const category = TOOL_TO_CATEGORY.get(name);
      if (!category) return true; // uncategorized (external/dynamic) — always pass through
      return selectedCategories.has(category);
    });
  }

  /**
   * Get tool instances filtered for a specific bot (respects disabledTools + dynamic scope).
   */
  getToolsForBot(botId: string): Tool[] {
    const excluded = this.getExcludedSet(botId);
    if (excluded.size === 0) return this.ctx.tools;
    return this.ctx.tools.filter((t) => !excluded.has(t.definition.function.name));
  }

  /**
   * Get collaboration-safe tools filtered for a specific bot.
   * Combines collaboration exclusion + per-bot disabledTools + dynamic scope.
   */
  getCollaborationToolsForBot(botId: string): { tools: Tool[]; definitions: ToolDefinition[] } {
    const collabExcluded = new Set(['collaborate', 'delegate_to_bot']);
    const excluded = this.getExcludedSet(botId);
    const tools = this.ctx.tools.filter((t) => {
      const name = t.definition.function.name;
      return !collabExcluded.has(name) && !excluded.has(name);
    });
    const definitions = tools.map((t) => t.definition);
    return { tools, definitions };
  }

  /**
   * Create a tool executor callback for the Ollama client.
   * chatId and botId are injected into tool calls.
   * Disabled tools for the bot are rejected as a safety net.
   * Delegates to ToolExecutor for unified execution logic.
   */
  createExecutor(
    chatId: number,
    botId: string,
    userId?: string,
    tenantRoot?: string
  ): (name: string, args: Record<string, unknown>) => Promise<ToolResult> {
    const executor = new ToolExecutor(this.ctx, {
      botId,
      chatId,
      userId,
      tenantRoot,
      tools: this.getToolsForBot(botId),
      karmaService: this.karmaService,
    });
    return executor.createCallback();
  }

  /**
   * Get the dynamic tool store (for web API).
   */
  getDynamicToolStore(): DynamicToolStore | null {
    return this.dynamicToolStore;
  }

  /**
   * Get the dynamic tool registry (for web API approve/reject).
   */
  getDynamicToolRegistry(): DynamicToolRegistry | null {
    return this.dynamicToolRegistry;
  }

  /**
   * Get the agent proposal store (for web API).
   */
  getAgentProposalStore(): AgentProposalStore | null {
    return this.agentProposalStore;
  }

  /**
   * Remove all external skills belonging to a specific bot from runtime.
   * Clears tools from ctx.tools[], ctx.toolDefinitions[], externalSkills[], and externalToolToSkill.
   * Returns the list of removed skill IDs.
   */
  clearExternalSkillsForBot(botId: string): string[] {
    const toRemove = this.externalSkills.filter((s) => s.botName === botId);
    if (toRemove.length === 0) return [];

    const removedSkillIds = toRemove.map((s) => s.manifest.id);
    const removedToolNames = new Set<string>();

    for (const [toolName, skillId] of this.externalToolToSkill) {
      if (removedSkillIds.includes(skillId)) {
        removedToolNames.add(toolName);
        this.externalToolToSkill.delete(toolName);
      }
    }

    this.ctx.tools = this.ctx.tools.filter(
      (t) => !removedToolNames.has(t.definition.function.name)
    );
    this.ctx.toolDefinitions.length = 0;
    this.ctx.toolDefinitions.push(...this.ctx.tools.map((t) => t.definition));

    this.externalSkills = this.externalSkills.filter((s) => s.botName !== botId);

    this.ctx.logger.info(
      { botId, removedSkillIds, removedToolCount: removedToolNames.size },
      'Cleared external skills for bot'
    );

    return removedSkillIds;
  }

  /**
   * Get tools available to collaboration targets (excludes collaborate and delegate_to_bot).
   */
  getCollaborationTools(): { tools: Tool[]; definitions: ToolDefinition[] } {
    const excluded = new Set(['collaborate', 'delegate_to_bot']);
    const tools = this.ctx.tools.filter((t) => !excluded.has(t.definition.function.name));
    const definitions = tools.map((t) => t.definition);
    return { tools, definitions };
  }
}
