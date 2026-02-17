import type { Logger } from '../logger';
import type { Tool, ToolDefinition, ToolResult } from '../tools/types';
import type { BotContext } from './types';

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
import { createSaveMemoryTool, createUpdateIdentityTool, createUpdateSoulTool } from '../tools/soul';
import { createWebFetchTool } from '../tools/web-fetch';
import { createWebSearchTool } from '../tools/web-search';

export class ToolRegistry {
  constructor(private ctx: BotContext) {}

  /**
   * Initialize all tools based on config. Populates ctx.tools and ctx.toolDefinitions.
   * Delegation/collaboration tools receive lazy callbacks to avoid circular deps.
   */
  initializeAll(
    getDelegationHandler: () => import('../tools/delegate').DelegationHandler,
    getCollaborateHandler: () => import('../tools/collaborate').CollaborateHandler,
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
        createUpdateIdentityTool(soulResolver)
      );
      logger.info('Soul tools initialized');
    }

    // Memory search tools
    if (this.ctx.searchEnabled && this.ctx.memoryManager) {
      tools.push(
        createMemorySearchTool(this.ctx.memoryManager),
        createMemoryGetTool(this.ctx.memoryManager)
      );
      logger.info('Memory search tools initialized');
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
        createFileReadTool(fileConfig),
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

  getTools(): Tool[] {
    return this.ctx.tools;
  }

  getDefinitions(): ToolDefinition[] {
    return this.ctx.toolDefinitions;
  }

  /**
   * Create a tool executor callback for the Ollama client.
   * chatId and botId are injected into tool calls.
   */
  createExecutor(
    chatId: number,
    botId: string
  ): (name: string, args: Record<string, unknown>) => Promise<ToolResult> {
    return async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      const tool = this.ctx.tools.find((t) => t.definition.function.name === name);
      if (!tool) {
        this.ctx.logger.warn({ tool: name }, 'Unknown tool requested by LLM');
        return { success: false, content: `Unknown tool: ${name}` };
      }
      const effectiveArgs = { ...args, _chatId: chatId, _botId: botId };
      return tool.execute(effectiveArgs, this.ctx.logger);
    };
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
