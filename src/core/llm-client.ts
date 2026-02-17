import type { Logger } from '../logger';
import type { OllamaClient, ChatMessage, ChatOptions } from '../ollama';
import { claudeGenerate } from '../claude-cli';

export interface LLMGenerateOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMChatOptions extends ChatOptions {}

export interface LLMClient {
  readonly backend: 'ollama' | 'claude-cli';
  generate(prompt: string, opts?: LLMGenerateOptions): Promise<string>;
  chat(messages: ChatMessage[], opts?: LLMChatOptions): Promise<string>;
}

/**
 * Thin wrapper delegating to existing OllamaClient.
 */
export class OllamaLLMClient implements LLMClient {
  readonly backend = 'ollama' as const;

  constructor(private ollama: OllamaClient) {}

  generate(prompt: string, opts?: LLMGenerateOptions): Promise<string> {
    return this.ollama.generate(prompt, opts);
  }

  chat(messages: ChatMessage[], opts?: LLMChatOptions): Promise<string> {
    return this.ollama.chat(messages, opts);
  }
}

/**
 * Wraps claudeGenerate(). chat() formats messages into a single prompt.
 * Logs warning if tools are requested (not supported by Claude CLI).
 */
export class ClaudeCliLLMClient implements LLMClient {
  readonly backend = 'claude-cli' as const;

  constructor(
    private claudePath: string,
    private timeout: number,
    private logger: Logger,
  ) {}

  async generate(prompt: string, opts?: LLMGenerateOptions): Promise<string> {
    const fullPrompt = opts?.system
      ? `${opts.system}\n\n${prompt}`
      : prompt;

    return claudeGenerate(fullPrompt, {
      claudePath: this.claudePath,
      timeout: this.timeout,
      logger: this.logger,
    });
  }

  async chat(messages: ChatMessage[], opts?: LLMChatOptions): Promise<string> {
    if (opts?.tools && opts.tools.length > 0) {
      this.logger.warn('Claude CLI does not support tool calling — ignoring tools');
    }

    // Serialize messages into a single prompt
    const parts: string[] = [];
    let system: string | undefined;

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = msg.content;
      } else {
        const label = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'Tool';
        parts.push(`${label}: ${msg.content}`);
      }
    }

    return this.generate(parts.join('\n\n'), { system });
  }
}

/**
 * Tries primary, catches error → falls back.
 * If tools are requested and primary is claude-cli, routes directly to fallback.
 */
export class LLMClientWithFallback implements LLMClient {
  readonly backend: 'ollama' | 'claude-cli';

  constructor(
    private primary: LLMClient,
    private fallback: LLMClient,
    private logger: Logger,
  ) {
    this.backend = primary.backend;
  }

  async generate(prompt: string, opts?: LLMGenerateOptions): Promise<string> {
    try {
      return await this.primary.generate(prompt, opts);
    } catch (err) {
      this.logger.warn({ err, backend: this.primary.backend }, 'LLM primary failed, falling back');
      return this.fallback.generate(prompt, opts);
    }
  }

  async chat(messages: ChatMessage[], opts?: LLMChatOptions): Promise<string> {
    // Smart routing: if tools requested and primary is claude-cli, skip to fallback
    if (opts?.tools && opts.tools.length > 0 && this.primary.backend === 'claude-cli') {
      this.logger.debug('Tool-calling request routed directly to fallback (Ollama)');
      return this.fallback.chat(messages, opts);
    }

    try {
      return await this.primary.chat(messages, opts);
    } catch (err) {
      this.logger.warn({ err, backend: this.primary.backend }, 'LLM chat primary failed, falling back');
      return this.fallback.chat(messages, opts);
    }
  }
}

export interface CreateLLMClientOptions {
  llmBackend?: 'ollama' | 'claude-cli';
  claudePath?: string;
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
  logger: Logger,
): LLMClient {
  const ollamaLLM = new OllamaLLMClient(ollamaClient);

  if (opts.llmBackend === 'claude-cli') {
    const claudeLLM = new ClaudeCliLLMClient(
      opts.claudePath || 'claude',
      opts.claudeTimeout ?? 90_000,
      logger,
    );
    return new LLMClientWithFallback(claudeLLM, ollamaLLM, logger);
  }

  return ollamaLLM;
}
