/**
 * Per-bot and fleet-wide aggregation for `GET /api/stats/fleet` and
 * `GET /api/stats/bots/:botId`. Pure composition over the readers; every
 * reader tolerates missing data, so a fresh bot yields zeros and nulls.
 */
import type { BotConfig } from '../config';
import {
  type StatsContext,
  getLogSignals,
  liveChannelStatus,
  liveSchedule,
  windowSince,
} from './context';
import { classifyToken, resolveBotPaths } from './paths';
import { computePosture } from './posture';
import { lastHumanMessageAt, readInboxAsks, summariseAsks } from './readers/conversations';
import { readKarmaStats } from './readers/karma';
import { aggregateLlm, llmDaily, readLlmEntries, topErrors } from './readers/llm-query-log';
import type { LogSignals } from './readers/logs';
import { readMeshCounts } from './readers/mesh';
import { readOutcomeStats } from './readers/outcomes';
import { readProductionOutput } from './readers/productions';
import { type PersistedSchedule, readSchedules } from './readers/schedules';
import { lastSessionActivityAt } from './readers/sessions';
import { readFeedbackLastAt, readGoals, readSoulHealth, readTraits } from './readers/soul';
import {
  aggregateTools,
  engagementFromTools,
  readToolEntries,
  toolsDaily,
} from './readers/tool-audit';
import type {
  BotDetailResponse,
  ChannelKind,
  ChannelState,
  FleetBotStats,
  FleetResponse,
  FleetTotals,
  LoopStats,
  RecentCycle,
  StatsWindow,
} from './types';
import { maxMs, toIso } from './util';

const CHANNEL_STATES: ReadonlySet<string> = new Set([
  'ok',
  'revoked',
  'placeholder',
  'missing',
  'error',
  'configured',
  'unknown',
]);

// ── Loop ──

function buildLoop(
  ctx: StatsContext,
  bot: BotConfig,
  persisted: PersistedSchedule | undefined
): LoopStats {
  const configured = bot.agentLoop?.every ?? ctx.config.agentLoop?.every ?? null;
  const configuredMode = bot.agentLoop?.mode ?? 'periodic';
  const live = liveSchedule(ctx, bot.id);
  if (live) {
    // Right after a restart the live schedule has no lastRunAt yet; the file
    // the scheduler persisted before the restart still knows the last cycle,
    // so the bot does not read as "never ran" for up to one cadence.
    return {
      cadence: live.nextCheckIn ?? configured,
      mode: live.mode ?? configuredMode,
      nextRunAt: live.nextRunAt ?? persisted?.nextRunAt ?? null,
      lastRunAt: live.lastRunAt ?? persisted?.lastRunAt ?? null,
      consecutiveIdleCycles: live.consecutiveIdleCycles ?? persisted?.consecutiveIdleCycles ?? 0,
      retryCount: live.retryCount ?? 0,
      lastError: live.lastErrorMessage ?? null,
    };
  }
  return {
    cadence: persisted?.nextCheckIn ?? configured,
    mode: configuredMode,
    nextRunAt: persisted?.nextRunAt ?? null,
    lastRunAt: persisted?.lastRunAt ?? null,
    consecutiveIdleCycles: persisted?.consecutiveIdleCycles ?? 0,
    retryCount: persisted?.retryCount ?? 0,
    lastError: persisted?.lastErrorMessage ?? null,
  };
}

// ── Channel ──

/**
 * Channel kind/state, in precedence order:
 *  1. the channel outcome the bot manager recorded at start time
 *     (`getChannelState`), when exposed — a state outside this contract's
 *     vocabulary (e.g. `error`) is reported as `unknown`;
 *  2. token shape: empty → missing, not a Telegram token → placeholder;
 *  3. a "Telegram start failed" line in the log window → headless, and
 *     `revoked` when it was a 401;
 *  4. otherwise a well-formed token → telegram/configured.
 */
