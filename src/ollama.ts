import type { OllamaConfig } from './config';
import { createLoopDetector } from './core/loop-detector';
import { NativeToolStrategy } from './core/native-tool-strategy';
import { runToolLoop } from './core/tool-runner';
import type { Logger } from './logger';
import type { ToolCall, ToolDefinition, ToolExecutor } from './tools/types';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  images?: string[]; // base64 images for vision models
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolExecutor?: ToolExecutor;
  maxToolRounds?: number;
  /** @internal Prevent recursive fallback loops */
  _skipFallbacks?: boolean;
}

export interface GenerateOptions {
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** @internal Prevent recursive fallback loops */
  _skipFallbacks?: boolean;
}

export interface OllamaResponse {
  model: string;
  response: string;
  done: boolean;
}

interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: ToolCall[];
  };
  done: boolean;
}

export class OllamaClient {
  constructor(
    private config: OllamaConfig,
    private logger: Logger
  ) {}

  /**
   * Generate text using Ollama
   */
  async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    const model = options.model || this.config.models.primary;
    const startMs = Date.now();

    try {
      this.logger.debug(
        { model, prompt: prompt.slice(0, 100), timeoutMs: this.config.timeout },
        'Generating with Ollama'
      );

      const response = await fetch(`${this.config.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.config.timeout),
        body: JSON.stringify({
          model,
          prompt,
          system: options.system,
          stream: false,
          options: {
            temperature: options.temperature,
            num_predict: options.maxTokens,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const data: OllamaResponse = await response.json();
      this.logger.debug(
        { model, response: data.response.slice(0, 100), elapsedMs: Date.now() - startMs },
        'Generated response'
      );

      return data.response;
    } catch (error) {
      const elapsedMs = Date.now() - startMs;

      // If already in a fallback call, don't recurse into fallbacks again
      if (options._skipFallbacks) {
        throw error;
      }

      this.logger.warn(
        { err: error, model, elapsedMs, configuredTimeoutMs: this.config.timeout },
        'Primary model failed, trying fallbacks'
      );

      // Try fallback models with reduced timeout
      const fallbacks = this.config.models.fallbacks || [];
      const savedTimeout = this.config.timeout;
      for (const fallback of fallbacks) {
        try {
          this.logger.debug({ fallback }, 'Trying fallback model');
          const fallbackTimeout = Math.min(this.config.timeout, 60_000);
          this.config.timeout = fallbackTimeout;
          const result = await this.generate(prompt, {
            ...options,
            model: fallback,
            _skipFallbacks: true,
          });
          this.config.timeout = savedTimeout;
          return result;
        } catch (fallbackError) {
          this.logger.debug({ err: fallbackError, fallback }, 'Fallback model failed');
        }
      }
      this.config.timeout = savedTimeout;

      this.logger.error({ err: error }, 'All Ollama models failed');
      throw new Error(`Failed to generate response: ${error}`);
    }
  }

  /**
   * Chat with Ollama using message history.
   * Supports an agentic tool-calling loop when tools + toolExecutor are provided.
   */
  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const model = options.model || this.config.models.primary;
    const hasTools = options.tools && options.tools.length > 0 && options.toolExecutor;
    const startMs = Date.now();

    try {
      this.logger.debug(
        { model, messageCount: messages.length, hasTools, timeoutMs: this.config.timeout },
        'Chat with Ollama'
      );

      // If tools are provided, delegate to the generic tool loop
      if (hasTools) {
        const maxRounds = options.maxToolRounds ?? 5;
        const strategy = new NativeToolStrategy(
          this,
          this.config.baseUrl,
          this.logger,
          this.config.timeout
        );
        return await runToolLoop(
          strategy,
          messages,
          {
            maxRounds,
            tools: options.tools!,
            toolExecutor: options.toolExecutor!,
            logger: this.logger,
            loopDetector: createLoopDetector(maxRounds),
          },
          options
        );
      }

      // Simple path: no tools, single chat call
      const strategy = new NativeToolStrategy(
        this,
        this.config.baseUrl,
        this.logger,
        this.config.timeout
      );
      const result = await strategy.chat(messages, options);
      this.logger.debug(
        { model, response: (result.content || '').slice(0, 100), elapsedMs: Date.now() - startMs },
        'Chat response'
      );
      return result.content || '';
    } catch (error) {
      const elapsedMs = Date.now() - startMs;

      // If already in a fallback call, don't recurse into fallbacks again
      if (options._skipFallbacks) {
        throw error;
      }

      this.logger.warn(
        { err: error, model, elapsedMs, configuredTimeoutMs: this.config.timeout },
        'Primary model failed for chat, trying fallbacks'
      );

      const fallbacks = this.config.models.fallbacks || [];
      const savedTimeout = this.config.timeout;
      for (const fallback of fallbacks) {
        try {
          this.logger.debug({ fallback }, 'Trying fallback model for chat');
          const fallbackTimeout = Math.min(this.config.timeout, 60_000);
          this.config.timeout = fallbackTimeout;
          const result = await this.chat(messages, {
            ...options,
            model: fallback,
            _skipFallbacks: true,
          });
          this.config.timeout = savedTimeout;
          return result;
        } catch (fallbackError) {
          this.logger.debug({ err: fallbackError, fallback }, 'Fallback model failed for chat');
        }
      }
      this.config.timeout = savedTimeout;

      this.logger.error({ err: error }, 'All Ollama models failed for chat');
      throw new Error(`Failed to chat: ${error}`);
    }
  }

  /**
   * Generate embeddings for text using Ollama
   */
  async embed(text: string, model: string): Promise<{ embedding: number[]; model: string }> {
    if (!model) {
      throw new Error('Embedding model not configured (soul.search.embeddingModel is empty)');
    }
    const embeddingModel = model;
    const startMs = Date.now();

    try {
      this.logger.debug({ model: embeddingModel, textLength: text.length }, 'Generating embedding');

      const response = await fetch(`${this.config.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.config.timeout),
        body: JSON.stringify({
          model: embeddingModel,
          input: text,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama embed API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as { model: string; embeddings: number[][] };
      const embedding = data.embeddings[0];

      if (!embedding || embedding.length === 0) {
        throw new Error('Empty embedding returned from Ollama');
      }

      return { embedding, model: data.model };
    } catch (error) {
      const elapsedMs = Date.now() - startMs;
      this.logger.error(
        { err: error, model: embeddingModel, elapsedMs },
        'Failed to generate embedding'
      );
      throw error;
    }
  }

  /**
   * Check if Ollama is available
   */
  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.status}`);
      }

      const data = await response.json();
      return data.models?.map((m: { name: string }) => m.name) || [];
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to list Ollama models');
      throw error;
    }
  }
}
