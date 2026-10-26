#!/usr/bin/env bun
/**
 * One-off (review 2026-10-25): judge the already-resolved watcher predictions
 * again with the ground-truth judge (`judgePrediction` in
 * src/watcher/outcomes.ts: the tool audit and cycle log of the bots each one
 * names, the new `happened | did_not_happen | unknown` answer). The old judge
 * read only the watcher's own rows and scored every one `happened: false`.
 *
 *   bun scripts/watcher/rejudge.ts [--dry-run] [--apply] [--limit N] [--config <path>]
 *
 * Admin, inside the container. Dry run by default: prints old → new per
 * prediction and writes nothing. `--apply` writes the new resolution onto the
 * neuron (`outcome`, `happened`/`brier` or none for `unknown`, `evidence`,
 * `resolvedModel`) plus `meta.rejudgedAt` and `meta.previousHappened`;
 * `resolvedAt` stays. A prediction already re-judged is skipped, so a second
 * run is a no-op. Calls go through the notice tier's budget and the query
 * log like the watcher's own.
 *
 * With `--apply`, stop the watcher first (dashboard → Watcher → Stop): the
 * running process owns the graph files and would compact its in-memory copy
 * over these writes. Start it again afterwards; `start()` reloads the graph.
 */
import { join } from 'node:path';
import { LlmQueryLog } from '../../src/bot/llm-query-log';
import { loadConfig } from '../../src/config';
import { resolveStatsDirs } from '../../src/stats/paths';
import { readAgentCycles } from '../../src/stats/readers/agent-cycles';
import { DailyBudget } from '../../src/watcher/budget';
import { Graph } from '../../src/watcher/graph';
import { createWatcherClients, instrumented } from '../../src/watcher/llm';
import { WatcherLog } from '../../src/watcher/log';
import {
  type JudgeDeps,
  type PredictionOutcome,
  judgePrediction,
  resolutionMeta,
  watcherLogLines,
} from '../../src/watcher/outcomes';
import { watcherDir, watcherLogDir } from '../../src/watcher/paths';
import type { Neuron, WatcherConfig } from '../../src/watcher/types';
import { fleetToolCalls } from '../../src/watcher/watcher';
import { createCliLogger, fail, parseArgs } from '../system-cli';

export interface RejudgeArgs {
  apply: boolean;
  limit?: number;
}

export function parseRejudgeArgs(argv: string[]): RejudgeArgs {
  const args = parseArgs(argv);
  const limit = Number(args.values.get('limit'));
  return {
    apply: args.flags.has('apply'),
    ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
  };
}

export interface RejudgeRow {
  id: string;
  text: string;
  previous: PredictionOutcome;
  /** null: the answer was unreadable or the call failed; the prediction is left as it was. */
  next: PredictionOutcome | null;
  evidence?: string;
  changed: boolean;
}

export interface RejudgeDeps extends JudgeDeps {
  graph: Pick<Graph, 'list' | 'patchMeta'>;
  now: () => number;
  apply: boolean;
  limit?: number;
}

export interface RejudgeReport {
  rows: RejudgeRow[];
  applied: number;
  stopped?: 'cap' | 'tokens' | 'breaker';
}

const previousOf = (n: Neuron): PredictionOutcome => {
  const o = n.meta?.outcome;
  if (o === 'happened' || o === 'did_not_happen' || o === 'unknown') return o;
  return n.meta?.happened === 'true' ? 'happened' : 'did_not_happen';
};

/** Resolved predictions not re-judged yet, oldest resolution first. */
function rejudgeable(graph: Pick<Graph, 'list'>): Neuron[] {
  return graph
    .list()
    .filter(
      (n) =>
        n.kind === 'prediction' &&
        !!n.meta?.resolvedAt &&
        !n.meta?.rejudgedAt &&
        Number.isFinite(Date.parse(n.meta?.dueAt ?? ''))
    )
    .sort((a, b) => Date.parse(a.meta?.resolvedAt ?? '') - Date.parse(b.meta?.resolvedAt ?? ''));
}

