/**
 * Operational view for `GET /api/stats/infra`: LLM backend health, security
 * audit summaries, cron jobs, Telegram channel states, log noise, boots and
 * log size. Log-derived rows use the last 24 h of the log tail.
 */
import { basename, dirname, join } from 'node:path';
import type { BotConfig } from '../config';
import { type StatsContext, getLogSignals, liveChannelStatus, windowSince } from './context';
import { resolveChannel } from './fleet-aggregator';
import { readCronJobs } from './readers/cron';
import { readLlmEntries } from './readers/llm-query-log';
import { totalLogBytes } from './readers/logs';
import type { InfraResponse } from './types';
import { listDirSafe, toIso, toMs } from './util';

const KNOWN_BACKENDS = ['ollama', 'claude-cli'];

export function buildInfra(ctx: StatsContext, bots: BotConfig[]): InfraResponse {
  const now = ctx.now();
  const since24h = windowSince(ctx, '24h');
  const logs = getLogSignals(ctx, '24h');
  const scoped = new Set(bots.map((b) => b.id));
  const isAdminView = bots.length === ctx.config.bots.length;

  // Backends: failures in the last 24h from the query log (authoritative per
  // call), 429/401 timestamps from the log tail, with the query log's own
  // error text as a fallback when the pino log did not capture the status.
  const backends = new Map<string, InfraResponse['backends'][number]>();
  const circuits = ctx.botManager?.getAgentLoopCircuitState?.() ?? {};
  const circuitOf = (name: string): InfraResponse['backends'][number]['circuit'] => {
    const c = circuits[name];
    if (!c) return null;
    return {
      open: Boolean(c.open),
      halfOpen: Boolean(c.halfOpen),
      until: c.until == null ? null : toIso(c.until),
      consecutiveFailures: c.consecutiveFailures ?? 0,
      lastError: c.lastError ?? null,
    };
  };
  for (const name of new Set([
    ...KNOWN_BACKENDS,
    ...Object.keys(logs.backends),
    ...Object.keys(circuits),
  ])) {
    const sig = logs.backends[name];
    backends.set(name, {
      name,
      last429At: sig?.last429At ?? null,
      last401At: sig?.last401At ?? null,
      lastErrorMessage: sig?.lastErrorMessage ?? null,
      failedCalls24h: 0,
      circuit: circuitOf(name),
    });
  }
  for (const bot of bots) {
    for (const e of readLlmEntries(ctx.dirs.llmQueryLog, bot.id, since24h, now)) {
      if (e.success !== false) continue;
      const name = e.backend || 'unknown';
      let b = backends.get(name);
      if (!b) {
        b = {
          name,
          last429At: null,
          last401At: null,
          lastErrorMessage: null,
          failedCalls24h: 0,
          circuit: circuitOf(name),
        };
        backends.set(name, b);
      }
      b.failedCalls24h++;
      const at = toIso(toMs(e.timestamp));
      const err = e.error ? String(e.error) : '';
      if (
        at &&
        /\b429\b|too many requests|rate limit/i.test(err) &&
        (!b.last429At || at > b.last429At)
      ) {
        b.last429At = at;
      }
      if (
        at &&
        /\b401\b|unauthorized|invalid api key/i.test(err) &&
        (!b.last401At || at > b.last401At)
      ) {
        b.last401At = at;
      }
      if (err && !b.lastErrorMessage) b.lastErrorMessage = err.slice(0, 300);
    }
  }

  const cron = readCronJobs(ctx.dirs.cron).filter((j) =>
    j.botId ? scoped.has(j.botId) : isAdminView
  );

  const telegram = bots.map((bot) => {
    const channel = resolveChannel(ctx, bot, logs);
    const recorded = liveChannelStatus(ctx, bot.id);
    return {
      botId: bot.id,
      state: channel.state,
      lastError: recorded?.lastError ?? logs.telegramByBot[bot.id]?.lastError ?? null,
    };
  });

  const logDir = dirname(ctx.dirs.logFile);
  const logBase = basename(ctx.dirs.logFile);
  const siblings = listDirSafe(logDir)
    .filter((f) => f !== logBase && f.startsWith(logBase))
    .map((f) => join(logDir, f));

  return {
    generatedAt: new Date(now).toISOString(),
    backends: [...backends.values()].sort((a, b) => a.name.localeCompare(b.name)),
    securityAudit: logs.securityAudit.filter((a) => scoped.has(a.botId)),
    cron,
    telegram,
    logNoise: logs.logNoise,
    boots: logs.boots,
    logBytes: totalLogBytes(ctx.dirs.logFile, siblings),
  };
}
