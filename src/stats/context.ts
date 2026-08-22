/**
 * Shared context for the stats aggregators: config, resolved directories,
 * optional live runtime accessors, a clock, and the TTL cache.
 *
 * `botManager` is typed structurally as the *subset* of BotManager the stats
 * layer reads, so the real BotManager satisfies it and tests can pass a stub.
 * Every accessor is optional and read defensively.
 */
import type { AgentLoopState } from '../bot/agent-loop';
import type { Config } from '../config';
import { STATS_CACHE_TTL_MS, TtlCache } from './cache';
import { type StatsDirs, resolveStatsDirs } from './paths';
import type { KarmaScoreSource } from './readers/karma';
import { DEFAULT_LOG_TAIL_BYTES, type LogSignals, scanLogs } from './readers/logs';
import type { StatsWindow } from './types';
import { windowToMs } from './util';

export interface StatsBotManager {
  getAgentLoopState?(): AgentLoopState;
  isRunning?(botId: string): boolean;
  /**
   * Optional, forward-compatible: another module is adding a persisted
   * per-bot channel status. When present it wins over the heuristics.
   */
  getChannelState?(
    botId: string
  ): { kind?: string; state?: string; lastError?: string | null } | null | undefined;
  /** Fleet-wide backend circuit breaker (BotManager.getAgentLoopCircuitState). */
  getAgentLoopCircuitState?(): Record<
    string,
    {
      open: boolean;
      halfOpen?: boolean;
      until: number | null;
      consecutiveFailures: number;
      lastError: string | null;
    }
  >;
}

export interface StatsContextOptions {
  config: Config;
  botManager?: StatsBotManager;
  karmaService?: KarmaScoreSource;
  now?: () => number;
  /** How much of the log tail to scan (default 8 MB). */
  logTailBytes?: number;
  cache?: TtlCache;
  cacheTtlMs?: number;
}

export interface StatsContext {
  config: Config;
  dirs: StatsDirs;
  botManager?: StatsBotManager;
  karmaService?: KarmaScoreSource;
  now: () => number;
  logTailBytes: number;
  cache: TtlCache;
  cacheTtlMs: number;
}

export function createStatsContext(opts: StatsContextOptions): StatsContext {
  const now = opts.now ?? (() => Date.now());
  return {
    config: opts.config,
    dirs: resolveStatsDirs(opts.config),
    botManager: opts.botManager,
    karmaService: opts.karmaService,
    now,
    logTailBytes: opts.logTailBytes ?? DEFAULT_LOG_TAIL_BYTES,
    cache: opts.cache ?? new TtlCache(now),
    cacheTtlMs: opts.cacheTtlMs ?? STATS_CACHE_TTL_MS,
  };
}

export function windowSince(ctx: StatsContext, window: StatsWindow): number {
  return ctx.now() - windowToMs(window);
}

/** Log-tail scan for the window, cached per window. */
export function getLogSignals(ctx: StatsContext, window: StatsWindow): LogSignals {
  return ctx.cache.get(`logs:${window}`, ctx.cacheTtlMs, () =>
    scanLogs(ctx.dirs.logFile, {
      maxBytes: ctx.logTailBytes,
      sinceMs: windowSince(ctx, window),
      nowMs: ctx.now(),
    })
  );
}

/** Live per-bot schedule from the running agent loop, if the manager exposes it. */
export function liveSchedule(ctx: StatsContext, botId: string) {
  try {
    const state = ctx.botManager?.getAgentLoopState?.();
    return state?.botSchedules?.find((s) => s.botId === botId) ?? null;
  } catch {
    return null;
  }
}

/** Channel outcome recorded by the bot manager at start time, if exposed. */
export function liveChannelStatus(ctx: StatsContext, botId: string) {
  try {
    return ctx.botManager?.getChannelState?.(botId) ?? null;
  } catch {
    return null;
  }
}
