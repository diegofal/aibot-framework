import type { Logger } from '../logger';
import type { Tool, ToolDefinition, ToolResult } from '../tools/types';
import type { BotContext } from './types';
import { ToolExecutor } from './tool-executor';
import { discoverSkillDirs, loadExternalSkill, type LoadedExternalSkill } from '../core/external-skill-loader';
import { adaptExternalTool } from '../core/external-tool-adapter';

import { createCollaborateTool } from '../tools/collaborate';
import { createCronTool } from '../tools/cron';
import { createDatetimeTool } from '../tools/datetime';
import { createDelegationTool } from '../tools/delegate';
import { createExecTool } from '../tools/exec';
import { createImproveTool } from '../tools/improve';
import { createFileEditTool, createFileReadTool, createFileWriteTool } from '../tools/file';
import { createMemoryGetTool } from '../tools/memory-get';
import { createPhoneCallTool } from '../tools/phone-call';
import { createMemorySearchTool } from '../tools/memory-search';
import { createProcessTool } from '../tools/process';
import { createCreateToolTool } from '../tools/create-tool';
import { DynamicToolStore } from '../tools/dynamic-tool-store';
import { DynamicToolRegistry } from './dynamic-tool-registry';
import { createGoalsTool } from '../tools/goals';
import { createSaveMemoryTool, createUpdateIdentityTool, createUpdateSoulTool } from '../tools/soul';
import { createWebFetchTool } from '../tools/web-fetch';
import { createCoreMemoryTools } from '../tools/core-memory';
import { createRecallMemoryTool } from '../tools/recall-memory';
import { createWebSearchTool } from '../tools/web-search';
import { createAskHumanTool, type AskHumanDeps } from '../tools/ask-human';
import { createBrowserTool } from '../tools/browser';
import { createProductionLogTool } from '../tools/production-log';

export class ToolRegistry {
  private dynamicToolRegistry: DynamicToolRegistry | null = null;
  private dynamicToolStore: DynamicToolStore | null = null;
  /** Loaded external skills metadata (for per-bot filtering + web API) */
  private externalSkills: LoadedExternalSkill[] = [];
  /** Maps namespaced tool name → originating skill ID */
  private externalToolToSkill: Map<string, string> = new Map();

  constructor(private ctx: BotContext) {}

  /**
   * Initialize all tools based on config. Populates ctx.tools and ctx.toolDefinitions.
   * Delegation/collaboration tools receive lazy callbacks to avoid circular deps.
   */
  initializeAll(
    getDelegationHandler: () => import('../tools/delegate').DelegationHandler,
    getCollaborateHandler: () => import('../tools/collaborate').CollaborateHandler,
    askHumanDeps?: AskHumanDeps,
  ): void {
    const { config, logger } = this.ctx;
    const tools = this.ctx.tools;

    // Web tools
    const webToolsConfig = config.webTools;
    if (webToolsConfig?.enabled) {
      if (webToolsConfig.search?.apiKey) {
        tools.push(createWebSearchTool({
          apiKey: webToolsConfig.search.apiKey,
          maxResults: webToolsConfig.search.maxResults,
          timeout: webToolsConfig.search.timeout,
          cacheTtlMs: webToolsConfig.search.cacheTtlMs,
        }));
        logger.info('Web search tool initialized');
      }

      if (webToolsConfig.fetch) {
        tools.push(createWebFetchTool({
          maxContentLength: webToolsConfig.fetch.maxContentLength,
          timeout: webToolsConfig.fetch.timeout,
          cacheTtlMs: webToolsConfig.fetch.cacheTtlMs,
        }));
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
      tools.push(createExecTool({
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
      }));
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
      tools.push(createProcessTool({
        maxSessions: config.processTools.maxSessions,
        finishedTtlMs: config.processTools.finishedTtlMs,
        maxOutputChars: config.processTools.maxOutputChars,
      }));
      logger.info('Process tool initialized');
    }

    // Browser tool
    if (config.browserTools?.enabled) {
      tools.push(createBrowserTool({ ...config.browserTools }));
      logger.info('Browser tool initialized');
    }

    // Datetime tool
    if (config.datetime.enabled) {
      tools.push(createDatetimeTool({
        timezone: config.datetime.timezone,
        locale: config.datetime.locale,
      }));
      logger.info('Datetime tool initialized');
    }

    // Phone call tool
    if (config.phoneCall?.enabled) {
      tools.push(createPhoneCallTool({
        accountSid: config.phoneCall.accountSid,
        authToken: config.phoneCall.authToken,
        fromNumber: config.phoneCall.fromNumber,
        defaultNumber: config.phoneCall.defaultNumber,
        language: config.phoneCall.language,
        voice: config.phoneCall.voice,
        contactsFile: config.phoneCall.contactsFile,
      }));
      logger.info('Phone call tool initialized');
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
      tools.push(createImproveTool({
        claudePath: config.improve.claudePath,
        timeout: config.improve.timeout,
        maxOutputLength: config.improve.maxOutputLength,
        soulDir: config.improve.soulDir,
        allowedFocus: config.improve.allowedFocus,
      }));
      logger.info('Improve tool initialized');
    }

    // ask_human tool
    if (askHumanDeps) {
      tools.push(createAskHumanTool(askHumanDeps));
      logger.info('ask_human tool initialized');
    }

    // Productions tool
    if (this.ctx.productionsService) {
      tools.push(createProductionLogTool(this.ctx.productionsService));
      logger.info('read_production_log tool initialized');
    }

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
   * Discover, load, and register external skills from configured skill folders.
   * Each skill's tools are namespaced (skillId_toolName) and added to ctx.tools[].
   */
  async initializeExternalSkills(): Promise<void> {
    const { config, logger } = this.ctx;
    const paths = config.skillsFolders?.paths ?? [];
    if (paths.length === 0) return;

    const skillDirs = discoverSkillDirs(paths);
    if (skillDirs.length === 0) {
      logger.info({ paths }, 'No external skills found in configured folders');
      return;
    }

    logger.info({ count: skillDirs.length, paths }, 'Discovered external skill directories');

    for (const dir of skillDirs) {
      try {
        const loaded = await loadExternalSkill(dir, logger);
        const { manifest, handlers, warnings } = loaded;

        if (warnings.length > 0) {
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
          );

          this.ctx.tools.push(tool);
          this.externalToolToSkill.set(tool.definition.function.name, manifest.id);
          toolCount++;
        }

        this.externalSkills.push(loaded);
        logger.info(
          { skillId: manifest.id, toolCount, dir },
          'External skill loaded',
        );
      } catch (err) {
        logger.error({ dir, err }, 'Failed to load external skill');
      }
    }

    // Re-sync definitions after adding external tools
    this.ctx.toolDefinitions.length = 0;
    this.ctx.toolDefinitions.push(...this.ctx.tools.map((t) => t.definition));

    logger.info(
      { externalSkillCount: this.externalSkills.length, totalTools: this.ctx.tools.length },
      'External skills initialization complete',
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
    botId: string
  ): (name: string, args: Record<string, unknown>) => Promise<ToolResult> {
    const executor = new ToolExecutor(this.ctx, {
      botId,
      chatId,
      tools: this.getToolsForBot(botId),
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
   * Get tools available to collaboration targets (excludes collaborate and delegate_to_bot).
   */
  getCollaborationTools(): { tools: Tool[]; definitions: ToolDefinition[] } {
    const excluded = new Set(['collaborate', 'delegate_to_bot']);
    const tools = this.ctx.tools.filter((t) => !excluded.has(t.definition.function.name));
    const definitions = tools.map((t) => t.definition);
    return { tools, definitions };
  }
}
