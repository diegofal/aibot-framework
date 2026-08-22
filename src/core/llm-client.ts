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
import { ALL_DISALLOWED_NATIVE_TOOLS } from '../bot/tool-permissions';
import { claudeGenerate, claudeGenerateWithTools } from '../claude-cli';
import type { Logger } from '../logger';
import type { ChatMessage, ChatOptions, OllamaClient } from '../ollama';

export interface TokenUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Backend that actually served the call. Callers log this rather than the
   * client's nominal backend: a wrapper can serve a claude-cli client's call
   * from Ollama, and the query log used to record the wrapper's backend with
   * the other backend's model.
   */
  backend?: 'ollama' | 'claude-cli';
}

export interface LLMResponse {
  text: string;
  usage?: TokenUsage;
  /** Set only on abnormal termination. Absent on a normal text completion. */
  stopReason?: 'loop-break' | 'exhausted';
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
  /**
   * Return the bare client for one backend, unwrapping fallback/failover
   * wrappers. Lets a caller (the agent-loop planner) pin a phase to a
   * specific backend without the wrapper's silent cross-backend fallback.
   * Returns undefined when the client has no such backend.
   */
  getBackendClient?(backend: 'ollama' | 'claude-cli'): LLMClient | undefined;
}

/**
 * Thin wrapper delegating to existing OllamaClient.
 */
export class OllamaLLMClient implements LLMClient {
  readonly backend = 'ollama' as const;

  constructor(private ollama: OllamaClient) {}

  getBackendClient(backend: 'ollama' | 'claude-cli'): LLMClient | undefined {
    return backend === this.backend ? this : undefined;
  }

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

