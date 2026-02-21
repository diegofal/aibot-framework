import type { Logger } from '../logger';
import type { ChatMessage, ChatOptions } from '../ollama';
import type { ToolCall, ToolDefinition } from '../tools/types';
import type { ToolCallingStrategy } from './tool-runner';
import { claudeGenerate } from '../claude-cli';

const TOOL_CALL_REGEX = /<tool_call>([\s\S]*?)<\/tool_call>/g;

/**
 * Build the tool instruction block injected into the system prompt.
 * Teaches Claude CLI the <tool_call> XML protocol.
 */
function buildToolInstructionBlock(tools: ToolDefinition[]): string {
  const toolDescriptions = tools.map((t) => {
    const fn = t.function;
    const params = fn.parameters.properties;
    const required = fn.parameters.required ?? [];

    const paramLines = Object.entries(params).map(([name, schema]) => {
      const s = schema as { type?: string; description?: string };
      const req = required.includes(name) ? ' (required)' : ' (optional)';
      return `    - ${name}: ${s.type ?? 'any'}${req} — ${s.description ?? ''}`;
    });

    return `  ${fn.name}: ${fn.description}\n    Parameters:\n${paramLines.join('\n')}`;
  });

  return `## Available Tools

You have access to the following tools. To call a tool, emit a <tool_call> tag with a JSON object containing "name" and "arguments":

<tool_call>{"name":"tool_name","arguments":{"param":"value"}}</tool_call>

You may include thinking/text before and after tool calls. Multiple tool calls per response are supported.
Only call tools that are listed below — do not invent tool names.

${toolDescriptions.join('\n\n')}`;
}

/**
 * Parse <tool_call> tags from text output.
 */
function parseToolCalls(text: string, logger: Logger): ToolCall[] {
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  TOOL_CALL_REGEX.lastIndex = 0;

  while ((match = TOOL_CALL_REGEX.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name && typeof parsed.name === 'string') {
        calls.push({
          function: {
            name: parsed.name,
            arguments: parsed.arguments ?? {},
          },
        });
      }
    } catch (err) {
      logger.warn({ raw: match[1].slice(0, 200), err }, 'Failed to parse <tool_call> tag');
    }
  }

  return calls;
}

/**
 * Strip <tool_call> tags from text to get the "content" portion.
 */
function stripToolCalls(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}

/**
 * Text-based tool calling strategy for Claude CLI.
 * Injects tool instructions into the system prompt and parses
 * <tool_call> XML tags from Claude's text output.
 */
export class TextToolStrategy implements ToolCallingStrategy {
  constructor(
    private claudePath: string,
    private timeout: number,
    private logger: Logger,
  ) {}

  async chat(
    messages: ChatMessage[],
    opts: ChatOptions,
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    // Serialize messages into a single prompt, injecting tool block into system
    const parts: string[] = [];
    let system: string | undefined;

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = msg.content;
      } else if (msg.role === 'tool') {
        parts.push(`Tool Result: ${msg.content}`);
      } else {
        const label = msg.role === 'user' ? 'User' : 'Assistant';
        parts.push(`${label}: ${msg.content}`);
      }
    }

    // Inject tool instruction block into system prompt if tools are available
    if (opts.tools && opts.tools.length > 0) {
      const toolBlock = buildToolInstructionBlock(opts.tools);
      system = system ? `${system}\n\n${toolBlock}` : toolBlock;
    }

    const prompt = parts.join('\n\n');

    const output = await claudeGenerate(prompt, {
      claudePath: this.claudePath,
      timeout: this.timeout,
      logger: this.logger,
      systemPrompt: system,
    });

    // Parse tool calls from output
    const toolCalls = opts.tools && opts.tools.length > 0
      ? parseToolCalls(output, this.logger)
      : [];

    const content = toolCalls.length > 0 ? stripToolCalls(output) : output;

    return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  }
}
