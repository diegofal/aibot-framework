import {
  type ModelCandidate,
  ProviderCooldownTracker,
  resolveCandidatesFromConfig,
  runWithModelFallback,
} from '../bot/model-failover';
import {
  type FailoverReason,
  classifyFailoverReason,
  shouldAbortChain,
} from '../bot/model-failover/failover-error';
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
  /**
   * Token-by-token streaming chat. Optional — returns undefined when the
   * backend does not support streaming (e.g. Claude CLI).
   * Does NOT support tool calling — use non-streaming chat() when tools are needed.
   */
  chatStream?(messages: ChatMessage[], opts?: LLMChatOptions): AsyncGenerator<string, LLMResponse>;
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

  async *chatStream(
    messages: ChatMessage[],
    opts?: LLMChatOptions
  ): AsyncGenerator<string, LLMResponse> {
    return yield* this.ollama.chatStream(messages, opts);
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

  /** Format a message's content including image markers for Claude CLI (no native vision). */
  private formatMessageContent(msg: ChatMessage): string {
    let text = msg.content;
    if (msg.images && msg.images.length > 0) {
      text += `\n[${msg.images.length} image(s) attached — Claude CLI does not support inline vision; images are available via Ollama vision models]`;
    }
    return text;
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
          parts.push(`${label}: ${this.formatMessageContent(msg)}`);
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
        parts.push(`${label}: ${this.formatMessageContent(msg)}`);
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
  reason?: FailoverReason;
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
      const classified = classifyFailoverReason(err);
      const reason = classified?.reason ?? 'unknown';

      // Permanent errors (context_length, format) — rethrow without falling back
      if (shouldAbortChain(reason)) {
        this.logger.warn(
          { err, backend: this.primary.backend, reason },
          'LLM primary failed with permanent error, not falling back'
        );
        throw classified ?? err;
      }

      this.logger.warn(
        { err, backend: this.primary.backend, reason },
        'LLM primary failed, falling back'
      );
      this.onFallback?.({
        primaryBackend: this.primary.backend,
        fallbackBackend: this.fallback.backend,
        error: err instanceof Error ? err.message : String(err),
        method: 'generate',
        reason,
      });
      return this.fallback.generate(prompt, opts);
    }
  }

  async chat(messages: ChatMessage[], opts?: LLMChatOptions): Promise<LLMResponse> {
    try {
      return await this.primary.chat(messages, opts);
    } catch (err) {
      const classified = classifyFailoverReason(err);
      const reason = classified?.reason ?? 'unknown';

      // Permanent errors (context_length, format) — rethrow without falling back
      if (shouldAbortChain(reason)) {
        this.logger.warn(
          { err, backend: this.primary.backend, reason },
          'LLM chat primary failed with permanent error, not falling back'
        );
        throw classified ?? err;
      }

      this.logger.warn(
        { err, backend: this.primary.backend, reason },
        'LLM chat primary failed, falling back'
      );
      this.onFallback?.({
        primaryBackend: this.primary.backend,
        fallbackBackend: this.fallback.backend,
        error: err instanceof Error ? err.message : String(err),
        method: 'chat',
        reason,
      });
      return this.fallback.chat(messages, opts);
    }
  }
}

/**
 * Multi-candidate failover LLM client using the model-failover orchestrator.
 * Replaces the binary primary/fallback pattern with an ordered candidate chain,
 * error classification, cooldown tracking, and smart skip/abort logic.
 */
export class FailoverLLMClient implements LLMClient {
  readonly backend: 'ollama' | 'claude-cli';
  onFallback?: (event: FallbackEvent) => void;

  private candidates: ModelCandidate[];
  private cooldownTracker: ProviderCooldownTracker;
  private clientFactory: (backend: string, model?: string) => LLMClient;