/** Judge again; write only with `apply`. A refused call (budget, breaker) stops the run. Never throws. */
export async function runRejudge(deps: RejudgeDeps): Promise<RejudgeReport> {
  const todo = rejudgeable(deps.graph).slice(0, deps.limit ?? Number.POSITIVE_INFINITY);
  const rows: RejudgeRow[] = [];
  let applied = 0;
  for (const p of todo) {
    const previous = previousOf(p);
    const judged = await judgePrediction(p, deps);
    if (judged.kind === 'stop') return { rows, applied, stopped: judged.reason };
    if (judged.kind === 'skip') {
      rows.push({ id: p.id, text: p.text, previous, next: null, changed: false });
      continue;
    }
    const next = judged.resolution.outcome;
    rows.push({
      id: p.id,
      text: p.text,
      previous,
      next,
      ...(judged.resolution.evidence ? { evidence: judged.resolution.evidence } : {}),
      changed: next !== previous,
    });
    if (!deps.apply) continue;
    const { set, remove } = resolutionMeta(
      p,
      judged.resolution,
      p.meta?.resolvedAt as string,
      judged.call?.model
    );
    deps.graph.patchMeta(
      p.id,
      {
        ...set,
        rejudgedAt: new Date(deps.now()).toISOString(),
        previousHappened: p.meta?.happened ?? '',
      },
      remove
    );
    applied++;
  }
  return { rows, applied };
}

async function main(argv: string[]): Promise<void> {
  const args = parseRejudgeArgs(argv);
  const raw = parseArgs(argv);
  const logger = createCliLogger(raw.flags.has('verbose'));
  const configPath =
    raw.values.get('config') ?? process.env.AIBOT_CONFIG_PATH ?? './config/config.json';
  const config = await loadConfig(configPath);
  const cfg = (config.watcher as WatcherConfig | undefined) ?? undefined;
  if (!cfg) fail('no watcher config');
  const dir = watcherDir(config);
  const graph = new Graph(dir, { logger });
  graph.load();
  const log = new WatcherLog(watcherLogDir(dir), { logger });
  const tier = createWatcherClients(config, { logger }).notice;
  const client = instrumented(tier, {
    tier: 'notice',
    caller: 'watcher:notice',
    budget: new DailyBudget({ dir, limits: () => cfg }),
    queryLog: new LlmQueryLog(join(config.paths.data, 'llm-query-log'), logger),
  });
  const cyclesDir = resolveStatsDirs(config).agentCycles;
  const report = await runRejudge({
    graph,
    client,
    events: (from, to) => watcherLogLines(log, from, to),
    groundTruth: {
      bots: () =>
        (config.bots ?? []).map((b) => ({
          id: b.id,
          name: graph.findByKey(`bot:${b.id}`)?.meta?.name ?? b.name ?? b.id,
          ...(b.name ? { aliases: [b.name] } : {}),
        })),
      tools: fleetToolCalls(config),
      cycles: (botId, from, to) => readAgentCycles(cyclesDir, botId, from, to),
    },
    logger,
    now: Date.now,
    apply: args.apply,
    ...(args.limit ? { limit: args.limit } : {}),
  });
  for (const r of report.rows) {
    const mark = r.next === null ? '?' : r.changed ? '*' : ' ';
    process.stdout.write(
      `${mark} ${r.id} ${r.previous} → ${r.next ?? 'unreadable'}  ${r.text}\n${r.evidence ? `    ${r.evidence}\n` : ''}`
    );
  }
  const changed = report.rows.filter((r) => r.changed).length;
  process.stdout.write(
    `\n${report.rows.length} judged, ${changed} changed, ${report.applied} written${
      args.apply ? '' : ' (dry run: --apply to write)'
    }${report.stopped ? `; stopped: ${report.stopped}` : ''}\n`
  );
  if (args.apply) graph.compact();
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) =>
    fail(err instanceof Error ? err.message : String(err))
  );
}
