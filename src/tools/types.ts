import type { z } from 'zod';
import type { Logger } from '../logger';

/**
 * OpenAI-compatible function/tool definition (what Ollama expects)
 * Extended with optional outputSchema for structured validation
 * and maxRetries for automatic retry on transient failures
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
  /**
   * Optional Zod schema for validating tool output.
   * When provided, the tool's result will be validated against this schema.
   * Validation failures are returned to the LLM with detailed error messages
   * to enable retry with corrected output.
   */
  outputSchema?: z.ZodType<unknown>;
  /**
   * Maximum number of retry attempts for transient execution failures.
   * When a tool throws an exception or returns an error result, the executor
   * will retry up to this many times, including the error feedback in context.
   * Default: 0 (no retries)
   */
  maxRetries?: number;
}

/**
 * A tool call parsed from the LLM response
 */
export interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * Result returned by a tool's execute() method
 */
export interface ToolResult {
  success: boolean;
  content: string;
  /**
   * Why a failed call failed, when the tool can tell.
   * - `error`     — the tool itself broke or was misused (default when absent).
   * - `blocked`   — a third party refused the request (bot challenge, 403, 429).
   *                 Not the bot's fault: the executor does not charge karma for it.
   * - `not-found` — the target does not exist (404/410). Usually a guessed path,
   *                 so it still counts as a tool error.
   */
  failureKind?: ToolFailureKind;
}

export type ToolFailureKind = 'error' | 'blocked' | 'not-found';

/**
 * A complete tool: its schema definition + execution logic
 */
export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult>;
}

/**
 * Callback type used by the Ollama client to execute tool calls
 */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Wrap tool output with markers so the LLM knows it's external/untrusted content
 */
export function wrapExternalContent(content: string): string {
  return `<<<EXTERNAL_UNTRUSTED_CONTENT>>>\n${content}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>`;
}