export function resolveChannel(
  ctx: StatsContext,
  bot: BotConfig,
  logs: LogSignals
): { kind: ChannelKind; state: ChannelState } {
  const recorded = liveChannelStatus(ctx, bot.id);
  const tokenState = classifyToken(bot.token);
  const failure = logs.telegramByBot[bot.id];

  let kind: ChannelKind;
  if (recorded?.kind === 'telegram' || recorded?.kind === 'headless') kind = recorded.kind;
  else if (tokenState !== 'configured' || failure) kind = 'headless';
  else kind = 'telegram';

  let state: ChannelState;
  if (recorded?.state) {
    state = CHANNEL_STATES.has(recorded.state) ? (recorded.state as ChannelState) : 'unknown';
  } else if (tokenState !== 'configured') {
    state = tokenState;
  } else if (failure) {
    state = failure.revoked ? 'revoked' : 'unknown';
  } else {
    state = 'configured';
  }
  return { kind, state };
}

// ── Per-bot ──

export function buildBotStats(
  ctx: StatsContext,
  bot: BotConfig,
  window: StatsWindow
): FleetBotStats {
  const now = ctx.now();
  const since = windowSince(ctx, window);
  const logs = getLogSignals(ctx, window);
  const paths = resolveBotPaths(ctx.config, bot);
  const schedules = readSchedules(ctx.dirs.scheduler);

  const llmEntries = readLlmEntries(ctx.dirs.llmQueryLog, bot.id, since, now);
  const toolEntries = readToolEntries(ctx.dirs.toolAudit, bot.id, since, now);
  const cycleSignals = logs.cyclesByBot[bot.id];

  const llm = aggregateLlm(llmEntries);
  const tools = aggregateTools(toolEntries, cycleSignals?.loopBreaks ?? 0);
  const toolEngagement = engagementFromTools(toolEntries, bot.id);

  const production = readProductionOutput(paths.workDir);
  const outcomes = readOutcomeStats(ctx.dirs.outcomeLedger, bot.id, since);
  const asks = summariseAsks(readInboxAsks(ctx.dirs.conversations, bot.id), since);
  const mesh = readMeshCounts(ctx.dirs.mesh, since);
  const goals = readGoals(paths.soulDir);
  const traits = readTraits(paths.soulDir);
  const soul = readSoulHealth(paths.soulDir);
  const karma = readKarmaStats(ctx.dirs.karma, bot.id, since, ctx.karmaService);
  const loop = buildLoop(ctx, bot, schedules[bot.id]);
  // The scheduler rewrites schedules.json with empty run times at boot, so for
  // up to one cadence after a restart neither the live nor the persisted
  // schedule knows the last cycle — the log still does.
  if (loop.lastRunAt === null && cycleSignals?.lastAt) loop.lastRunAt = cycleSignals.lastAt;

  const lastHumanContact = maxMs(
    lastHumanMessageAt(ctx.dirs.conversations, bot.id),
    lastSessionActivityAt(ctx.dirs.sessions, bot.id),
    readFeedbackLastAt(paths.soulDir)
  );

  const posture = computePosture({
    enabled: bot.enabled !== false,
    nowMs: now,
    lastRunAt: loop.lastRunAt,
    retryCount: loop.retryCount,
    lastError: loop.lastError,
    consecutiveIdleCycles: loop.consecutiveIdleCycles,
    goalsActive: goals.stats.active,
    goalsByStatus: goals.stats.byStatus,
    lastOutcomeAt: outcomes.lastAt,
  });

  const cycleTotal = cycleSignals?.total ?? 0;

  return {
    botId: bot.id,
    name: bot.name,
    enabled: bot.enabled !== false,
    backend: paths.backend,
    model: paths.model,
    channel: resolveChannel(ctx, bot, logs),
    loop,
    posture,
    lastHumanContactAt: toIso(lastHumanContact),
    llm,
    tools,
    output: {
      filesActive: production.filesActive,
      filesArchived: production.filesArchived,
      approved: production.approved,
      rejected: production.rejected,
      unreviewed: production.unreviewed,
      outcomesProduced: outcomes.produced,
      outcomesStale: outcomes.stale,
      lastFileAt: production.lastFileAt,
    },
    engagement: {
      asksSent: asks.asksSent,
      asksAnswered: asks.asksAnswered,
      asksPending: asks.asksPending,
      asksClosedUnanswered: asks.asksClosedUnanswered,
      messagesSentProactive: toolEngagement.messagesSentProactive,
      collaborateCalls: toolEngagement.collaborateCalls,
      collaborateFailed: toolEngagement.collaborateFailed,
      meshPublished: Math.max(mesh.byBot[bot.id] ?? 0, toolEngagement.meshPublishCalls),
    },
    goals: goals.stats,
    karma,
    traits: traits.stats,
    soul,
    cycles: {
      total: cycleTotal,
      idle: cycleSignals?.idle ?? 0,
      avgDurationMs: cycleTotal ? Math.round((cycleSignals?.durationSumMs ?? 0) / cycleTotal) : 0,
      alignmentWarnings: cycleSignals?.alignmentWarnings ?? 0,
    },
  };
}

