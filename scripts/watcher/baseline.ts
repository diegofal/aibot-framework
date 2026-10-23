#!/usr/bin/env bun
/**
 * Watcher phase 0: the baseline numbers, from today's fleet records.
 *
 *   bun scripts/watcher/baseline.ts [--days 30] [--json] [--data <dir>] [--config <path>]
 *
 * Read-only over the cycle log, the curiosity knowledge maps and the
 * operator's private chat transcript (assistant turns only); writes one report
 * to `<data>/watcher/baseline-<date>.json`. Never starts the framework and
 * never validates the config through Zod (same plumbing as the system CLIs).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { CuriosityStore } from '../../src/bot/curiosity/store';
import type { Config } from '../../src/config';
import { resolveBotPaths } from '../../src/stats/paths';
import { type AgentCycleRecord, readAgentCycles } from '../../src/stats/readers/agent-cycles';
import { pickPath, pickString } from '../../src/system/effective-config';
import {
  type BaselineKnowledgeMap,
  type ChatReply,
  type ContradictionCandidate,
  type CyclePlan,
  type TopicOverlap,
  chatVsLoopContradictions,
  idleCycleShare,
  medianCycleIntervalMs,
  overlappingTopics,
} from '../../src/watcher/metrics/baseline';
import { cliConfig, fail, parseArgs, resolveCliContext } from '../system-cli';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
/** Recent operator-chat assistant turns compared against the plans. */
const REPLY_COUNT = 20;

export interface BaselineDeps {
  /** Bots plus whatever `resolveBotPaths` needs to find each soul dir. */
  config: Config;
  /** `paths.data`: holds `agent-cycles/` and receives `watcher/`. */
  dataDir: string;
  /** `session.dataDir`; defaults to `config.session.dataDir`, then `<data>/sessions`. */
  sessionsDir?: string;
  /** `operator.telegramChatId`. Without it no transcript is read. */
  operatorChatId?: number;
  now?: () => number;
  write?: (line: string) => void;
}

export interface BotBaseline {
  botId: string;
  cycles: number;
  idleShare: number;
  medianIntervalMs: number;
  topics: number;
  contradictionCandidates: number;
}

export interface BaselineReport {
  generatedAt: string;
  windowDays: number;
  bots: BotBaseline[];
  fleet: {
    cycles: number;
    idleShare: number;
    medianIntervalMs: number;
    overlappingTopics: TopicOverlap[];
    contradictions: ContradictionCandidate[];
  };
  path: string;
}

function dateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Assistant turns of the operator's private chat with a bot, newest last.
 * Only the operator's chat: never another user's transcript. Never throws.
 */
export function readOperatorReplies(
  sessionsDir: string,
  botId: string,
  operatorChatId: number,
  count = REPLY_COUNT
): string[] {
  // Same layout as SessionManager.transcriptPath (src/session.ts).
  const file = `bot-${botId}-private-${operatorChatId}.jsonl`;
  const candidates = [
    join(sessionsDir, 'transcripts', botId, file),
    join(sessionsDir, 'transcripts', file),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return [];
  let raw = '';
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg?.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim()) {
        out.push(msg.content.trim());
      }
    } catch {
      // malformed line: skipped
    }
  }
  return out.slice(-count);
}

