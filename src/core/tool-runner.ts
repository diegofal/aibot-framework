import type { Logger } from '../logger';
import type { ChatMessage, ChatOptions } from '../ollama';
import type { ToolCall, ToolDefinition, ToolExecutor } from '../tools/types';
import type { LLMResponse, TokenUsage } from './llm-client';
import type { LoopBreakDetector, LoopDetector } from './loop-detector';

/**
 * Abstraction for an LLM that can return tool calls.
 * Each strategy wraps a specific backend (Ollama native, Claude CLI text-based, etc.).
 */
export interface ToolCallingStrategy {
  chat(
    messages: ChatMessage[],
    opts: ChatOptions
  ): Promise<{ content: string; toolCalls?: ToolCall[]; usage?: TokenUsage }>;
}

export interface LoopBreakInfo {
  botId?: string;
  conversationId?: string;
  caller?: string;
  round: number;
  totalCalls?: number;
  detector?: LoopBreakDetector;
  message?: string;
}

export interface ToolRunnerOptions {
  maxRounds: number;
  tools: ToolDefinition[];
  toolExecutor: ToolExecutor;
  logger: Logger;
  loopDetector?: LoopDetector;
  /**
   * If provided, the loop will detect deliverable completion and stop early
   * when the response signals the deliverable is done (no more tool calls,
   * summary-like response).
   */
  deliverable?: string;
  /** Return a clean summarization instead of the `[Loop stopped: …]` marker on detector break. */
  cleanBreak?: boolean;
  /** Identifying context for the loop break — folded into the warn payload and onLoopBreak callback. */
  loopContext?: { botId?: string; conversationId?: string; caller?: string };
  /** Observer hook fired once when the loop detector breaks. Listener errors are swallowed. */
  onLoopBreak?: (info: LoopBreakInfo) => void;
}

/** Accumulate token usage across multiple rounds, merging by model. */
export function mergeTokenUsage(
  accumulated: TokenUsage | undefined,
  next: TokenUsage | undefined
): TokenUsage | undefined {
  if (!next) return accumulated;
  if (!accumulated) return { ...next };
  return {
    model: next.model,
    promptTokens: accumulated.promptTokens + next.promptTokens,
    completionTokens: accumulated.completionTokens + next.completionTokens,
    totalTokens: accumulated.totalTokens + next.totalTokens,
  };
}

const MEMORY_TOOL_NAMES = new Set(['save_memory', 'core_memory_append', 'core_memory_replace']);

const LOOP_BREAK_FALLBACK =
  'I reached the tool-call limit for this turn. Send "continue" and I will pick up where I left off.';

const PHANTOM_SAVE_PATTERN =
  /(?:guardado|guard[oé]|saved|stored|lo guardo|lo anoto|anotado)[\s,.].*?(?:memoria|memory|core.memory)/i;

/**
 * Detect when the LLM claims to have saved to memory in its text response
 * without actually calling any memory tool — a "phantom save".
 */
export function detectPhantomMemorySave(response: string, calledTools: Set<string>): boolean {
  const usedMemoryTool = [...calledTools].some((t) => MEMORY_TOOL_NAMES.has(t));
  if (usedMemoryTool) return false;
  return PHANTOM_SAVE_PATTERN.test(response);
}

/**
 * Generic agentic tool loop. Calls strategy.chat() in rounds,
 * executing tool calls and feeding results back until the LLM
 * produces a text-only response or rounds are exhausted.
 *
 * Returns an LLMResponse with accumulated token usage across all rounds.
 */
export async function runToolLoop(
  strategy: ToolCallingStrategy,
  messages: ChatMessage[],
  opts: ToolRunnerOptions,
  chatOptions: ChatOptions
): Promise<LLMResponse> {
  const workingMessages = [...messages];
  const calledTools = new Set<string>();
  let accumulatedUsage: TokenUsage | undefined;

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
        const info: LoopBreakInfo = {
          ...(opts.loopContext ?? {}),
          round,
          totalCalls: check.totalCalls,
          detector: check.detector,
          message: check.message,
        };
        opts.logger.warn(info, 'Tool loop detector: breaking');
        if (opts.onLoopBreak) {
          try {
            opts.onLoopBreak(info);
          } catch (err) {
            opts.logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'onLoopBreak listener threw'
            );
          }
        }

        if (opts.cleanBreak) {
          workingMessages.push({
            role: 'system',
            content: `You have reached the tool-call safety limit (${check.message}). Do NOT call any more tools. Summarize what you accomplished so far and what remains.`,
          });
          const final = await strategy.chat(workingMessages, {
            ...chatOptions,
            tools: undefined,
            toolExecutor: undefined,
          });
          accumulatedUsage = mergeTokenUsage(accumulatedUsage, final.usage);
          return {
            text: final.content || LOOP_BREAK_FALLBACK,
            usage: accumulatedUsage,
            stopReason: 'loop-break',
          };
        }

        const lastContent = workingMessages.filter((m) => m.role === 'assistant').pop()?.content;
        return {
          text: `${lastContent || ''}\n\n[Loop stopped: ${check.message}]`,
          usage: accumulatedUsage,
          stopReason: 'loop-break',
        };
      }
      if (check.action === 'warn' && check.message) {
        workingMessages.push({
          role: 'system',
          content: `WARNING: ${check.message}. Try a different approach.`,
        });
      }
    }

    const result = await strategy.chat(workingMessages, roundOpts);
    accumulatedUsage = mergeTokenUsage(accumulatedUsage, result.usage);

    // If there are tool calls and it's not the last round, execute them
    if (!isLastRound && result.toolCalls && result.toolCalls.length > 0) {
      opts.logger.info(
        { round, toolCalls: result.toolCalls.map((tc) => tc.function.name) },
        'LLM requested tool calls'
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
        calledTools.add(name);
        opts.logger.debug({ tool: name, args }, 'Executing tool call');

        const toolResult = await opts.toolExecutor(name, args);

        opts.logger.debug(
          { tool: name, success: toolResult.success, contentLength: toolResult.content.length },
          'Tool call result'
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
      if (detectPhantomMemorySave(result.content, calledTools)) {
        opts.logger.warn(
          { responsePreview: result.content.slice(0, 200) },
          'Phantom memory save: LLM claimed to save to memory without calling any memory tool'
        );
      }
      return { text: result.content, usage: accumulatedUsage };
    }

    // Last round with empty content → fall through to exhaustion message
    if (isLastRound) {
      break;
    }

    return { text: '', usage: accumulatedUsage };
  }

  opts.logger.warn({ maxRounds: opts.maxRounds }, 'Tool loop exhausted without text response');
  return {
    text: 'I was unable to complete the request within the allowed number of steps.',
    usage: accumulatedUsage,
    stopReason: 'exhausted',
  };
}
