import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { KarmaService } from '../karma/service';
import type { Logger } from '../logger';
import { ProductionsService } from '../productions/service';
import type { Tool, ToolDefinition, ToolResult } from '../tools/types';
import type { LoopDetectionResult, ToolLoopDetector } from './tool-loop-detector';
import type { BotContext } from './types';

/**
 * Record of a tool execution for logging/auditing purposes.
 */
export interface ToolExecutionRecord {
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  result: string;
  durationMs?: number;
  category?: string;
}

/**
 * Event payload for tool:start hook.
 * Emitted when a tool execution begins.
 */
export interface ToolStartEvent {
  toolName: string;
  args: Record<string, unknown>;
  botId: string;
  chatId: number;
  timestamp: number;
}

/**
 * Event payload for tool:end hook.
 * Emitted when a tool execution completes (success or failure).
 */
export interface ToolEndEvent {
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  result: string;
  durationMs: number;
  retryAttempts: number;
  botId: string;
  chatId: number;
  timestamp: number;
}

/**
 * Event payload for tool:error hook.
 * Emitted when a tool execution throws an error or fails validation.
 */
export interface ToolErrorEvent {
  toolName: string;
  args: Record<string, unknown>;
  error: string;
  phase: 'lookup' | 'validation' | 'execution';
  botId: string;
  chatId: number;
  timestamp: number;
}

/**
 * Event payload for loop detection events (warning or blocked).
 */
export interface ToolLoopEvent {
  toolName: string;
  args: Record<string, unknown>;
  detector: string;
  level: 'warning' | 'critical';
  count: number;
  message: string;
  botId: string;
  chatId: number;
  timestamp: number;
}

/**
 * Observable events emitted by ToolExecutor.
 */
export interface ToolExecutorEvents {
  'tool:start': ToolStartEvent;
  'tool:end': ToolEndEvent;
  'tool:error': ToolErrorEvent;
  'tool:loop-warning': ToolLoopEvent;
  'tool:loop-blocked': ToolLoopEvent;
}

/**
 * Options for configuring a ToolExecutor instance.
 */
export interface ToolExecutorOptions {
  /** Bot ID for _botId injection */
  botId: string;
  /** Chat ID for _chatId injection */
  chatId: number;
  /** User ID for _userId injection (per-user isolation) */
  userId?: string;
  /** Optional override of disabled tools (defaults to config lookup) */
  disabledTools?: Set<string>;
  /** Enable execution logging (for AgentLoop toolCallLog) */
  enableLogging?: boolean;
  /** Optional custom logger (defaults to ctx.logger) */
  logger?: Logger;
  /** Optional tool filter (for collaboration - excludes certain tools) */
  toolFilter?: (tool: Tool) => boolean;
  /** Optional tool list override (for collaboration) */
  tools?: Tool[];
  /** Optional karma service for quality gate penalties */
  karmaService?: KarmaService;
  /** Optional loop detector for agent-loop repetition protection */
  loopDetector?: ToolLoopDetector;
  /** Tenant root directory for path sandboxing (multi-tenant mode) */
  tenantRoot?: string;
}

/**
 * Result of a tool execution with metadata.
 */
export interface ToolExecutionResult extends ToolResult {
  toolName: string;
  args: Record<string, unknown>;
  durationMs: number;
  /**
   * Number of retry attempts made before final result.
   * 0 means first attempt succeeded.
   */
  retryAttempts?: number;
}

/**
 * Centralized tool execution engine.
 *
 * Encapsulates the common logic for:
 * - Tool lookup by name
 * - Disabled tool filtering
 * - Context injection (_chatId, _botId)
 * - Execution with error handling
 * - Optional logging and metrics
 *
 * Replaces duplicated logic in:
 * - AgentLoop.createAgentLoopExecutor()
 * - ToolRegistry.createExecutor()
 * - Collaboration.runVisibleTurn() inline executor
 * - Collaboration.collaborationStep() inline executor
 */
export class ToolExecutor extends EventEmitter {
  private disabledTools: Set<string>;
  private tools: Tool[];
  private logger: Logger;
  private executionLog: ToolExecutionRecord[] = [];
  private loopDetector: ToolLoopDetector | undefined;

