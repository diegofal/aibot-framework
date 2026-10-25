/**
 * Reads the records `computeMetrics` needs (phase 3), from disk and the
 * watcher's graph. Read-only, never throws: an unreadable source is empty.
 * Paths: `<data>/watcher/` (broadcasts, budget days, canaries, introspection,
 * baseline reports), `<data>/agent-cycles/<bot>/`, each bot's KNOWLEDGE.json.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CuriosityStore } from '../../bot/curiosity/store';
import type { Config } from '../../config';
import { resolveBotPaths, resolveStatsDirs } from '../../stats/paths';
import { readAgentCycles } from '../../stats/readers/agent-cycles';
import { resolveProactiveLimits } from '../../tools/send-proactive-message';
import { readBroadcasts } from '../broadcast';
import type { TierUsage } from '../budget';
import { type Neuron, WATCHER_DEFAULTS, type WatcherConfig } from '../types';
import { type MetricsRecords, type MetricsWindow, windowMs } from './index';

const BUDGET_FILE = /^budget-(\d{4}-\d{2}-\d{2})\.json$/;
const BASELINE_FILE = /^baseline-(\d{4}-\d{2}-\d{2})\.json$/;

function jsonl<T>(path: string): T[] {
  try {
    if (!existsSync(path)) return [];
    const out: T[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // skipped
      }
    }
    return out;
  } catch {
    return [];
  }
}

function files(dir: string, re: RegExp): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => re.test(f))
      .sort();
  } catch {
    return [];
  }
}

const usage = (raw: unknown): TierUsage => {
  const r = (raw ?? {}) as Partial<TierUsage>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return { calls: n(r.calls), tokens: n(r.tokens), costUsd: n(r.costUsd) };
};

export interface LoadMetricsDeps {
  config: Config;
  dir: string;
  neurons: () => Neuron[];
  nowMs: number;
  window: MetricsWindow;
  semaphore?: () => { queuedInteractive: number; activeWatcher: number } | undefined;
}

export function loadMetricsRecords(deps: LoadMetricsDeps): MetricsRecords {
  const { config, dir, nowMs } = deps;
  const from = nowMs - windowMs(deps.window);
  const cfg = (config.watcher as WatcherConfig | undefined) ?? WATCHER_DEFAULTS;
  const bots = Array.isArray(config.bots) ? config.bots : [];

  let neurons: Neuron[] = [];
  try {
    neurons = deps.neurons();
  } catch {
    neurons = [];
  }

  let cyclesDir: string | undefined;
  try {
    cyclesDir = resolveStatsDirs(config).agentCycles;
  } catch {
    cyclesDir = undefined;
  }
  const cycles = cyclesDir
    ? bots.flatMap((b) => {
        try {
          return readAgentCycles(cyclesDir as string, b.id, from, nowMs);
        } catch {
          return [];
        }
      })
    : [];

  const budgetDays = files(dir, BUDGET_FILE).flatMap((f) => {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>;
      const date = (BUDGET_FILE.exec(f) as RegExpExecArray)[1];
      return [{ date, notice: usage(raw.notice), integrate: usage(raw.integrate) }];
    } catch {
      return [];
    }
  });

  const knowledgeSurprises: string[] = [];
  for (const bot of bots) {
    try {
      const map = new CuriosityStore(resolveBotPaths(config, bot).soulDir).loadMap();
      for (const topic of map.topics ?? []) {
        for (const s of topic.surprises ?? [])
          if (typeof s?.text === 'string') knowledgeSurprises.push(s.text);
      }
    } catch {
      // a bot without a map adds nothing
    }
  }

  let baselineIdleShare: number | undefined;
  const latest = files(dir, BASELINE_FILE).pop();
  if (latest) {
    try {
      const report = JSON.parse(readFileSync(join(dir, latest), 'utf-8')) as {
        fleet?: { idleShare?: unknown };
      };
      if (typeof report.fleet?.idleShare === 'number') baselineIdleShare = report.fleet.idleShare;
    } catch {
      baselineIdleShare = undefined;
    }
  }

  let semaphore: MetricsRecords['semaphore'];
  try {
    semaphore = deps.semaphore?.();
  } catch {
    semaphore = undefined;
  }

  return {
    nowMs,
    neurons,
    broadcasts: readBroadcasts(dir),
    cycles,
    budgetDays,
    limits: {
      notice: { maxPerDay: cfg.notice.maxPerDay },
      integrate: {
        maxPerDay: cfg.integrate.maxPerDay,
        maxTokensPerDay: cfg.integrate.maxTokensPerDay,
      },
    },
    canaries: jsonl(join(dir, 'canaries.jsonl')),
    introspection: jsonl(join(dir, 'introspection.jsonl')),
    knowledgeSurprises,
    ...(baselineIdleShare !== undefined ? { baselineIdleShare } : {}),
    proactiveDailyCap: resolveProactiveLimits(config.operator).dailyCap,
    ...(semaphore ? { semaphore } : {}),
    ...(typeof cfg.graph?.targetNeurons === 'number'
      ? { targetNeurons: cfg.graph.targetNeurons }
      : {}),
  };
}
