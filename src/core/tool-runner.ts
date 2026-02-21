import type { Logger } from '../logger';
import type { ToolDefinition, ToolCall, ToolExecutor } from '../tools/types';
import type { ChatMessage, ChatOptions } from '../ollama';
import type { LoopDetector } from './loop-detector';

/**
 * Abstraction for an LLM that can return tool calls.
 * Each strategy wraps a specific backend (Ollama native, Claude CLI text-based, etc.).
 */
export interface ToolCallingStrategy {
  chat(
    messages: ChatMessage[],
    opts: ChatOptions,
  ): Promise<{ content: string; toolCalls?: ToolCall[] }>;
}

export interface ToolRunnerOptions {
  maxRounds: number;
  tools: ToolDefinition[];
  toolExecutor: ToolExecutor;
  logger: Logger;
  loopDetector?: LoopDetector;
}

/**
 * Generic agentic tool loop. Calls strategy.chat() in rounds,
 * executing tool calls and feeding results back until the LLM
 * produces a text-only response or rounds are exhausted.
 */
export async function runToolLoop(
  strategy: ToolCallingStrategy,
  messages: ChatMessage[],
  opts: ToolRunnerOptions,
  chatOptions: ChatOptions,
): Promise<string> {
  const workingMessages = [...messages];

  for (let round = 0; round <= opts.maxRounds; round++) {
    const isLastRound = round === opts.maxRounds;

    // On last round, omit tools and inject a summarization prompt
    const roundOpts: ChatOptions = isLastRound
      ? { ...chatOptions, tools: undefined, toolExecutor: undefined }
      : chatOptions;

    if (isLastRound) {
      workingMessages.push({
        role: 'system',
        content:
          'You have reached the maximum number of tool call rounds. Do NOT call any more tools. Provide a concise summary of what you accomplished and any remaining work.',
      });
    }

    // Inject loop detector warning if needed
    if (opts.loopDetector && round > 0) {
      const check = opts.loopDetector.check();
      if (check.action === 'break') {
        opts.logger.warn({ round, message: check.message }, 'Tool loop detector: breaking');
        const lastContent = workingMessages
          .filter((m) => m.role === 'assistant')
          .pop()?.content;
        return (lastContent || '') + `\n\n[Loop stopped: ${check.message}]`;
      }
      if (check.action === 'warn' && check.message) {
        workingMessages.push({
          role: 'system',
          content: `WARNING: ${check.message}. Try a different approach.`,
        });
      }
    }

    const result = await strategy.chat(workingMessages, roundOpts);

    // If there are tool calls and it's not the last round, execute them
    if (!isLastRound && result.toolCalls && result.toolCalls.length > 0) {
      opts.logger.info(
        { round, toolCalls: result.toolCalls.map((tc) => tc.function.name) },
        'LLM requested tool calls',
      );

      // Push assistant message with tool_calls
      workingMessages.push({
        role: 'assistant',
        content: result.content || '',
        tool_calls: result.toolCalls,
      });

      // Execute each tool call
      for (const toolCall of result.toolCalls) {
        const { name, arguments: args } = toolCall.function;
        opts.logger.debug({ tool: name, args }, 'Executing tool call');

        const toolResult = await opts.toolExecutor(name, args);

        opts.logger.debug(
          { tool: name, success: toolResult.success, contentLength: toolResult.content.length },
          'Tool call result',
        );

        workingMessages.push({
          role: 'tool',
          content: toolResult.content,
        });

        // Record for loop detection
        if (opts.loopDetector) {
          opts.loopDetector.recordCall(name, args, toolResult.content);
        }
      }

      continue; // Next round
    }

    // No tool calls — return text response
    if (result.content) {
      return result.content;
    }

    // Last round with empty content → fall through to exhaustion message
    if (isLastRound) {
      break;
    }

    return '';
  }

  opts.logger.warn({ maxRounds: opts.maxRounds }, 'Tool loop exhausted without text response');
  return 'I was unable to complete the request within the allowed number of steps.';
}