/** Cached variant — one computation per bot per window per TTL. */
export function getBotStats(ctx: StatsContext, bot: BotConfig, window: StatsWindow): FleetBotStats {
  return ctx.cache.get(`bot:${bot.id}:${window}`, ctx.cacheTtlMs, () =>
    buildBotStats(ctx, bot, window)
  );
}

// ── Fleet ──

export function sumTotals(bots: FleetBotStats[]): FleetTotals {
  const t: FleetTotals = {
    llmCalls: 0,
    llmFailed: 0,
    toolCalls: 0,
    toolFailed: 0,
    promptTokens: 0,
    completionTokens: 0,
    filesActive: 0,
    unreviewed: 0,
    asksPending: 0,
    cycles: 0,
  };
  for (const b of bots) {
    t.llmCalls += b.llm.calls;
    t.llmFailed += b.llm.failed;
    t.toolCalls += b.tools.calls;
    t.toolFailed += b.tools.failed;
    t.promptTokens += b.llm.promptTokens;
    t.completionTokens += b.llm.completionTokens;
    t.filesActive += b.output.filesActive;
    t.unreviewed += b.output.unreviewed;
    t.asksPending += b.engagement.asksPending;
    t.cycles += b.cycles.total;
  }
  return t;
}

export function buildFleet(
  ctx: StatsContext,
  bots: BotConfig[],
  window: StatsWindow
): FleetResponse {
  const stats = bots.map((b) => getBotStats(ctx, b, window));
  return {
    generatedAt: new Date(ctx.now()).toISOString(),
    window,
    bots: stats,
    totals: sumTotals(stats),
  };
}

// ── Detail ──

export function buildBotDetail(
  ctx: StatsContext,
  bot: BotConfig,
  window: StatsWindow
): BotDetailResponse {
  const base = getBotStats(ctx, bot, window);
  const now = ctx.now();
  const since = windowSince(ctx, window);
  const paths = resolveBotPaths(ctx.config, bot);
  const schedule = readSchedules(ctx.dirs.scheduler)[bot.id];
  const llmEntries = readLlmEntries(ctx.dirs.llmQueryLog, bot.id, since, now);
  const toolEntries = readToolEntries(ctx.dirs.toolAudit, bot.id, since, now);

  const actions: RecentCycle[] = Array.isArray(schedule?.recentActions)
    ? schedule.recentActions.map((a) => ({
        cycle: Number(a.cycle) || 0,
        timestamp: Number(a.timestamp) || 0,
        tools: Array.isArray(a.tools) ? a.tools : [],
        planSummary: String(a.planSummary ?? ''),
      }))
    : [];

  return {
    ...base,
    window,
    generatedAt: new Date(now).toISOString(),
    goalsDetail: readGoals(paths.soulDir).detail,
    traitHistory: readTraits(paths.soulDir).history,
    recentCycles: { actions, lastLoggedSummary: schedule?.lastLoggedSummary ?? null },
    llmDaily: llmDaily(llmEntries),
    toolsDaily: toolsDaily(toolEntries),
    asks: readInboxAsks(ctx.dirs.conversations, bot.id).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1
    ),
    topErrors: topErrors(llmEntries, 10),
  };
}
