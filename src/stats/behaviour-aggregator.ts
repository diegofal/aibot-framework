/**
 * Cross-bot behavioural views for `GET /api/stats/behaviour`: production that
 * never got human feedback, ask economics by question length, the
 * collaboration graph, mesh output and trait variance/drift across the fleet.
 */
import type { BotConfig } from '../config';
import { type StatsContext, getLogSignals, windowSince } from './context';
import { resolveBotPaths } from './paths';
import { readInboxAsks } from './readers/conversations';
import { readMeshCounts } from './readers/mesh';
import { countContentEntriesSince } from './readers/productions';
import { readFeedbackLastAt, readTraits } from './readers/soul';
import { engagementFromTools, readToolEntries } from './readers/tool-audit';
import type { AskBucket, AskDetail, BehaviourResponse, StatsWindow, TraitSnapshot } from './types';
import { median, round, toIso, toMs } from './util';

const BUCKETS: AskBucket[] = ['<300', '300-600', '600-1200', '>1200'];
const MAX_VARIANCE_POINTS = 60;

export function askBucket(chars: number): AskBucket {
  if (chars < 300) return '<300';
  if (chars < 600) return '300-600';
  if (chars <= 1200) return '600-1200';
  return '>1200';
}

export function askEconomics(asks: AskDetail[]): BehaviourResponse['askEconomics'] {
  const perBucket = new Map<AskBucket, { sent: number; answered: number; times: number[] }>();
  for (const b of BUCKETS) perBucket.set(b, { sent: 0, answered: 0, times: [] });
  for (const a of asks) {
    const slot = perBucket.get(askBucket(a.questionChars));
    if (!slot) continue;
    slot.sent++;
    const created = toMs(a.createdAt);
    const answered = toMs(a.answeredAt);
    if (answered !== null) {
      slot.answered++;
      if (created !== null && answered >= created) slot.times.push(answered - created);
    }
  }
  return {
    buckets: BUCKETS.map((bucket) => {
      const s = perBucket.get(bucket) ?? { sent: 0, answered: 0, times: [] };
      return { bucket, sent: s.sent, answered: s.answered, medianTimeToAnswerMs: median(s.times) };
    }),
  };
}

/**
 * Variance of each trait across the fleet at every snapshot timestamp. For a
 * timestamp t each bot contributes its latest snapshot at or before t; bots
 * with no snapshot by then are skipped (they have not started evolving).
 */
export function traitVarianceTimeline(
  histories: Record<string, TraitSnapshot[]>
): Array<{ timestamp: number; variance: Record<string, number> }> {
  const bots = Object.entries(histories).filter(([, h]) => h.length > 0);
  if (bots.length === 0) return [];
  const timestamps = [...new Set(bots.flatMap(([, h]) => h.map((s) => s.timestamp)))]
    .sort((a, b) => a - b)
    .slice(-MAX_VARIANCE_POINTS);

  return timestamps.map((timestamp) => {
    const perTrait = new Map<string, number[]>();
    for (const [, history] of bots) {
      let latest: TraitSnapshot | null = null;
      for (const s of history) if (s.timestamp <= timestamp) latest = s;
      if (!latest) continue;
      for (const [name, value] of Object.entries(latest.traits)) {
        const arr = perTrait.get(name) ?? [];
        arr.push(Number(value) || 0);
        perTrait.set(name, arr);
      }
    }
    const variance: Record<string, number> = {};
    for (const [name, values] of perTrait) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      variance[name] = round(
        values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length,
        4
      );
    }
    return { timestamp, variance };
  });
}

export function fleetDriftVector(drifts: Array<Record<string, number>>): Record<string, number> {
  const sums = new Map<string, { total: number; n: number }>();
  for (const d of drifts) {
    for (const [name, value] of Object.entries(d)) {
      const s = sums.get(name) ?? { total: 0, n: 0 };
      s.total += Number(value) || 0;
      s.n++;
      sums.set(name, s);
    }
  }
  const out: Record<string, number> = {};
  for (const [name, s] of sums) out[name] = round(s.total / s.n, 3);
  return out;
}

export function buildBehaviour(
  ctx: StatsContext,
  bots: BotConfig[],
  window: StatsWindow
): BehaviourResponse {
  const now = ctx.now();
  const since = windowSince(ctx, window);
  const logs = getLogSignals(ctx, window);
  const scoped = new Set(bots.map((b) => b.id));

  const productionWithoutFeedback: BehaviourResponse['productionWithoutFeedback'] = [];
  const allAsks: AskDetail[] = [];
  const edges = new Map<string, { from: string; to: string; calls: number; failed: number }>();
  const histories: Record<string, TraitSnapshot[]> = {};
  const drifts: Array<Record<string, number>> = [];

  for (const bot of bots) {
    const paths = resolveBotPaths(ctx.config, bot);

    const lastFeedback = readFeedbackLastAt(paths.soulDir);
    const outputsSinceFeedback = countContentEntriesSince(paths.workDir, lastFeedback ?? 0);
    if (outputsSinceFeedback > 0) {
      productionWithoutFeedback.push({
        botId: bot.id,
        outputsSinceFeedback,
        lastFeedbackAt: toIso(lastFeedback),
      });
    }

    for (const a of readInboxAsks(ctx.dirs.conversations, bot.id)) {
      const t = toMs(a.createdAt);
      if (t === null || t >= since) allAsks.push(a);
    }

    const tools = readToolEntries(ctx.dirs.toolAudit, bot.id, since, now);
    for (const e of engagementFromTools(tools, bot.id).edges) {
      edges.set(`${e.from}→${e.to}`, { ...e });
    }

    const traits = readTraits(paths.soulDir);
    histories[bot.id] = traits.history;
    if (traits.stats.drift) drifts.push(traits.stats.drift);
  }

  // Send failures the tool audit never saw (e.g. thrown before the audit
  // record) only add an edge when the audit has none for that pair.
  for (const f of logs.collaborateFailed) {
    if (!scoped.has(f.from)) continue;
    const key = `${f.from}→${f.to}`;
    if (!edges.has(key)) edges.set(key, { from: f.from, to: f.to, calls: 1, failed: 1 });
  }

  const nodeIds = new Set<string>(bots.map((b) => b.id));
  for (const e of edges.values()) nodeIds.add(e.to);

  const meshAll = readMeshCounts(ctx.dirs.mesh, since);
  const meshByBot: Record<string, number> = {};
  let meshTotal = 0;
  for (const [botId, n] of Object.entries(meshAll.byBot)) {
    if (!scoped.has(botId)) continue;
    meshByBot[botId] = n;
    meshTotal += n;
  }

  productionWithoutFeedback.sort((a, b) => b.outputsSinceFeedback - a.outputsSinceFeedback);

  return {
    generatedAt: new Date(now).toISOString(),
    window,
    productionWithoutFeedback,
    askEconomics: askEconomics(allAsks),
    collaboration: {
      nodes: [...nodeIds].sort().map((botId) => ({ botId })),
      edges: [...edges.values()].sort((a, b) =>
        `${a.from}→${a.to}`.localeCompare(`${b.from}→${b.to}`)
      ),
    },
    mesh: { byBot: meshByBot, total: meshTotal },
    traitVariance: traitVarianceTimeline(histories),
    fleetDriftVector: fleetDriftVector(drifts),
  };
}
