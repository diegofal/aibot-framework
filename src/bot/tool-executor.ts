import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from '../logger';
import type { Tool, ToolDefinition, ToolResult } from '../tools/types';
import type { BotContext } from './types';
import { z } from 'zod';
import { EventEmitter } from 'events';

/**
 * Record of a tool execution for logging/auditing purposes.
 */
export interface ToolExecutionRecord {
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  result: string;
  durationMs?: number;
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
 * Observable events emitted by ToolExecutor.
 */
export interface ToolExecutorEvents {
  'tool:start': ToolStartEvent;
  'tool:end': ToolEndEvent;
  'tool:error': ToolErrorEvent;
}

/**
 * Options for configuring a ToolExecutor instance.
 */
export interface ToolExecutorOptions {
  /** Bot ID for _botId injection */
  botId: string;
  /** Chat ID for _chatId injection */
  chatId: number;
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

  constructor(
    private ctx: BotContext,
    private options: ToolExecutorOptions
  ) {
    super();
    this.logger = options.logger ?? ctx.logger;
    this.tools = options.tools ?? ctx.tools;

    // Build disabled set: config + explicit override
    if (options.disabledTools) {
      this.disabledTools = options.disabledTools;
    } else {
      const botConfig = ctx.config.bots.find((b) => b.id === options.botId);
      this.disabledTools = new Set(botConfig?.disabledTools ?? []);
    }
  }

