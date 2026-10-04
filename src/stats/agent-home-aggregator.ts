/**
 * Agent Home — one payload with everything the agent's home page needs, and
 * a cheap uncached presence slice for live updates.
 *
 * Composition only: every number comes from the existing stats readers and
 * the live scheduler / presence tracker. Nothing here reads a file the stats
 * module does not already read, and nothing throws on missing data.
 *
 * The response shapes are a contract for `web/pages/agent-home*.js`
 * (sessions S1–S3 of docs/plans/jarvis-fleet-plan.md): add fields, never
 * rename or remove.
 */
import { join } from 'node:path';
import { avatarUrl, findAvatar } from '../bot/agent-avatar';
import type { BotConfig } from '../config';
import type { KarmaEvent } from '../karma/types';
import { readEntries } from '../productions/changelog';
import { type StatsContext, liveSchedule } from './context';
import { getBotStats } from './fleet-aggregator';
import { type NowTone, describeNow } from './now-line';
import { resolveBotPaths } from './paths';
import type { LivePresence } from './presence-tracker';
import { readInboxAsks } from './readers/conversations';
import { readLlmEntries } from './readers/llm-query-log';
import { readProductionOutput } from './readers/productions';
import { readSchedules } from './readers/schedules';
import { readGoals, readTraits } from './readers/soul';
import { readToolEntries } from './readers/tool-audit';
import type { ChannelKind, ChannelState, GoalDetail, Posture, TraitStats } from './types';
import { toIso, toMs } from './util';

export const HOME_CACHE_TTL_MS = 15_000;
/** Fleet presence map: short cache so many open dashboards share one aggregation. */
export const FLEET_PRESENCE_TTL_MS = 3_000;
export const TIMELINE_LIMIT = 60;
const TIMELINE_WINDOW_MS = 7 * 86_400_000;
const KARMA_EVENTS = 30;

/** The slice of KarmaService the home page needs. */
export interface HomeKarmaSource {
  getScore(botId: string): number;
  getTrend?(botId: string): 'rising' | 'falling' | 'stable';
  getRecentEvents?(botId: string, limit?: number): KarmaEvent[];
}

export interface AgentHomeDeps {
  karma?: HomeKarmaSource;
  /** Live phase / tool for a bot (PresenceTracker.get). */
  presence?: (botId: string) => LivePresence;
  /** Bot process is up (BotManager.isRunning). */
  isRunning?: (botId: string) => boolean;
  /** Pending ask_permission requests for a bot. */
  pendingPermissions?: (botId: string) => number;
}

export type TimelineKind = 'llm' | 'tool' | 'production' | 'ask' | 'cycle' | 'karma';

export interface TimelineItem {
  ts: string;
  kind: TimelineKind;
  title: string;
  detail: string | null;
  ok: boolean | null;
}

export interface AgentPresence {
  posture: Posture;
  nowLine: string;
  tone: NowTone;
  enabled: boolean;
  running: boolean;
  isExecuting: boolean;
  phase: string | null;
  currentTool: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  skippedReason: string | null;
  lastError: string | null;
  pendingAsks: number;
  generatedAt: string;
}

/** One fleet-grid card (session S3): the presence slice plus what the card shows. */
export interface FleetPresenceEntry {
  id: string;
  name: string;
  posture: Posture;
  nowLine: string;
  tone: NowTone;
  enabled: boolean;
  running: boolean;
  isExecuting: boolean;
  phase: string | null;
  currentTool: string | null;
  karma: number | null;
  pendingAsks: number;
  unreviewed: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastOutputAt: string | null;
  channel: { kind: ChannelKind; state: ChannelState };
  /** Uploaded face (session S4), versioned by mtime; null = seed avatar. */
  avatarUrl: string | null;
}

export interface FleetPresenceResponse {
  generatedAt: string;
  agents: Record<string, FleetPresenceEntry>;
}

