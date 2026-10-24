/**
 * The watcher's LLM clients (phase 2). The model of a Claude CLI client is
 * bound at construction, so each tier gets its own instance: notice (tier 1,
 * a cheap model, or the shared Ollama client when `watcher.notice.backend` is
 * `ollama`) and integrate (tier 2, phase 3). `instrumented` is the only way
 * the watcher calls a model: it consults the daily budget (which also asks
 * the fleet circuit breaker) before every call, sends it at semaphore
 * priority `watcher`, writes one query-log entry under `__watcher__` with
 * model, tokens, cost and duration, counts it against the budget, feeds the
 * breaker, and never throws. Every call gets its own AbortController, aborted
 * when the watcher's stop signal (`InstrumentOptions.signal`) fires: the
 * client receives it, and the call stops being waited on even if the client
 * ignores it. An aborted call is not a backend failure (the breaker is not fed).
 * Every call that reached the model (answered or failed, not aborted) is kept
 * as a pass record (`pass-records.ts`: prompt and response, redacted) and the
 * result carries its `recordId`; by default next to the budget files.
 */
import type { LlmQueryEntry } from '../bot/llm-query-log';
import { usageExtras } from '../bot/llm-query-log';
import type { Config } from '../config';
import { isAbort, raceAbort } from '../core/abort';
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
import { PassRecords, passesDir, redactPassPrompt } from './pass-records';
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
      /** The pass record of this call (`GET /api/watcher/passes/:id`), when one was written. */
      recordId?: string;
    }
  | { ok: false; reason: Exclude<BudgetDecision, { ok: true }>['reason'] }
  | {
      ok: false;
      reason: 'error';
      error: string;
      model: string;
      durationMs: number;
      recordId?: string;
    };

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
  budget: Pick<DailyBudget, 'reserve' | 'record'>;
  queryLog?: { append(entry: LlmQueryEntry): void };
  /** The fleet breaker (`BotContext.circuitBreaker`); a watcher 429 counts like anyone's. */
  breaker?: {
    recordFailure(backend: string, error: unknown): unknown;
    recordSuccess(backend: string): void;
  };
  now?: () => number;
  /** The watcher's stop signal, read per call; aborting it aborts every call in flight. */
  signal?: () => AbortSignal | undefined;
  /**
   * Where the call's prompt and response are kept. Default: `passes/` next to
   * the budget files (`DailyBudget.dir`, the watcher dir); `null` keeps nothing.
   */
  records?: Pick<PassRecords, 'write'> | null;
}

/** The `error` of a call the watcher's stop aborted. */
export const WATCHER_CALL_ABORTED = 'aborted: the watcher is stopping';

/** The default records of a call: next to the budget files when the budget has a dir. */
function defaultRecords(opts: InstrumentOptions): Pick<PassRecords, 'write'> | null {
  if (opts.records !== undefined) return opts.records;
  const dir = (opts.budget as { dir?: unknown }).dir;
  return typeof dir === 'string' && dir
    ? new PassRecords({ dir: passesDir(dir), ...(opts.now ? { now: opts.now } : {}) })
    : null;
}

export function instrumented(tier: WatcherTierClient, opts: InstrumentOptions): InstrumentedClient {
  const now = opts.now ?? Date.now;
  const records = defaultRecords(opts);
  const keep = (
    messages: ChatMessage[],
    rec: {
      ok: boolean;
      model: string;
      durationMs: number;
      tokens?: number;
      costUsd?: number;
      response?: string;
      error?: string;
    }
  ): string | undefined => {
    if (!records) return undefined;
    try {
      return records.write({
        caller: opts.caller,
        tier: opts.tier,
        backend: tier.backend,
        prompt: redactPassPrompt(messages),
        ...rec,
      });
    } catch {
      return undefined; // records are best-effort
    }
  };
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
      const stop = opts.signal?.();
      if (stop?.aborted) {
        return {
          ok: false,
          reason: 'error',
          error: WATCHER_CALL_ABORTED,
          model: tier.model,
          durationMs: 0,
        };
      }
      const decision = opts.budget.reserve(opts.tier);
      if (!decision.ok) return { ok: false, reason: decision.reason };
      const started = Date.now();
      // One controller per call, linked to the stop signal and the caller's own.
      const ctrl = new AbortController();
      const links: Array<[AbortSignal, () => void]> = [];
      for (const s of [stop, callOpts.signal]) {
        if (!s) continue;
        const fn = () => ctrl.abort(s.reason);
        if (s.aborted) fn();
        else {
          s.addEventListener('abort', fn, { once: true });
          links.push([s, fn]);
        }
      }
      try {
        const res = await raceAbort(
          tier.client.chat(messages, {
            ...callOpts,
            ...(tier.backend === 'ollama' ? { model: tier.model } : {}),
            priority: 'watcher',
            signal: ctrl.signal,
          }),
          ctrl.signal
        );
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
        const recordId = keep(messages, {
          ok: true,
          model,
          durationMs,
          tokens,
          ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
          response: res.text ?? '',
        });
        return {
          ok: true,
          text: res.text ?? '',
          model,
          backend: tier.backend,
          tokens,
          ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
          durationMs,
          ...(usage ? { usage } : {}),
          ...(recordId ? { recordId } : {}),
        };
      } catch (err) {
        const durationMs = Date.now() - started;
        if (ctrl.signal.aborted && isAbort(err, ctrl.signal)) {
          log({
            model: tier.model,
            messageCount: messages.length,
            durationMs,
            success: false,
            error: WATCHER_CALL_ABORTED,
          });
          opts.budget.record(opts.tier, {});
          return {
            ok: false,
            reason: 'error',
            error: WATCHER_CALL_ABORTED,
            model: tier.model,
            durationMs,
          };
        }
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
        const recordId = keep(messages, { ok: false, model: tier.model, durationMs, error });
        return {
          ok: false,
          reason: 'error',
          error,
          model: tier.model,
          durationMs,
          ...(recordId ? { recordId } : {}),
        };
      } finally {
        for (const [s, fn] of links) s.removeEventListener('abort', fn);
      }
    },
  };
}
