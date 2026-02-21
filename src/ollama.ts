import type { OllamaConfig } from './config';
import type { Logger } from './logger';
import type { ToolDefinition, ToolCall, ToolExecutor } from './tools/types';
import { runToolLoop } from './core/tool-runner';
import { NativeToolStrategy } from './core/native-tool-strategy';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  images?: string[];  // base64 images for vision models
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolExecutor?: ToolExecutor;
  maxToolRounds?: number;
}

export interface GenerateOptions {
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
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

    try {
      this.logger.debug({ model, prompt: prompt.slice(0, 100) }, 'Generating with Ollama');

      const response = await fetch(`${this.config.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      this.logger.debug({ model, response: data.response.slice(0, 100) }, 'Generated response');

      return data.response;
    } catch (error) {
      this.logger.warn({ err: error, model }, 'Primary model failed, trying fallbacks');

      // Try fallback models
      const fallbacks = this.config.models.fallbacks || [];
      for (const fallback of fallbacks) {
        try {
          this.logger.debug({ fallback }, 'Trying fallback model');
          return await this.generate(prompt, { ...options, model: fallback });
        } catch (fallbackError) {
          this.logger.debug({ err: fallbackError, fallback }, 'Fallback model failed');
          continue;
        }
      }

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

    try {
      this.logger.debug({ model, messageCount: messages.length, hasTools }, 'Chat with Ollama');

      // If tools are provided, delegate to the generic tool loop
      if (hasTools) {
        const strategy = new NativeToolStrategy(this, this.config.baseUrl, this.logger);
        return await runToolLoop(strategy, messages, {
          maxRounds: options.maxToolRounds ?? 5,
          tools: options.tools!,
          toolExecutor: options.toolExecutor!,
          logger: this.logger,
        }, options);
      }

      // Simple path: no tools, single chat call
      const strategy = new NativeToolStrategy(this, this.config.baseUrl, this.logger);
      const result = await strategy.chat(messages, options);
      this.logger.debug({ model, response: (result.content || '').slice(0, 100) }, 'Chat response');
      return result.content || '';
    } catch (error) {
      this.logger.warn({ err: error, model }, 'Primary model failed for chat, trying fallbacks');

      const fallbacks = this.config.models.fallbacks || [];
      for (const fallback of fallbacks) {
        try {
          this.logger.debug({ fallback }, 'Trying fallback model for chat');
          return await this.chat(messages, { ...options, model: fallback });
        } catch (fallbackError) {
          this.logger.debug({ err: fallbackError, fallback }, 'Fallback model failed for chat');
          continue;
        }
      }

      this.logger.error({ err: error }, 'All Ollama models failed for chat');
      throw new Error(`Failed to chat: ${error}`);
    }
  }

  /**
   * Generate embeddings for text using Ollama
   */
  async embed(text: string, model?: string): Promise<{ embedding: number[]; model: string }> {
    const embeddingModel = model || 'nomic-embed-text';

    try {
      this.logger.debug({ model: embeddingModel, textLength: text.length }, 'Generating embedding');

      const response = await fetch(`${this.config.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: embeddingModel,
          input: text,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama embed API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { model: string; embeddings: number[][] };
      const embedding = data.embeddings[0];

      if (!embedding || embedding.length === 0) {
        throw new Error('Empty embedding returned from Ollama');
      }

      return { embedding, model: data.model };
    } catch (error) {
      this.logger.error({ err: error, model: embeddingModel }, 'Failed to generate embedding');
      throw error;
    }
  }

  /**
   * Check if Ollama is available
   */
  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`);
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
      const response = await fetch(`${this.config.baseUrl}/api/tags`);
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