  constructor(
    private ctx: BotContext,
    private options: ToolExecutorOptions
  ) {
    super();
    this.logger = options.logger ?? ctx.logger;
    this.tools = options.tools ?? ctx.tools;
    this.loopDetector = options.loopDetector;

    // Build disabled set: config + explicit override
    if (options.disabledTools) {
      this.disabledTools = options.disabledTools;
    } else {
      const botConfig = ctx.config.bots.find((b) => b.id === options.botId);
      this.disabledTools = new Set(botConfig?.disabledTools ?? []);
    }

    // Auto-bridge tool events to activity stream (if available)
    this.bridgeToActivityStream();
  }

  /**
   * Subscribe to own tool lifecycle events and publish to ctx.activityStream.
   * This ensures ALL ToolExecutor instances (agent-loop, conversation pipeline,
   * collaboration) automatically surface events in the activity stream.
   */
  private bridgeToActivityStream(): void {
    const stream = this.ctx.activityStream;
    if (!stream) return;

    this.on('tool:start', (e) =>
      stream.publish({
        type: 'tool:start',
        botId: e.botId,
        timestamp: e.timestamp,
        data: { toolName: e.toolName, args: e.args },
      })
    );
    this.on('tool:end', (e) => {
      stream.publish({
        type: 'tool:end',
        botId: e.botId,
        timestamp: e.timestamp,
        data: {
          toolName: e.toolName,
          success: e.success,
          durationMs: e.durationMs,
          result: e.result.slice(0, 300),
        },
      });

      // Record tool.called analytics for tenant bots
      const analyticsService = this.ctx.analyticsService;
      if (analyticsService) {
        const botConfig = this.ctx.config.bots.find((b) => b.id === e.botId);
        if (botConfig?.tenantId) {
          analyticsService.record({
            type: 'tool.called',
            tenantId: botConfig.tenantId,
            botId: e.botId,
            chatId: String(e.chatId),
            channelKind: 'unknown',
            data: {
              toolName: e.toolName,
              durationMs: e.durationMs,
              success: e.success,
            },
          });
        }
      }
    });
    this.on('tool:error', (e) =>
      stream.publish({
        type: 'tool:error',
        botId: e.botId,
        timestamp: e.timestamp,
        data: { toolName: e.toolName, error: e.error.slice(0, 300), phase: e.phase },
      })
    );
    this.on('tool:loop-warning', (e) =>
      stream.publish({
        type: 'tool:error',
        botId: e.botId,
        timestamp: e.timestamp,
        data: {
          toolName: e.toolName,
          error: `[loop-${e.level}] ${e.message}`.slice(0, 300),
          phase: 'loop-detection',
        },
      })
    );
    this.on('tool:loop-blocked', (e) =>
      stream.publish({
        type: 'tool:error',
        botId: e.botId,
        timestamp: e.timestamp,
        data: {
          toolName: e.toolName,
          error: `[loop-blocked] ${e.message}`.slice(0, 300),
          phase: 'loop-detection',
        },
      })
    );
  }

  /**
   * Build a failure result, emit error + end events, and log the execution.
   * @param emitError - The error string to emit in the tool:error event (may differ from content).
   */
  private buildFailResult(
    name: string,
    args: Record<string, unknown>,
    startMs: number,
    errorMsg: string,
    phase: 'lookup' | 'validation' | 'execution',
    retryAttempts = 0,
    emitError?: string
  ): ToolExecutionResult {
    const { botId, chatId } = this.options;
    const durationMs = Date.now() - startMs;
    this.emit('tool:error', {
      toolName: name,
      args,
      error: emitError ?? errorMsg,
      phase,
      botId,
      chatId,
      timestamp: Date.now(),
    });

    // Karma -1 per tool error (execution and validation phases)
    if (this.options.karmaService && (phase === 'execution' || phase === 'validation')) {
      const truncatedError = (emitError ?? errorMsg).slice(0, 120);
      this.options.karmaService.addEvent(
        botId,
        -1,
        `Tool error: ${name} — ${truncatedError}`,
        'tool'
      );
    }

    const result: ToolExecutionResult = {
      success: false,
      content: errorMsg,
      toolName: name,
      args,
      durationMs,
      retryAttempts,
    };
    this.logExecution(name, args, false, errorMsg, durationMs);
    this.emit('tool:end', {
      toolName: name,
      args,
      success: false,
      result: errorMsg,
      durationMs,
      retryAttempts,
      botId,
      chatId,
      timestamp: Date.now(),
    });
    return result;
  }