  getBackendClient(backend: 'ollama' | 'claude-cli'): LLMClient | undefined {
    return backend === this.backend ? this : undefined;
  }

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
        toolExecutor:
          opts.toolExecutor ??
          (async () => ({ success: false, content: 'No tool executor configured' })),
        disallowedNativeTools: ALL_DISALLOWED_NATIVE_TOOLS,
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

/**
 * Shared by the wrapper clients: find the bare client for `backend` among the
 * wrapped candidates. Clients that predate `getBackendClient` (test doubles,
 * third-party implementations) are matched on their `backend` tag.
 */
function unwrapBackendClient(
  backend: 'ollama' | 'claude-cli',
  ...candidates: LLMClient[]
): LLMClient | undefined {
  for (const candidate of candidates) {
    const bare = candidate.getBackendClient
      ? candidate.getBackendClient(backend)
      : candidate.backend === backend
        ? candidate
        : undefined;
    if (bare) return bare;
  }
  return undefined;
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

  getBackendClient(backend: 'ollama' | 'claude-cli'): LLMClient | undefined {
    return unwrapBackendClient(backend, this.primary, this.fallback);
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
      // Strip model when crossing backends — the primary's model name
      // (e.g. "claude") is not valid for the fallback (e.g. Ollama).
      const fallbackOpts =
        this.primary.backend !== this.fallback.backend ? { ...opts, model: undefined } : opts;
      return this.fallback.generate(prompt, fallbackOpts);
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
      // Strip model when crossing backends — the primary's model name
      // (e.g. "claude") is not valid for the fallback (e.g. Ollama).
      const fallbackOpts =
        this.primary.backend !== this.fallback.backend ? { ...opts, model: undefined } : opts;
      return this.fallback.chat(messages, fallbackOpts);
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

  getBackendClient(backend: 'ollama' | 'claude-cli'): LLMClient | undefined {
    return unwrapBackendClient(backend, this.primary, this.fallback);
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
            primaryBackend:
              (this.candidates[0]?.backend as FallbackEvent['primaryBackend'] | undefined) ??
              this.primary.backend,
            fallbackBackend: attempt.backend as FallbackEvent['fallbackBackend'],
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
            primaryBackend:
              (this.candidates[0]?.backend as FallbackEvent['primaryBackend'] | undefined) ??
              this.primary.backend,
            fallbackBackend: attempt.backend as FallbackEvent['fallbackBackend'],
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
  /** Ollama primary model. Falls back to the model configured on the client. */
  ollamaModel?: string;
  /** Ollama fallback models. Falls back to the models configured on the client. */
  ollamaFallbacks?: string[];
  /**
   * Allow a failed call on the bot's own backend to be re-issued on the other
   * backend. **Off by default** — an implicit claude-cli → Ollama fallback
   * silently re-ran every failed Claude call against Ollama Cloud and burned
   * its shared weekly quota. Turn it on only where crossing backends is
   * genuinely wanted; a configured `failover` candidate chain is the explicit,
   * ordered way to ask for the same thing.
   */
  crossBackendFallback?: boolean;
  failoverConfig?: {
    enabled?: boolean;
    candidates?: Array<{ backend: string; model?: string }>;
    cooldownEnabled?: boolean;
  };
  cooldownTracker?: ProviderCooldownTracker;
}

export interface ResolvedOllamaModels {
  primary?: string;
  fallbacks?: string[];
}

/**
 * The Ollama models to put in a failover chain.
 *
 * `OllamaClient` keeps its config private, so read it structurally and let an
 * explicit option win. (The previous code passed `ollamaClient.toString()` as
 * the model name, which yields `[object Object]` — never a real model.)
 */
export function resolveOllamaModels(
  ollamaClient: OllamaClient,
  opts: Pick<CreateLLMClientOptions, 'ollamaModel' | 'ollamaFallbacks'>
): ResolvedOllamaModels {
  const configured = (
    ollamaClient as unknown as { config?: { models?: ResolvedOllamaModels } } | undefined
  )?.config?.models;
  return {
    primary: opts.ollamaModel ?? configured?.primary,
    fallbacks: opts.ollamaFallbacks ?? configured?.fallbacks,
  };
}

/**
 * Stable partition putting the bot's own backend at the head of the chain.
 *
 * The chain must start with the backend the bot was configured for; otherwise
 * every claude-cli bot's first attempt lands on Ollama, which is neither what
 * the operator asked for nor what the planner expects.
 */
export function orderCandidatesByBackend(
  candidates: ModelCandidate[],
  backend: 'ollama' | 'claude-cli'
): ModelCandidate[] {
  const own = candidates.filter((c) => c.backend === backend);
  if (own.length === 0) return [...candidates];
  return [...own, ...candidates.filter((c) => c.backend !== backend)];
}

/**
 * Factory: builds the right LLMClient based on skill config.
 * - failover enabled with >1 candidate → FailoverLLMClient, own backend first
 * - 'claude-cli' → bare ClaudeCliLLMClient (no implicit Ollama fallback)
 * - 'claude-cli' + `crossBackendFallback: true` → LLMClientWithFallback(claude, ollama)
 * - default → OllamaLLMClient(ollama)
 */
export function createLLMClient(
  opts: CreateLLMClientOptions,
  ollamaClient: OllamaClient,
  logger: Logger
): LLMClient {
  const ollamaLLM = new OllamaLLMClient(ollamaClient);
  const backend: 'ollama' | 'claude-cli' =
    opts.llmBackend === 'claude-cli' ? 'claude-cli' : 'ollama';
  const buildClaude = () =>
    new ClaudeCliLLMClient(
      opts.claudePath || 'claude',
      opts.claudeTimeout ?? 300_000,
      logger,
      opts.claudeModel
    );

  // An explicit, enabled failover chain is the operator asking for a
  // multi-backend ladder — honoured for either backend.
  if (opts.failoverConfig?.enabled) {
    const ollamaModels = resolveOllamaModels(ollamaClient, opts);
    const candidates = orderCandidatesByBackend(
      resolveCandidatesFromConfig({
        failover: opts.failoverConfig,
        ollama: { models: ollamaModels },
        claudeCli: { enabled: true, model: opts.claudeModel },
      }),
      backend
    );

    if (candidates.length > 1) {
      const cooldownTracker = opts.cooldownTracker ?? new ProviderCooldownTracker();
      const claudeLLM = buildClaude();
      const primary = backend === 'claude-cli' ? claudeLLM : ollamaLLM;
      const secondary = backend === 'claude-cli' ? ollamaLLM : claudeLLM;
      return new FailoverLLMClient(primary, secondary, logger, candidates, cooldownTracker);
    }
  }

  if (backend === 'claude-cli') {
    const claudeLLM = buildClaude();
    return opts.crossBackendFallback
      ? new LLMClientWithFallback(claudeLLM, ollamaLLM, logger)
      : claudeLLM;
  }

  return ollamaLLM;
}
