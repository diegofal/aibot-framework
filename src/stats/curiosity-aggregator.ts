/**
 * Curiosity views for `GET /api/stats/curiosity`: topic diversity over time,
 * the explore/exploit mix, and how dispatches landed with the operator, per
 * bot and fleet-wide. Pure composition over the soul-dir curiosity files.
 *
 * History is bounded by the navigator's capped cycle log (`CYCLE_LOG_CAP`
 * entries per bot): older cycles are gone, and `historyStart` says where the
 * record begins.
 */
import { resolveCuriosity } from '../bot/curiosity/config';
import { CYCLE_LOG_CAP, computeTopicConcentration } from '../bot/curiosity/cycle';
import { IGNORED_AFTER_HOURS } from '../bot/curiosity/taste';
import type { CycleTopicEntry, Dispatch } from '../bot/curiosity/types';
import type { BotConfig } from '../config';
import { type StatsContext, windowSince } from './context';
import { resolveBotPaths } from './paths';
import { readCuriosityState } from './readers/curiosity';
import type {
  CuriosityBotStats,
  CuriosityDailyMix,
  CuriosityDiversityPoint,
  CuriosityStatsResponse,
  DispatchLanding,
  DispatchLandingStats,
  StatsWindow,
} from './types';
import { dateKey, median, round, toMs } from './util';

const TOP_TOPICS = 5;
const IGNORED_AFTER_MS = IGNORED_AFTER_HOURS * 3_600_000;

/**
 * How a sent dispatch landed. Mirrors the taste model: no signal 48 h after a
 * Telegram send is "ignored"; an inbox-only dispatch is never ignored (the
 * operator may simply not have opened the dashboard). Held/dropped → null.
 */
export function classifyDispatchLanding(d: Dispatch, nowMs: number): DispatchLanding | null {
  if (d.status !== 'sent') return null;
  if (d.signal) return d.signal;
  if (d.deliveredVia === 'inbox') return 'pending';
  const sent = toMs(d.sentAt ?? d.createdAt);
  if (sent !== null && nowMs - sent >= IGNORED_AFTER_MS) return 'ignored';
  return 'pending';
}

export function dispatchLanding(dispatches: Dispatch[], nowMs: number): DispatchLandingStats {
  const s: DispatchLandingStats = {
    sent: 0,
    up: 0,
    more: 0,
    down: 0,
    ignored: 0,
    pending: 0,
    landingRate: null,
    held: 0,
    dropped: 0,
    medianEditorScore: null,
  };
  const scores: number[] = [];
  for (const d of dispatches) {
    if (typeof d.editorScore === 'number' && Number.isFinite(d.editorScore)) {
      scores.push(d.editorScore);
    }
    if (d.status === 'held') s.held++;
    else if (d.status === 'dropped') s.dropped++;
    const landing = classifyDispatchLanding(d, nowMs);
    if (!landing) continue;
    s.sent++;
    s[landing]++;
  }
  const resolved = s.up + s.more + s.down + s.ignored;
  s.landingRate = resolved > 0 ? round((s.up + s.more) / resolved, 2) : null;
  const m = median(scores);
  s.medianEditorScore = m === null ? null : round(m, 3);
  return s;
}

/**
 * One point per cycle at or after `sinceMs`. Each point's diversity is
 * computed over the trailing `topicWindow` cycles of the whole log, so the
 * first in-window points still see the cycles just before the window.
 */
export function diversityTimeline(
  log: CycleTopicEntry[],
  topicWindow: number,
  sinceMs: number
): CuriosityDiversityPoint[] {
  const valid = log.filter((e) => toMs(e.at) !== null);
  const points: CuriosityDiversityPoint[] = [];
  valid.forEach((e, i) => {
    if ((toMs(e.at) as number) < sinceMs) return;
    const trailing = valid.slice(Math.max(0, i + 1 - topicWindow), i + 1);
    const conc = computeTopicConcentration(trailing, topicWindow);
    points.push({
      at: e.at,
      topic: e.topic,
      mode: e.mode,
      surprised: !!e.surprised,
      distinctTopics: new Set(trailing.map((t) => t.topic)).size,
      dominantShare: round(conc.share, 2),
    });
  });
  return points;
}

/** Cycles bucketed by UTC day, oldest first. */
export function dailyMix(log: CycleTopicEntry[]): CuriosityDailyMix[] {
  const days = new Map<string, CuriosityDailyMix & { topics: Set<string> }>();
  for (const e of log) {
    const ms = toMs(e.at);
    if (ms === null) continue;
    const date = dateKey(ms);
    const d = days.get(date) ?? {
      date,
      cycles: 0,
      explore: 0,
      exploit: 0,
      surprised: 0,
      distinctTopics: 0,
      topics: new Set<string>(),
    };
    d.cycles++;
    if (e.mode === 'explore') d.explore++;
    else d.exploit++;
    if (e.surprised) d.surprised++;
    d.topics.add(e.topic);
    days.set(date, d);
  }
  return [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ topics, ...rest }) => ({ ...rest, distinctTopics: topics.size }));
}