  constructor(
    private primary: LLMClient,
    private fallback: LLMClient,
    private logger: Logger,
    candidates: ModelCandidate[],
    cooldownTracker: ProviderCooldownTracker
  ) {
    this.backend = primary.backend;
    this.candidates = candidates;
    this.cooldownTracker = cooldownTracker;
    this.clientFactory = (backend: string, _model?: string) => {
      // Simple: return primary or fallback based on backend match
      if (backend === primary.backend) return primary;
      return fallback;
    };
  }

  async generate(prompt: string, opts?: LLMGenerateOptions): Promise<LLMResponse> {
    const result = await runWithModelFallback<LLMResponse>({
      candidates: this.candidates,
      run: async (backend, model) => {
        const client = this.clientFactory(backend, model);
        return client.generate(prompt, { ...opts, model });
      },
      onError: ({ attempt, index }) => {
        if (index > 0) {
          this.onFallback?.({
            primaryBackend: (this.candidates[0]?.backend as any) ?? this.primary.backend,
            fallbackBackend: attempt.backend as any,
            error: attempt.error,
            method: 'generate',
            reason: attempt.reason ?? undefined,
          });
        }
        this.logger.warn(
          {
            backend: attempt.backend,
            model: attempt.model,
            error: attempt.error,
            reason: attempt.reason,
          },
          `LLM failover: candidate ${index} failed`
        );
      },
      onSkip: ({ candidate, cooldown }) => {
        this.logger.info(
          { backend: candidate.backend, model: candidate.model, remainingMs: cooldown.remainingMs },
          'LLM failover: skipping cooled-down candidate'
        );
      },
      cooldownTracker: this.cooldownTracker,
    });
    return result.result;
  }

  async chat(messages: ChatMessage[], opts?: LLMChatOptions): Promise<LLMResponse> {
    const result = await runWithModelFallback<LLMResponse>({
      candidates: this.candidates,
      run: async (backend, model) => {
        const client = this.clientFactory(backend, model);
        return client.chat(messages, { ...opts });
      },
      onError: ({ attempt, index }) => {
        if (index > 0) {
          this.onFallback?.({
            primaryBackend: (this.candidates[0]?.backend as any) ?? this.primary.backend,
            fallbackBackend: attempt.backend as any,
            error: attempt.error,
            method: 'chat',
            reason: attempt.reason ?? undefined,
          });
        }
        this.logger.warn(
          {
            backend: attempt.backend,
            model: attempt.model,
            error: attempt.error,
            reason: attempt.reason,
          },
          `LLM failover: candidate ${index} failed`
        );
      },
      onSkip: ({ candidate, cooldown }) => {
        this.logger.info(
          { backend: candidate.backend, model: candidate.model, remainingMs: cooldown.remainingMs },
          'LLM failover: skipping cooled-down candidate'
        );
      },
      cooldownTracker: this.cooldownTracker,
    });
    return result.result;
  }
}

export interface CreateLLMClientOptions {
  llmBackend?: 'ollama' | 'claude-cli';
  claudePath?: string;
  claudeModel?: string;
  claudeTimeout?: number;
  failoverConfig?: {
    enabled?: boolean;
    candidates?: Array<{ backend: string; model?: string }>;
    cooldownEnabled?: boolean;
  };
  cooldownTracker?: ProviderCooldownTracker;
}

/**
 * Factory: builds the right LLMClient based on skill config.
 * - 'claude-cli' + failover enabled → FailoverLLMClient (multi-candidate chain)
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

    // Use FailoverLLMClient when failover config is provided and enabled
    if (opts.failoverConfig?.enabled) {
      const candidates = resolveCandidatesFromConfig({
        failover: opts.failoverConfig,
        ollama: { models: { primary: ollamaClient?.toString?.() } },
        claudeCli: { enabled: true, model: opts.claudeModel },
      });

      if (candidates.length > 1) {
        const cooldownTracker = opts.cooldownTracker ?? new ProviderCooldownTracker();
        return new FailoverLLMClient(claudeLLM, ollamaLLM, logger, candidates, cooldownTracker);
      }
    }

    return new LLMClientWithFallback(claudeLLM, ollamaLLM, logger);
  }

  return ollamaLLM;
}
