import type { Logger } from '../logger';

/**
 * OpenAI-compatible function/tool definition (what Ollama expects)
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
