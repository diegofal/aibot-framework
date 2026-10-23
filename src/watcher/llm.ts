/**
 * The watcher's LLM clients (phase 2). The model of a Claude CLI client is
 * bound at construction, so each tier gets its own instance: notice (tier 1,
 * a cheap model, or the shared Ollama client when `watcher.notice.backend` is
 * `ollama`) and integrate (tier 2, phase 3). `instrumented` is the only way
 * the watcher calls a model: it consults the daily budget (which also asks
 * the fleet circuit breaker) before every call, sends it at semaphore
 * priority `watcher`, writes one query-log entry under `__watcher__` with
 * model, tokens, cost and duration, counts it against the budget, feeds the
 * breaker, and never throws.
 */
import type { LlmQueryEntry } from '../bot/llm-query-log';
import { usageExtras } from '../bot/llm-query-log';
import type { Config } from '../config';
import {
  ClaudeCliLLMClient,
  type LLMChatOptions,
  type LLMClient,
  OllamaLLMClient,
  type TokenUsage,
} from '../core/llm-client';
import type { Logger } from '../logger';
import type { ChatMessage, OllamaClient } from '../ollama';
import type { BudgetDecision, DailyBudget, WatcherTier } from './budget';
import { WATCHER_BOT_ID } from './sense';
import { WATCHER_DEFAULTS, type WatcherConfig } from './types';

/** The pseudo bot id every watcher LLM call is logged under (Insights → Usage groups by it). */
export const WATCHER_QUERY_BOT_ID = WATCHER_BOT_ID;

const DEFAULT_CLAUDE_TIMEOUT_MS = 300_000;

export type WatcherBackend = 'claude-cli' | 'ollama';

export interface WatcherTierClient {
  client: LLMClient;
  model: string;
  backend: WatcherBackend;
}

export interface WatcherClients {
  notice: WatcherTierClient;
  integrate: WatcherTierClient;
}

/** Notice on Claude CLI (or Ollama when configured and available), integrate always on Claude CLI. */
export function createWatcherClients(
  config: Config,
  deps: { logger: Logger; ollama?: OllamaClient; claudePath?: string }
): WatcherClients {
  const cfg = (config.watcher as WatcherConfig | undefined) ?? WATCHER_DEFAULTS;
  const timeout =
    (config.agentLoop as { claudeTimeout?: number } | undefined)?.claudeTimeout ??
    DEFAULT_CLAUDE_TIMEOUT_MS;
  const claudePath = deps.claudePath ?? 'claude';
  const claude = (model: string): WatcherTierClient => ({
    client: new ClaudeCliLLMClient(claudePath, timeout, deps.logger, model),
    model,
    backend: 'claude-cli',
  });

  let notice: WatcherTierClient;
  if (cfg.notice.backend === 'ollama' && deps.ollama) {
    const primary = (config.ollama as { models?: { primary?: string } } | undefined)?.models
      ?.primary;
    const model = cfg.notice.model.startsWith('claude-')
      ? (primary ?? cfg.notice.model)
      : cfg.notice.model;
    notice = { client: new OllamaLLMClient(deps.ollama), model, backend: 'ollama' };
  } else {
    notice = claude(cfg.notice.model);
  }
  return { notice, integrate: claude(cfg.integrate.model) };
}

export type WatcherCaller = Extract<LlmQueryEntry['caller'], `watcher:${string}`>;

export type WatcherCallResult =
  | {
      ok: true;
      text: string;
      model: string;
      backend: WatcherBackend;
      tokens: number;
      costUsd?: number;
      durationMs: number;
      usage?: TokenUsage;
    }
  | { ok: false; reason: Exclude<BudgetDecision, { ok: true }>['reason'] }
  | { ok: false; reason: 'error'; error: string; model: string; durationMs: number };

export interface InstrumentedClient {
  readonly tier: WatcherTier;
  readonly model: string;
  readonly backend: WatcherBackend;
  chat(
    messages: ChatMessage[],
    opts?: Omit<LLMChatOptions, 'priority'>
  ): Promise<WatcherCallResult>;
}

export interface InstrumentOptions {
  tier: WatcherTier;
  caller: WatcherCaller;
  budget: Pick<DailyBudget, 'allow' | 'record'>;
  queryLog?: { append(entry: LlmQueryEntry): void };
  /** The fleet breaker (`BotContext.circuitBreaker`); a watcher 429 counts like anyone's. */
  breaker?: {
    recordFailure(backend: string, error: unknown): unknown;
    recordSuccess(backend: string): void;
  };
  now?: () => number;
}

export function instrumented(tier: WatcherTierClient, opts: InstrumentOptions): InstrumentedClient {
  const now = opts.now ?? Date.now;
  const log = (entry: Omit<LlmQueryEntry, 'timestamp' | 'botId' | 'caller' | 'backend'>) => {
    try {
      opts.queryLog?.append({
        timestamp: new Date(now()).toISOString(),
        botId: WATCHER_QUERY_BOT_ID,
        caller: opts.caller,
        backend: tier.backend,
        ...entry,
      });
    } catch {
      // the query log is best-effort
    }
  };
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // the breaker is best-effort here
    }
  };

  return {
    tier: opts.tier,
    model: tier.model,
    backend: tier.backend,
    async chat(messages, callOpts = {}) {
      const decision = opts.budget.allow(opts.tier);
      if (!decision.ok) return { ok: false, reason: decision.reason };
      const started = Date.now();
      try {
        const res = await tier.client.chat(messages, {
          ...callOpts,
          ...(tier.backend === 'ollama' ? { model: tier.model } : {}),
          priority: 'watcher',
        });
        const durationMs = Date.now() - started;
        const usage = res.usage;
        const tokens = usage?.totalTokens ?? 0;
        const model = usage?.model ?? tier.model;
        log({
          model,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          totalTokens: usage?.totalTokens,
          ...usageExtras(usage),
          messageCount: messages.length,
          durationMs,
          success: true,
        });
        opts.budget.record(opts.tier, { tokens, costUsd: usage?.costUsd });
        safe(() => opts.breaker?.recordSuccess(tier.backend));
        return {
          ok: true,
          text: res.text ?? '',
          model,
          backend: tier.backend,
          tokens,
          ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
          durationMs,
          ...(usage ? { usage } : {}),
        };
      } catch (err) {
        const durationMs = Date.now() - started;
        const error = err instanceof Error ? err.message : String(err);
        log({
          model: tier.model,
          messageCount: messages.length,
          durationMs,
          success: false,
          error,
        });
        opts.budget.record(opts.tier, {});
        safe(() => opts.breaker?.recordFailure(tier.backend, err));
        return { ok: false, reason: 'error', error, model: tier.model, durationMs };
      }
    },
  };
}