function buildBot(
  ctx: StatsContext,
  bot: BotConfig,
  sinceMs: number,
  nowMs: number
): { stats: CuriosityBotStats; windowDispatches: Dispatch[] } {
  const cfg = resolveCuriosity(ctx.config.agentLoop?.curiosity, bot.agentLoop?.curiosity);
  const { knowledge, navigator, taste, dispatches } = readCuriosityState(
    resolveBotPaths(ctx.config, bot).soulDir
  );

  const topics = Array.isArray(knowledge?.topics) ? knowledge.topics : [];
  const frontier: Record<string, number> = {};
  for (const f of Array.isArray(knowledge?.frontier) ? knowledge.frontier : []) {
    frontier[f.status] = (frontier[f.status] ?? 0) + 1;
  }

  const log = Array.isArray(navigator?.cycleLog) ? navigator.cycleLog : [];
  const inWindow = log.filter((e) => {
    const ms = toMs(e.at);
    return ms !== null && ms >= sinceMs;
  });
  const explore = inWindow.filter((e) => e.mode === 'explore').length;
  const conc = computeTopicConcentration(inWindow, inWindow.length);

  const windowDispatches = dispatches.filter((d) => {
    const ms = toMs(d.createdAt);
    return ms !== null && ms >= sinceMs;
  });

  const direction = navigator?.direction ?? null;
  const cadence = taste?.cadence?.intervalHours;

  return {
    windowDispatches,
    stats: {
      botId: bot.id,
      name: bot.name,
      curiosityEnabled: cfg.enabled,
      topicWindow: cfg.topicWindow,
      knowledge: {
        topics: topics.length,
        findings: topics.reduce((n, t) => n + (t.findings?.length ?? 0), 0),
        surprises: topics.reduce((n, t) => n + (t.surprises?.length ?? 0), 0),
        openQuestions: topics.reduce((n, t) => n + (t.openQuestions?.length ?? 0), 0),
        interests: Array.isArray(knowledge?.interests) ? knowledge.interests.length : 0,
        frontier,
        topTopics: [...topics]
          .sort((a, b) => (b.cycles ?? 0) - (a.cycles ?? 0))
          .slice(0, TOP_TOPICS)
          .map((t) => ({ name: t.name, depth: t.depth ?? 0, cycles: t.cycles ?? 0 })),
        updatedAt: knowledge?.updatedAt ?? null,
      },
      cycles: {
        total: inWindow.length,
        explore,
        exploit: inWindow.length - explore,
        surprised: inWindow.filter((e) => e.surprised).length,
        exploreShare: inWindow.length > 0 ? round(explore / inWindow.length, 2) : null,
        distinctTopics: new Set(inWindow.map((e) => e.topic)).size,
        dominantTopic: conc.dominantTopic,
        dominantShare: inWindow.length > 0 ? round(conc.share, 2) : null,
        historyStart: log[0]?.at ?? null,
      },
      diversity: diversityTimeline(log, cfg.topicWindow, sinceMs),
      daily: dailyMix(inWindow),
      direction: direction
        ? {
            at: direction.at,
            summary: direction.summary,
            bets: (direction.bets ?? []).map((b) => ({ title: b.title, kind: b.kind })),
          }
        : null,
      lastNavigatorAt: navigator?.lastNavigatorAt ?? null,
      cadenceHours: typeof cadence === 'number' ? cadence : null,
      dispatches: dispatchLanding(windowDispatches, nowMs),
    },
  };
}

export function buildCuriosityStats(
  ctx: StatsContext,
  bots: BotConfig[],
  window: StatsWindow
): CuriosityStatsResponse {
  const now = ctx.now();
  const since = windowSince(ctx, window);
  const all: Dispatch[] = [];
  const perBot: CuriosityBotStats[] = [];
  for (const bot of bots) {
    const { stats, windowDispatches } = buildBot(ctx, bot, since, now);
    perBot.push(stats);
    all.push(...windowDispatches);
  }
  return {
    generatedAt: new Date(now).toISOString(),
    window,
    cycleLogCap: CYCLE_LOG_CAP,
    ignoredAfterHours: IGNORED_AFTER_HOURS,
    bots: perBot,
    fleet: {
      cycles: perBot.reduce((n, b) => n + b.cycles.total, 0),
      explore: perBot.reduce((n, b) => n + b.cycles.explore, 0),
      exploit: perBot.reduce((n, b) => n + b.cycles.exploit, 0),
      dispatches: dispatchLanding(all, now),
    },
  };
}