  /**
   * Execute a single tool call with full lifecycle management.
   * Returns the tool result with execution metadata.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const startMs = Date.now();
    const { botId, chatId } = this.options;

    // Emit start event
    this.emit('tool:start', {
      toolName: name,
      args,
      botId,
      chatId,
      timestamp: startMs,
    });

    // Loop detection pre-check (before any execution)
    let loopWarningMessage: string | undefined;
    if (this.loopDetector) {
      const loopCheck = this.loopDetector.check(name, args);
      if (loopCheck.stuck) {
        const loopEvent: ToolLoopEvent = {
          toolName: name,
          args,
          detector: loopCheck.detector,
          level: loopCheck.level,
          count: loopCheck.count,
          message: loopCheck.message,
          botId,
          chatId,
          timestamp: Date.now(),
        };

        if (loopCheck.level === 'critical') {
          this.emit('tool:loop-blocked', loopEvent);
          this.logger.error(
            { tool: name, botId, detector: loopCheck.detector, count: loopCheck.count },
            `Loop detector blocked tool: ${loopCheck.message}`
          );
          return this.buildFailResult(
            name,
            args,
            startMs,
            `BLOCKED by loop detection (${loopCheck.detector}): ${loopCheck.message}`,
            'execution'
          );
        }

        // Warning level: emit event but continue execution
        this.emit('tool:loop-warning', loopEvent);
        this.logger.warn(
          { tool: name, botId, detector: loopCheck.detector, count: loopCheck.count },
          `Loop detector warning: ${loopCheck.message}`
        );
        loopWarningMessage = loopCheck.message;
      }
    }

    // Check if tool is disabled
    if (this.disabledTools.has(name)) {
      this.logger.warn({ tool: name, botId }, 'Disabled tool requested');
      return this.buildFailResult(name, args, startMs, `Tool "${name}" is not available`, 'lookup');
    }

    // Find the tool
    const tool = this.tools.find((t) => t.definition.function.name === name);
    if (!tool) {
      this.logger.warn({ tool: name }, 'Unknown tool requested');
      return this.buildFailResult(name, args, startMs, `Unknown tool: ${name}`, 'lookup');
    }

    // Apply optional tool filter (for collaboration)
    if (this.options.toolFilter && !this.options.toolFilter(tool)) {
      this.logger.warn({ tool: name, botId }, 'Tool filtered out by collaboration filter');
      return this.buildFailResult(
        name,
        args,
        startMs,
        `Tool "${name}" is not available in this context`,
        'lookup'
      );
    }

    // Get retry configuration
    const maxRetries = tool.definition.maxRetries ?? 0;

    // Execute with retry loop
    let lastError: string | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Inject context arguments + retry feedback on subsequent attempts
      const effectiveArgs: Record<string, unknown> = {
        ...args,
        _chatId: chatId,
        _botId: botId,
        ...(this.options.userId ? { _userId: this.options.userId } : {}),
        ...(this.options.tenantRoot ? { _tenantRoot: this.options.tenantRoot } : {}),
      };

      // Per-bot workDir: resolve file paths and exec cwd
      const botConfigForWorkDir = this.ctx.config.bots.find((b) => b.id === botId);
      const workDir =
        botConfigForWorkDir?.workDir ??
        (this.ctx.config.productions?.baseDir
          ? `${this.ctx.config.productions.baseDir}/${botId}`
          : undefined);
      let originalPathForProductions: string | undefined;

      // Normalise path aliases (file_path, filepath, file → path) before workdir
      // resolution so the workdir prefix and productions logging both work
      // regardless of which alias the LLM used.
      if (
        ['file_read', 'file_write', 'file_edit'].includes(name) &&
        typeof effectiveArgs.path !== 'string'
      ) {
        for (const alias of ['file_path', 'filepath', 'file'] as const) {
          if (typeof effectiveArgs[alias] === 'string') {
            effectiveArgs.path = effectiveArgs[alias];
            break;
          }
        }
      }

      if (workDir) {
        mkdirSync(workDir, { recursive: true });
        effectiveArgs._workDir = workDir;

        if (
          ['file_read', 'file_write', 'file_edit'].includes(name) &&
          typeof effectiveArgs.path === 'string'
        ) {
          originalPathForProductions = effectiveArgs.path as string;

          // Strip redundant workDir prefix the LLM may include
          let filePath = effectiveArgs.path as string;
          const normWork = workDir.replace(/^\.\//, '');
          const normFile = filePath.replace(/^\.\//, '');
          if (normWork && normFile.startsWith(`${normWork}/`)) {
            filePath = normFile.slice(normWork.length + 1);
          }
          effectiveArgs.path = resolve(workDir, filePath);

          // Safety net: prevent file_write from creating subdirs (except archived/)
          if (name === 'file_write') {
            const resolved = effectiveArgs.path as string;
            const absWork = resolve(workDir);
            const rel = relative(absWork, resolved);
            if (rel.includes('/') && !rel.startsWith('archived/') && !rel.startsWith('..')) {
              const flat = join(absWork, basename(resolved));
              this.logger.warn(
                { tool: name, botId, original: resolved, flattened: flat },
                'Flattened nested path to root of workDir'
              );
              effectiveArgs.path = flat;
            }
          }
        }
        if (name === 'exec' && !effectiveArgs.workdir) {
          effectiveArgs.workdir = workDir;
        }
      }

      // Include previous error feedback for retry attempts
      if (attempt > 0 && lastError) {
        effectiveArgs._retryAttempt = attempt;
        effectiveArgs._previousError = lastError;
        this.logger.info(
          { tool: name, botId, attempt, maxRetries },
          'Retrying tool execution with error feedback'
        );
      }

      try {
        const toolResult = await tool.execute(effectiveArgs, this.logger);

        // Validate output against schema if defined
        const validatedResult = await this.validateOutput(tool, toolResult);

        if (validatedResult.success) {
          // Productions: log successful file operations with quality gate
          if (this.ctx.productionsService && ['file_write', 'file_edit'].includes(name)) {
            const ps = this.ctx.productionsService;
            if (ps.isEnabled(botId)) {
              const logPath =
                originalPathForProductions ?? (effectiveArgs.path as string | undefined);

              if (
                logPath &&
                !logPath.endsWith('/INDEX.md') &&
                logPath !== 'INDEX.md' &&
                !logPath.endsWith('/index.html') &&
                logPath !== 'index.html'
              ) {
                // file_write uses `content`, file_edit uses `new_text`
                const content =
                  name === 'file_edit'
                    ? typeof args.new_text === 'string'
                      ? args.new_text
                      : ''
                    : typeof args.content === 'string'
                      ? args.content
                      : '';

                // Extract first heading for better descriptions
                const firstHeading = content ? content.match(/^#+ (.+)$/m)?.[1] : null;
                const description = firstHeading ?? `${name}: ${logPath}`;

                if (!content) {
                  // No content to assess (e.g. missing args) — skip quality gate entirely
                  ps.logProduction({
                    timestamp: new Date().toISOString(),
                    botId,
                    tool: name,
                    path: logPath,
                    action: name === 'file_write' ? (args.append ? 'edit' : 'create') : 'edit',
                    description,
                    size: 0,
                    trackOnly: ps.isTrackOnly(botId),
                  });
                } else {
                  const quality = ProductionsService.assessContentQuality(content);

                  if (quality.isTemplate) {
                    this.logger.debug(
                      { botId, path: logPath, ratio: quality.ratio },
                      'Quality gate: skipping template production'
                    );
                    if (this.options.karmaService) {
                      this.options.karmaService.addEvent(
                        botId,
                        -3,
                        `Empty template detected in "${logPath}"`,
                        'production'
                      );
                    }
                  } else {
                    // Auto-number new files (non-append file_write only)
                    const finalPath =
                      name === 'file_write' && !args.append
                        ? ps.renumberFile(botId, logPath)
                        : logPath;

                    // Inject frontmatter for new .md files (non-append file_write)
                    if (name === 'file_write' && !args.append && finalPath.endsWith('.md')) {
                      try {
                        const absFilePath = join(ps.resolveDir(botId), finalPath);
                        if (existsSync(absFilePath)) {
                          const fileContent = readFileSync(absFilePath, 'utf-8');
                          const withFrontmatter = ProductionsService.injectFrontmatter(
                            fileContent,
                            absFilePath,
                            new Date().toISOString()
                          );
                          if (withFrontmatter !== fileContent) {
                            writeFileSync(absFilePath, withFrontmatter, 'utf-8');
                          }
                        }
                      } catch {
                        /* skip frontmatter injection errors */
                      }
                    }

                    ps.logProduction({
                      timestamp: new Date().toISOString(),
                      botId,
                      tool: name,
                      path: finalPath,
                      action: name === 'file_write' ? (args.append ? 'edit' : 'create') : 'edit',
                      description,
                      size: content.length,
                      trackOnly: ps.isTrackOnly(botId),
                    });
                  }
                }
              }
            }
          }

          // Record in loop detector
          if (this.loopDetector) {
            this.loopDetector.recordCall(name, args);
            this.loopDetector.recordOutcome(name, args, validatedResult.content);
          }

          // Inject loop warning into result content so LLM sees it
          const finalContent = loopWarningMessage
            ? `${validatedResult.content}\n\n[LOOP WARNING: ${loopWarningMessage}]`
            : validatedResult.content;

          // Success! Return result with retry count
          const durationMs = Date.now() - startMs;
          const result: ToolExecutionResult = {
            ...validatedResult,
            content: finalContent,
            toolName: name,
            args,
            durationMs,
            retryAttempts: attempt,
          };
          this.logExecution(name, args, true, finalContent, durationMs);
          this.emit('tool:end', {
            toolName: name,
            args,
            success: true,
            result: finalContent,
            durationMs,
            retryAttempts: attempt,
            botId,
            chatId,
            timestamp: Date.now(),
          });
          return result;
        }

        // Tool error (not validation) — pass through without retry
        if (!toolResult.success) {
          // Record errors in loop detector too
          if (this.loopDetector) {
            this.loopDetector.recordCall(name, args);
            this.loopDetector.recordOutcome(name, args, validatedResult.content);
          }
          return this.buildFailResult(
            name,
            args,
            startMs,
            validatedResult.content,
            'execution',
            attempt
          );
        }

        // Validation failure — retryable if we have retries left
        lastError = validatedResult.content;
        this.emit('tool:error', {
          toolName: name,
          args,
          error: lastError,
          phase: 'validation',
          botId,
          chatId,
          timestamp: Date.now(),
        });
        if (attempt < maxRetries) {
          this.logger.warn(
            { tool: name, botId, attempt, error: lastError },
            'Tool validation failed, will retry'
          );
          await this.delay(this.calculateBackoff(attempt));
          continue;
        }

        // No retries left — return validation error
        return this.buildFailResult(
          name,
          args,
          startMs,
          `Validation failed after ${attempt + 1} attempt(s): ${lastError}`,
          'validation',
          attempt
        );
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.error({ tool: name, botId, attempt, error: err }, 'Tool execution error');

        // Record thrown errors in loop detector
        if (this.loopDetector) {
          this.loopDetector.recordCall(name, args);
          this.loopDetector.recordOutcome(name, args, `error:${lastError}`);
        }

        // Retries left — emit error and continue
        if (attempt < maxRetries) {
          this.emit('tool:error', {
            toolName: name,
            args,
            error: lastError,
            phase: 'execution',
            botId,
            chatId,
            timestamp: Date.now(),
          });
          await this.delay(this.calculateBackoff(attempt));
          continue;
        }

        // No retries left — return final error
        return this.buildFailResult(
          name,
          args,
          startMs,
          `Tool execution failed after ${attempt + 1} attempt(s): ${lastError}`,
          'execution',
          attempt,
          lastError as Error
        );
      }
    }

    // Should never reach here, but TypeScript requires a return
    return this.buildFailResult(
      name,
      args,
      startMs,
      'Unexpected execution path',
      'execution',
      maxRetries
    );
  }

  /**
   * Calculate exponential backoff delay in ms.
   * Attempt 0: 0ms (immediate)
   * Attempt 1: 1000ms
   * Attempt 2: 2000ms
   * Attempt 3: 4000ms
   * Max: 10000ms
   */
  private calculateBackoff(attempt: number): number {
    if (attempt === 0) return 0;
    return Math.min(1000 * 2 ** (attempt - 1), 10000);
  }

  /**
   * Simple delay helper for async backoff.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Extended result type with validation metadata.
   */
  private validateOutput(
    tool: Tool,
    result: ToolResult
  ): ToolResult & { _validationError?: boolean } {
    const schema = tool.definition.outputSchema;
    if (!schema) {
      return result;
    }

    // Only validate successful outputs - errors pass through without retry
    if (!result.success) {
      return result;
    }

    try {
      // Parse content as JSON if it's a string that looks like JSON
      let data: unknown;
      if (typeof result.content === 'string') {
        const trimmed = result.content.trim();
        if (
          (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))
        ) {
          try {
            data = JSON.parse(trimmed);
          } catch {
            // If parsing fails, treat as raw string
            data = result.content;
          }
        } else {
          data = result.content;
        }
      } else {
        data = result.content;
      }

      // Validate against schema
      schema.parse(data);
      return result;
    } catch (validationError) {
      if (validationError instanceof z.ZodError) {
        const issues = validationError.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
        const errorMsg = `Output validation failed:\n${issues.join('\n')}`;

        this.logger.warn(
          { tool: tool.definition.function.name, issues: validationError.errors },
          'Tool output validation failed'
        );

        return {
          success: false,
          content: errorMsg,
        };
      }

      // Re-throw unexpected errors
      throw validationError;
    }
  }

  /**
   * Create the callback expected by LLMClient.chat().
   * This is the standard interface for tool execution in conversations.
   */
  createCallback(): (name: string, args: Record<string, unknown>) => Promise<ToolResult> {
    return async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      const result = await this.execute(name, args);
      // Return only the ToolResult part (without metadata)
      return {
        success: result.success,
        content: result.content,
      };
    };
  }

  /**
   * Get execution history (for AgentLoop logging).
   */
  getExecutionLog(): ToolExecutionRecord[] {
    return [...this.executionLog];
  }

  /**
   * Extract file paths created/edited during execution (file_write, file_edit).
   * Returns paths relative to workDir with optional sizes.
   */
  getFileOperations(): { path: string; size?: number }[] {
    const workDir = this.resolveWorkDir();
    return this.executionLog
      .filter((r) => r.success && ['file_write', 'file_edit'].includes(r.name))
      .map((r) => {
        const rawPath = r.args.path as string;
        if (!rawPath) return null;
        try {
          const absPath = workDir ? resolve(workDir, rawPath) : rawPath;
          const size = existsSync(absPath) ? statSync(absPath).size : undefined;
          return { path: rawPath, size };
        } catch {
          return { path: rawPath };
        }
      })
      .filter((f): f is { path: string; size?: number } => f !== null);
  }

  private resolveWorkDir(): string | undefined {
    const botConfig = this.ctx.config.bots.find((b) => b.id === this.options.botId);
    return (
      botConfig?.workDir ??
      (this.ctx.config.productions?.baseDir
        ? `${this.ctx.config.productions.baseDir}/${this.options.botId}`
        : undefined)
    );
  }

  /**
   * Clear execution history.
   */
  clearExecutionLog(): void {
    this.executionLog = [];
  }

  private logExecution(
    name: string,
    args: Record<string, unknown>,
    success: boolean,
    result: string,
    durationMs: number
  ): void {
    if (!this.options.enableLogging) return;

    // Truncate result for logging (same as AgentLoop did)
    const truncatedResult = result.length > 2000 ? result.slice(0, 2000) : result;

    this.executionLog.push({
      name,
      args,
      success,
      result: truncatedResult,
      durationMs,
    });
  }

  /**
   * Get tool definitions for the available tools (respecting filters).
   * Useful for building tool lists for LLM calls.
   */
  getDefinitions(): ToolDefinition[] {
    const filtered = this.tools.filter((t) => {
      if (this.disabledTools.has(t.definition.function.name)) return false;
      if (this.options.toolFilter) return this.options.toolFilter(t);
      return true;
    });
    return filtered.map((t) => t.definition);
  }

  /**
   * Check if a tool is available (not disabled and passes filter).
   */
  isToolAvailable(name: string): boolean {
    if (this.disabledTools.has(name)) return false;
    const tool = this.tools.find((t) => t.definition.function.name === name);
    if (!tool) return false;
    if (this.options.toolFilter) return this.options.toolFilter(tool);
    return true;
  }
}

/**
 * Factory function to create a ToolExecutor with common configurations.
 */
export function createToolExecutor(ctx: BotContext, options: ToolExecutorOptions): ToolExecutor {
  return new ToolExecutor(ctx, options);
}

/**
 * Create a collaboration-safe tool executor.
 * Excludes delegate_to_bot and collaborate tools.
 */
export function createCollaborationToolExecutor(
  ctx: BotContext,
  botId: string,
  chatId: number,
  options?: Omit<ToolExecutorOptions, 'botId' | 'chatId'>
): ToolExecutor {
  const excluded = new Set(['collaborate', 'delegate_to_bot']);
  return new ToolExecutor(ctx, {
    botId,
    chatId,
    ...options,
    toolFilter: (tool: Tool) => !excluded.has(tool.definition.function.name),
  });
}
