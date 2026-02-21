import type { OllamaClient, ChatMessage, ChatOptions } from '../ollama';
import type { ToolCall } from '../tools/types';
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
  ) {}

  async chat(
    messages: ChatMessage[],
    opts: ChatOptions,
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    const model = opts.model || 'llama3';

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

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      message: { content: string; tool_calls?: ToolCall[] };
    };

    return {
      content: data.message.content || '',
      toolCalls: data.message.tool_calls,
    };
  }
}