  /**
   * Execute a single tool call with full lifecycle management.
   * Returns the tool result with execution metadata.
   */
  async execute(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
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

    // Check if tool is disabled
    if (this.disabledTools.has(name)) {
      this.logger.warn({ tool: name, botId }, 'Disabled tool requested');
      const errorMsg = `Tool "${name}" is not available`;
      this.emit('tool:error', {
        toolName: name,
        args,
        error: errorMsg,
        phase: 'lookup',
        botId,
        chatId,
        timestamp: Date.now(),
      });
      const result: ToolExecutionResult = {
        success: false,
        content: errorMsg,
        toolName: name,
        args,
        durationMs: Date.now() - startMs,
      };
      this.logExecution(name, args, false, result.content, result.durationMs);
      this.emit('tool:end', {
        toolName: name,
        args,
        success: false,
        result: errorMsg,
        durationMs: result.durationMs,
        retryAttempts: 0,
        botId,
        chatId,
        timestamp: Date.now(),
      });
      return result;
    }

    // Find the tool
    const tool = this.tools.find((t) => t.definition.function.name === name);
    if (!tool) {
      this.logger.warn({ tool: name }, 'Unknown tool requested');
      const errorMsg = `Unknown tool: ${name}`;
      const durationMs = Date.now() - startMs;
      this.emit('tool:error', {
        toolName: name,
        args,
        error: errorMsg,
        phase: 'lookup',
        botId,
        chatId,
        timestamp: Date.now(),
      });
      const result: ToolExecutionResult = {
        success: false,
        content: errorMsg,
        toolName: name,
        args,
        durationMs,
      };
      this.logExecution(name, args, false, result.content, durationMs);
      this.emit('tool:end', {
        toolName: name,
        args,
        success: false,
        result: errorMsg,
        durationMs,
        retryAttempts: 0,
        botId,
        chatId,
        timestamp: Date.now(),
      });
      return result;
    }

    // Apply optional tool filter (for collaboration)
    if (this.options.toolFilter && !this.options.toolFilter(tool)) {
      this.logger.warn({ tool: name, botId }, 'Tool filtered out by collaboration filter');
      const errorMsg = `Tool "${name}" is not available in this context`;
      const durationMs = Date.now() - startMs;
      this.emit('tool:error', {
        toolName: name,
        args,
        error: errorMsg,
        phase: 'lookup',
        botId,
        chatId,
        timestamp: Date.now(),
      });
      const result: ToolExecutionResult = {
        success: false,
        content: errorMsg,
        toolName: name,
        args,
        durationMs,
      };
      this.logExecution(name, args, false, result.content, durationMs);
      this.emit('tool:end', {
        toolName: name,
        args,
        success: false,
        result: errorMsg,
        durationMs,
        retryAttempts: 0,
        botId,
        chatId,
        timestamp: Date.now(),
      });
      return result;
    }

    // Get retry configuration
    const maxRetries = tool.definition.maxRetries ?? 0;

    // Execute with retry loop
    let lastError: string | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const attemptStartMs = Date.now();

      // Inject context arguments + retry feedback on subsequent attempts
      const effectiveArgs: Record<string, unknown> = {
        ...args,
        _chatId: chatId,
        _botId: botId,
      };

      // Per-bot workDir: resolve file paths and exec cwd
      const botConfigForWorkDir = this.ctx.config.bots.find((b) => b.id === botId);
      const workDir = botConfigForWorkDir?.workDir
        ?? (this.ctx.config.productions?.baseDir
          ? `${this.ctx.config.productions.baseDir}/${botId}`
          : undefined);
      let originalPathForProductions: string | undefined;
      if (workDir) {
        mkdirSync(workDir, { recursive: true });

        if (['file_read', 'file_write', 'file_edit'].includes(name) && typeof effectiveArgs.path === 'string') {
          originalPathForProductions = effectiveArgs.path as string;
          effectiveArgs.path = resolve(workDir, effectiveArgs.path as string);
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
          // Productions: log successful file operations
          if (
            this.ctx.productionsService &&
            ['file_write', 'file_edit'].includes(name)
          ) {
            const ps = this.ctx.productionsService;
            if (ps.isEnabled(botId)) {
              const logPath = originalPathForProductions ?? (args.path as string);
              ps.logProduction({
                timestamp: new Date().toISOString(),
                botId,
                tool: name,
                path: logPath,
                action: name === 'file_write' ? ((args as any).append ? 'edit' : 'create') : 'edit',
                description: `${name}: ${logPath}`,
                size: typeof (args as any).content === 'string' ? ((args as any).content as string).length : 0,
                trackOnly: ps.isTrackOnly(botId),
              });
            }
          }

          // Success! Return result with retry count
          const durationMs = Date.now() - startMs;
          const result: ToolExecutionResult = {
            ...validatedResult,
            toolName: name,
            args,
            durationMs,
            retryAttempts: attempt,
          };
          this.logExecution(name, args, true, validatedResult.content, durationMs);
          this.emit('tool:end', {
            toolName: name,
            args,
            success: true,
            result: validatedResult.content,
            durationMs,
            retryAttempts: attempt,
            botId,
            chatId,
            timestamp: Date.now(),
          });
          return result;
        }

        // Check if this was a tool error (not a validation error)
        // Tool errors should pass through without retry attempts
        if (!toolResult.success) {
          const durationMs = Date.now() - startMs;
          const errorMsg = validatedResult.content;
          this.emit('tool:error', {
            toolName: name,
            args,
            error: errorMsg,
            phase: 'execution',
            botId,
            chatId,
            timestamp: Date.now(),
          });
          const result: ToolExecutionResult = {
            success: false,
            content: errorMsg,
            toolName: name,
            args,
            durationMs,
            retryAttempts: attempt,
          };
          this.logExecution(name, args, false, result.content, durationMs);
          this.emit('tool:end', {
            toolName: name,
            args,
            success: false,
            result: errorMsg,
            durationMs,
            retryAttempts: attempt,
            botId,
            chatId,
            timestamp: Date.now(),
          });
          return result;
        }

        // Validation failure - treat as retryable error if we have retries left
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
          // Wait before retry with exponential backoff
          await this.delay(this.calculateBackoff(attempt));
          continue;
        }

        // No retries left - return validation error
        const durationMs = Date.now() - startMs;
        const errorMsg = `Validation failed after ${attempt + 1} attempt(s): ${lastError}`;
        const result: ToolExecutionResult = {
          success: false,
          content: errorMsg,
          toolName: name,
          args,
          durationMs,
          retryAttempts: attempt,
        };
        this.logExecution(name, args, false, result.content, durationMs);
        this.emit('tool:end', {
          toolName: name,
          args,
          success: false,
          result: errorMsg,
          durationMs,
          retryAttempts: attempt,
          botId,
          chatId,
          timestamp: Date.now(),
        });
        return result;

      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.error({ tool: name, botId, attempt, error: err }, 'Tool execution error');

        // If we have retries left, emit error and continue to next attempt
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

        // No retries left - return final error (emit final error + end)
        const durationMs = Date.now() - startMs;
        const errorMsg = `Tool execution failed after ${attempt + 1} attempt(s): ${lastError}`;
        this.emit('tool:error', {
          toolName: name,
          args,
          error: lastError,
          phase: 'execution',
          botId,
          chatId,
          timestamp: Date.now(),
        });
        const result: ToolExecutionResult = {
          success: false,
          content: errorMsg,
          toolName: name,
          args,
          durationMs,
          retryAttempts: attempt,
        };
        this.logExecution(name, args, false, errorMsg, durationMs);
        this.emit('tool:end', {
          toolName: name,
          args,
          success: false,
          result: errorMsg,
          durationMs,
          retryAttempts: attempt,
          botId,
          chatId,
          timestamp: Date.now(),
        });
        return result;
      }
    }

    // Should never reach here, but TypeScript requires a return
    const durationMs = Date.now() - startMs;
    return {
      success: false,
      content: 'Unexpected execution path',
      toolName: name,
      args,
      durationMs,
      retryAttempts: maxRetries,
    };
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
    return Math.min(1000 * Math.pow(2, attempt - 1), 10000);
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
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
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
        const issues = validationError.errors.map(
          (e) => `${e.path.join('.')}: ${e.message}`
        );
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
  createCallback(): (
    name: string,
    args: Record<string, unknown>
  ) => Promise<ToolResult> {
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
export function createToolExecutor(
  ctx: BotContext,
  options: ToolExecutorOptions
): ToolExecutor {
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
