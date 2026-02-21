import type { Logger } from '../logger';
import type { z } from 'zod';

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
}

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
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>
) => Promise<ToolResult>;

/**
 * Wrap tool output with markers so the LLM knows it's external/untrusted content
 */
export function wrapExternalContent(content: string): string {
  return `<<<EXTERNAL_UNTRUSTED_CONTENT>>>\n${content}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>`;
}
