import { claudeGenerate, claudeGenerateWithTools } from '../claude-cli';
import type { Logger } from '../logger';
import type { ChatMessage, ChatOptions, OllamaClient } from '../ollama';

export interface TokenUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  text: string;
  usage?: TokenUsage;
}

export interface LLMGenerateOptions {
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMChatOptions extends ChatOptions {}

export interface LLMClient {
  readonly backend: 'ollama' | 'claude-cli';
  generate(prompt: string, opts?: LLMGenerateOptions): Promise<LLMResponse>;
  chat(messages: ChatMessage[], opts?: LLMChatOptions): Promise<LLMResponse>;
}

/**
 * Thin wrapper delegating to existing OllamaClient.
 */
export class OllamaLLMClient implements LLMClient {
  readonly backend = 'ollama' as const;

  constructor(private ollama: OllamaClient) {}

  generate(prompt: string, opts?: LLMGenerateOptions): Promise<LLMResponse> {
    return this.ollama.generate(prompt, opts);
  }

  chat(messages: ChatMessage[], opts?: LLMChatOptions): Promise<LLMResponse> {
    return this.ollama.chat(messages, opts);
  }
}

/**
 * Wraps claudeGenerate(). chat() formats messages into a single prompt.
 * Tool calling handled natively via MCP bridge (claudeGenerateWithTools).
 */
export class ClaudeCliLLMClient implements LLMClient {
  readonly backend = 'claude-cli' as const;

  constructor(
    private claudePath: string,
    private timeout: number,
    private logger: Logger,
    private model?: string
  ) {}

  async generate(prompt: string, opts?: LLMGenerateOptions): Promise<LLMResponse> {
    const result = await claudeGenerate(prompt, {
      claudePath: this.claudePath,
      model: this.model,
      timeout: this.timeout,
      logger: this.logger,
      systemPrompt: opts?.system,
    });
    return { text: result.response, usage: result.usage };
  }

  async chat(messages: ChatMessage[], opts?: LLMChatOptions): Promise<LLMResponse> {
    const hasTools = opts?.tools && opts.tools.length > 0 && opts.toolExecutor;

    if (hasTools) {
      // Build a single prompt from the conversation for Claude CLI
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

      const result = await claudeGenerateWithTools(parts.join('\n\n'), {
        claudePath: this.claudePath,
        model: this.model,
        timeout: this.timeout,
        logger: this.logger,
        systemPrompt: system,
        tools: opts.tools ?? [],
        toolExecutor: opts.toolExecutor ?? (async () => ''),
      });

      return { text: result.response, usage: result.usage };
    }

    // Simple path: no tools, single generate call
    const parts: string[] = [];
    let system: string | undefined;

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = msg.content;
      } else {
        const label =
          msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'Tool';
        parts.push(`${label}: ${msg.content}`);
      }
    }

    return this.generate(parts.join('\n\n'), { system });
  }
}

export interface FallbackEvent {
  primaryBackend: 'ollama' | 'claude-cli';
  fallbackBackend: 'ollama' | 'claude-cli';
  error: string;
  method: 'generate' | 'chat';
}

/**
 * Tries primary, catches error → falls back.
 */
export class LLMClientWithFallback implements LLMClient {
  readonly backend: 'ollama' | 'claude-cli';
  onFallback?: (event: FallbackEvent) => void;

  constructor(
    private primary: LLMClient,
    private fallback: LLMClient,
    private logger: Logger
  ) {
    this.backend = primary.backend;
  }

  async generate(prompt: string, opts?: LLMGenerateOptions): Promise<LLMResponse> {
    try {
      return await this.primary.generate(prompt, opts);
    } catch (err) {
      this.logger.warn({ err, backend: this.primary.backend }, 'LLM primary failed, falling back');
      this.onFallback?.({
        primaryBackend: this.primary.backend,
        fallbackBackend: this.fallback.backend,
        error: err instanceof Error ? err.message : String(err),
        method: 'generate',
      });
      return this.fallback.generate(prompt, opts);
    }
  }

  async chat(messages: ChatMessage[], opts?: LLMChatOptions): Promise<LLMResponse> {
    try {
      return await this.primary.chat(messages, opts);
    } catch (err) {
      this.logger.warn(
        { err, backend: this.primary.backend },
        'LLM chat primary failed, falling back'
      );
      this.onFallback?.({
        primaryBackend: this.primary.backend,
        fallbackBackend: this.fallback.backend,
        error: err instanceof Error ? err.message : String(err),
        method: 'chat',
      });
      return this.fallback.chat(messages, opts);
    }
  }
}

export interface CreateLLMClientOptions {
  llmBackend?: 'ollama' | 'claude-cli';
  claudePath?: string;
  claudeModel?: string;
  claudeTimeout?: number;
}

/**
 * Factory: builds the right LLMClient based on skill config.
 * - 'claude-cli' → LLMClientWithFallback(claude, ollama)
 * - default → OllamaLLMClient(ollama)
 */
export function createLLMClient(
  opts: CreateLLMClientOptions,
  ollamaClient: OllamaClient,
  logger: Logger
): LLMClient {
  const ollamaLLM = new OllamaLLMClient(ollamaClient);

  if (opts.llmBackend === 'claude-cli') {
    const claudeLLM = new ClaudeCliLLMClient(
      opts.claudePath || 'claude',
      opts.claudeTimeout ?? 300_000,
      logger,
      opts.claudeModel
    );
    return new LLMClientWithFallback(claudeLLM, ollamaLLM, logger);
  }

  return ollamaLLM;
}