function fmtHours(ms: number): string {
  return ms === 0 ? '-' : `${(ms / 3_600_000).toFixed(1)}h`;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function renderTable(report: BaselineReport): string[] {
  const rows = [
    ['bot', 'cycles', 'idle', 'median gap', 'topics', 'chat/plan candidates'],
    ...report.bots.map((b) => [
      b.botId,
      String(b.cycles),
      pct(b.idleShare),
      fmtHours(b.medianIntervalMs),
      String(b.topics),
      String(b.contradictionCandidates),
    ]),
    [
      'FLEET',
      String(report.fleet.cycles),
      pct(report.fleet.idleShare),
      fmtHours(report.fleet.medianIntervalMs),
      `${report.fleet.overlappingTopics.length} shared`,
      String(report.fleet.contradictions.length),
    ],
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const lines = rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join('  '));
  lines.push('', `Window: ${report.windowDays} days. Report: ${report.path}`);
  for (const o of report.fleet.overlappingTopics) {
    lines.push(`  shared topic "${o.topic}": ${o.bots.map((b) => b.botId).join(', ')}`);
  }
  return lines;
}

export async function run(argv: string[], deps: BaselineDeps): Promise<BaselineReport> {
  const args = parseArgs(argv);
  const days = Number(args.values.get('days') ?? DEFAULT_DAYS);
  const windowDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS;
  const now = deps.now?.() ?? Date.now();
  const since = now - windowDays * DAY_MS;
  const write = deps.write ?? ((l: string) => process.stdout.write(`${l}\n`));
  const cyclesDir = join(deps.dataDir, 'agent-cycles');
  const sessionsDir =
    deps.sessionsDir ?? deps.config.session?.dataDir ?? join(deps.dataDir, 'sessions');

  const bots: BotBaseline[] = [];
  const allCycles: AgentCycleRecord[] = [];
  const maps: Record<string, BaselineKnowledgeMap> = {};
  const contradictions: ContradictionCandidate[] = [];

  for (const bot of deps.config.bots ?? []) {
    const cycles = readAgentCycles(cyclesDir, bot.id, since, now).map((c) => ({
      ...c,
      botId: bot.id,
    }));
    allCycles.push(...cycles);
    const { soulDir } = resolveBotPaths(deps.config, bot);
    const map = new CuriosityStore(soulDir).loadMap();
    maps[bot.id] = { topics: Array.isArray(map.topics) ? map.topics : [] };

    const replies: ChatReply[] =
      deps.operatorChatId === undefined
        ? []
        : readOperatorReplies(sessionsDir, bot.id, deps.operatorChatId).map((text) => ({
            botId: bot.id,
            text,
          }));
    const plans: CyclePlan[] = cycles
      .map((c) => ({ botId: bot.id, cycleId: c.cycleId, text: c.planSummary ?? c.focus ?? '' }))
      .filter((p) => p.text);
    const candidates = chatVsLoopContradictions(replies, plans);
    contradictions.push(...candidates);

    bots.push({
      botId: bot.id,
      cycles: cycles.length,
      idleShare: idleCycleShare(cycles),
      medianIntervalMs: medianCycleIntervalMs(cycles),
      topics: maps[bot.id].topics.length,
      contradictionCandidates: candidates.length,
    });
  }

  const outDir = join(deps.dataDir, 'watcher');
  const report: BaselineReport = {
    generatedAt: new Date(now).toISOString(),
    windowDays,
    bots,
    fleet: {
      cycles: allCycles.length,
      idleShare: idleCycleShare(allCycles),
      medianIntervalMs: medianCycleIntervalMs(allCycles),
      overlappingTopics: overlappingTopics(maps),
      contradictions,
    },
    path: join(outDir, `baseline-${dateKey(now)}.json`),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(report.path, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  if (args.flags.has('json')) write(JSON.stringify(report, null, 2));
  else for (const line of renderTable(report)) write(line);
  return report;
}

/** `paths.data` from the raw config, absolute against the root; `--data` wins. */
export function cliDataDir(
  argData: string | undefined,
  rawConfig: unknown,
  rootDir: string
): string {
  const value = argData ?? pickString(rawConfig, ['paths', 'data'], './data');
  return isAbsolute(value) ? value : resolve(rootDir, value);
}

/** `operator.telegramChatId` from the raw config, when it is a number. */
export function cliOperatorChatId(rawConfig: unknown): number | undefined {
  const v = pickPath(rawConfig, ['operator', 'telegramChatId']);
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const context = resolveCliContext(args);
  run(argv, {
    config: cliConfig(context),
    dataDir: cliDataDir(args.values.get('data'), context.rawConfig, context.rootDir),
    operatorChatId: cliOperatorChatId(context.rawConfig),
  }).catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