export interface AgentIdentity {
  id: string;
  name: string;
  description: string | null;
  avatarSeed: string;
  enabled: boolean;
  running: boolean;
  backend: 'ollama' | 'claude-cli' | null;
  model: string | null;
  channel: { kind: ChannelKind; state: ChannelState };
  /** Uploaded face (session S4), versioned by mtime; null = seed avatar. */
  avatarUrl: string | null;
  /** True when `media.tts.apiKey` is set, so the header can offer a play button. */
  voiceEnabled: boolean;
}

export interface AgentHomeResponse {
  generatedAt: string;
  identity: AgentIdentity;
  presence: AgentPresence;
  goals: { active: GoalDetail[]; blocked: GoalDetail[]; completedRecently: GoalDetail[] };
  traits: TraitStats;
  karma: {
    score: number | null;
    trend: 'rising' | 'falling' | 'stable';
    delta7d: number;
    history: Array<{ ts: string; score: number }>;
    recentEvents: Array<{ ts: string; delta: number; reason: string; source: string }>;
  };
  timeline: TimelineItem[];
  needsYou: { asks: number; permissions: number; productionsPending: number };
}

const IDLE: LivePresence = { executing: false, phase: null, currentTool: null, since: null };

function clip(text: unknown, max = 140): string | null {
  if (text == null) return null;
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function buildPresence(
  ctx: StatsContext,
  bot: BotConfig,
  deps: AgentHomeDeps = {}
): AgentPresence {
  const now = ctx.now();
  const base = getBotStats(ctx, bot, '7d');
  const live = liveSchedule(ctx, bot.id);
  const lp = deps.presence?.(bot.id) ?? IDLE;
  const enabled = bot.enabled !== false;
  const running = safe(() => deps.isRunning?.(bot.id) ?? false, false);
  const asks = readInboxAsks(ctx.dirs.conversations, bot.id);
  const pendingAsks = asks.filter((a) => a.inboxStatus === 'pending').length;
  const lastRunAt = live?.lastRunAt ?? base.loop.lastRunAt ?? null;
  const nextRunAt = live?.nextRunAt ?? base.loop.nextRunAt ?? null;
  const skippedReason = live?.skippedReason ?? null;
  const lastError = live?.lastErrorMessage ?? base.loop.lastError ?? null;
  const isExecuting = Boolean(live?.isExecutingLoop) || lp.executing;
  const line = describeNow({
    enabled,
    running,
    posture: base.posture,
    isExecuting,
    phase: lp.phase,
    currentTool: lp.currentTool,
    lastRunAt,
    nextRunAt,
    skippedReason,
    lastError,
    pendingAsks,
    nowMs: now,
  });
  return {
    posture: base.posture,
    nowLine: line.text,
    tone: line.tone,
    enabled,
    running,
    isExecuting,
    phase: lp.phase,
    currentTool: lp.currentTool,
    lastRunAt: toIso(lastRunAt),
    nextRunAt: toIso(nextRunAt),
    skippedReason,
    lastError,
    pendingAsks,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * Presence for every bot in `bots`, keyed by id. Composed from `buildPresence`
 * plus the cached 7d bot stats (channel, last output, unreviewed) and the
 * karma score; a bot whose aggregation throws is reported with safe defaults.
 */
export function buildFleetPresence(
  ctx: StatsContext,
  bots: BotConfig[],
  deps: AgentHomeDeps = {}
): FleetPresenceResponse {
  const agents: Record<string, FleetPresenceEntry> = {};
  for (const bot of bots) {
    agents[bot.id] = safe(() => fleetEntry(ctx, bot, deps), fallbackEntry(bot));
  }
  return { generatedAt: new Date(ctx.now()).toISOString(), agents };
}

/** The face URL for a bot, resolved the same way the avatar route resolves it. */
function faceUrl(ctx: StatsContext, bot: BotConfig): string | null {
  return safe(() => avatarUrl(bot.id, findAvatar(resolveBotPaths(ctx.config, bot).soulDir)), null);
}

function fleetEntry(ctx: StatsContext, bot: BotConfig, deps: AgentHomeDeps): FleetPresenceEntry {
  const p = buildPresence(ctx, bot, deps);
  const base = getBotStats(ctx, bot, '7d');
  return {
    id: bot.id,
    name: bot.name ?? bot.id,
    posture: p.posture,
    nowLine: p.nowLine,
    tone: p.tone,
    enabled: p.enabled,
    running: p.running,
    isExecuting: p.isExecuting,
    phase: p.phase,
    currentTool: p.currentTool,
    karma: safe(() => deps.karma?.getScore(bot.id) ?? null, null),
    pendingAsks: p.pendingAsks,
    unreviewed: base.output.unreviewed,
    lastRunAt: p.lastRunAt,
    nextRunAt: p.nextRunAt,
    lastOutputAt: base.output.lastFileAt,
    channel: base.channel,
    avatarUrl: faceUrl(ctx, bot),
  };
}

function fallbackEntry(bot: BotConfig): FleetPresenceEntry {
  return {
    id: bot.id,
    name: bot.name ?? bot.id,
    posture: 'unknown',
    nowLine: 'No presence data.',
    tone: 'muted',
    enabled: bot.enabled !== false,
    running: false,
    isExecuting: false,
    phase: null,
    currentTool: null,
    karma: null,
    pendingAsks: 0,
    unreviewed: 0,
    lastRunAt: null,
    nextRunAt: null,
    lastOutputAt: null,
    channel: { kind: 'headless', state: 'missing' },
    avatarUrl: null,
  };
}

/** Newest first, capped. Exported for tests. */
export function mergeTimeline(items: TimelineItem[], limit = TIMELINE_LIMIT): TimelineItem[] {
  return items
    .filter((i) => i && typeof i.ts === 'string' && i.ts)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .slice(0, limit);
}

function buildTimeline(
  ctx: StatsContext,
  bot: BotConfig,
  workDir: string,
  karmaEvents: KarmaEvent[]
): TimelineItem[] {
  const now = ctx.now();
  const since = now - TIMELINE_WINDOW_MS;
  const items: TimelineItem[] = [];

  for (const e of readLlmEntries(ctx.dirs.llmQueryLog, bot.id, since, now)) {
    const tokens = (e.promptTokens ?? 0) + (e.completionTokens ?? 0);
    items.push({
      ts: e.timestamp,
      kind: 'llm',
      title: `${e.caller} · ${e.model}`,
      detail: e.success
        ? clip(`${tokens ? `${tokens} tokens, ` : ''}${Math.round(e.durationMs / 1000)}s`)
        : clip(e.error ?? 'failed'),
      ok: e.success,
    });
  }
  for (const e of readToolEntries(ctx.dirs.toolAudit, bot.id, since, now)) {
    items.push({
      ts: e.timestamp,
      kind: 'tool',
      title: e.toolName,
      detail: clip(e.result),
      ok: e.success,
    });
  }
  for (const e of safe(() => readEntries(join(workDir, 'changelog.jsonl')), [])) {
    const t = toMs(e.timestamp);
    if (t === null || t < since) continue;
    items.push({
      ts: e.timestamp,
      kind: 'production',
      title: `${e.action} ${e.path}`,
      detail: clip(e.description),
      ok: e.evaluation ? e.evaluation.status !== 'rejected' : null,
    });
  }
  for (const a of readInboxAsks(ctx.dirs.conversations, bot.id)) {
    const t = toMs(a.createdAt);
    if (t === null || t < since) continue;
    items.push({
      ts: a.createdAt,
      kind: 'ask',
      title: `Asked: ${clip(a.title, 80) ?? 'question'}`,
      detail: a.inboxStatus ? `status ${a.inboxStatus}` : null,
      ok: a.inboxStatus === 'answered' ? true : a.inboxStatus === 'pending' ? null : false,
    });
  }
  const schedule = readSchedules(ctx.dirs.scheduler)[bot.id];
  if (Array.isArray(schedule?.recentActions)) {
    for (const a of schedule.recentActions) {
      const t = Number(a.timestamp);
      if (!Number.isFinite(t) || t < since) continue;
      const tools = Array.isArray(a.tools) && a.tools.length ? ` (${a.tools.join(', ')})` : '';
      items.push({
        ts: new Date(t).toISOString(),
        kind: 'cycle',
        title: `Cycle ${Number(a.cycle) || '?'}${tools}`,
        detail: clip(a.planSummary),
        ok: null,
      });
    }
  }
  for (const k of karmaEvents) {
    const t = toMs(k.timestamp);
    if (t === null || t < since) continue;
    const d = Number(k.delta) || 0;
    items.push({
      ts: k.timestamp,
      kind: 'karma',
      title: `Karma ${d > 0 ? '+' : ''}${d}`,
      detail: clip(k.reason),
      ok: d >= 0,
    });
  }
  return mergeTimeline(items);
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function buildAgentHome(
  ctx: StatsContext,
  bot: BotConfig,
  deps: AgentHomeDeps = {}
): AgentHomeResponse {
  const now = ctx.now();
  const base = getBotStats(ctx, bot, '7d');
  const paths = resolveBotPaths(ctx.config, bot);
  const presence = buildPresence(ctx, bot, deps);

  const goals = readGoals(paths.soulDir).detail;
  const completed = goals
    .filter((g) => g.section === 'completed')
    .sort((a, b) => ((a.completed ?? '') < (b.completed ?? '') ? 1 : -1))
    .slice(0, 5);

  const karmaEvents = safe(() => deps.karma?.getRecentEvents?.(bot.id, KARMA_EVENTS) ?? [], []);
  const ascending = [...karmaEvents].sort(
    (a, b) => (toMs(a.timestamp) ?? 0) - (toMs(b.timestamp) ?? 0)
  );
  const score = safe(() => deps.karma?.getScore(bot.id) ?? base.karma.score, base.karma.score);
  const history: Array<{ ts: string; score: number }> = [];
  if (score !== null && ascending.length > 0) {
    const total = ascending.reduce((s, e) => s + (Number(e.delta) || 0), 0);
    let running = score - total;
    for (const e of ascending) {
      running += Number(e.delta) || 0;
      history.push({ ts: e.timestamp, score: Math.max(0, Math.min(100, Math.round(running))) });
    }
  }

  const production = readProductionOutput(paths.workDir);

  return {
    generatedAt: new Date(now).toISOString(),
    identity: {
      id: bot.id,
      name: bot.name,
      description: bot.description ?? null,
      avatarSeed: bot.id,
      enabled: presence.enabled,
      running: presence.running,
      backend: base.backend,
      model: base.model,
      channel: base.channel,
      avatarUrl: avatarUrl(
        bot.id,
        safe(() => findAvatar(paths.soulDir), null)
      ),
      voiceEnabled: Boolean(ctx.config.media?.tts?.apiKey),
    },
    presence,
    goals: {
      active: goals.filter((g) => g.section === 'active' && g.status !== 'blocked'),
      blocked: goals.filter((g) => g.section === 'active' && g.status === 'blocked'),
      completedRecently: completed,
    },
    traits: readTraits(paths.soulDir).stats,
    karma: {
      score,
      trend: safe(() => deps.karma?.getTrend?.(bot.id) ?? 'stable', 'stable'),
      delta7d: base.karma.delta,
      history,
      recentEvents: [...ascending]
        .reverse()
        .slice(0, 10)
        .map((e) => ({
          ts: e.timestamp,
          delta: Number(e.delta) || 0,
          reason: clip(e.reason, 120) ?? '',
          source: String(e.source ?? ''),
        })),
    },
    timeline: buildTimeline(ctx, bot, paths.workDir, karmaEvents),
    needsYou: {
      asks: presence.pendingAsks,
      permissions: safe(() => deps.pendingPermissions?.(bot.id) ?? 0, 0),
      productionsPending: production.unreviewed,
    },
  };
}
