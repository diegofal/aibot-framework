import type { ChatMessage, ChatOptions, OllamaClient } from '../ollama';
import { ollamaUsage } from '../ollama';
import type { ToolCall } from '../tools/types';
import type { TokenUsage } from './llm-client';
import type { ToolCallingStrategy } from './tool-runner';

/**
 * ToolCallingStrategy that wraps OllamaClient for a single round of chat.
 * Returns content + parsed tool_calls from the native Ollama response.
 */
export class NativeToolStrategy implements ToolCallingStrategy {
  constructor(
    private ollama: OllamaClient,
    private baseUrl: string,
    private logger: { debug: (...args: unknown[]) => void },
    private timeout = 300_000
  ) {}

  async chat(
    messages: ChatMessage[],
    opts: ChatOptions
  ): Promise<{ content: string; toolCalls?: ToolCall[]; usage?: TokenUsage }> {
    const model = opts.model;
    if (!model) throw new Error('NativeToolStrategy: model is required but was not provided');
    const startMs = Date.now();

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      options: {
        temperature: opts.temperature,
        num_predict: opts.maxTokens,
      },
    };

    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
    }

    this.logger.debug(
      { model, timeoutMs: this.timeout, messageCount: messages.length },
      'NativeToolStrategy: fetch starting'
    );

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.timeout),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      model: string;
      message: { content: string; tool_calls?: ToolCall[] };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    this.logger.debug(
      { model, elapsedMs: Date.now() - startMs },
      'NativeToolStrategy: fetch completed'
    );

    return {
      content: data.message.content || '',
      toolCalls: data.message.tool_calls,
      usage: ollamaUsage(data.model, data.prompt_eval_count, data.eval_count),
    };
  }
}
