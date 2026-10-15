/**
 * Usage per bot (Insights → Usage): calls, tokens as Claude bills them (input,
 * prompt-cache reads and writes, output), the cost the CLI reported, by
 * caller, by Claude account and by day. Read from the LLM query log; entries
 * written before 2026-10-15 carry no cache tokens or cost, so the response
 * says since when cost is known (`costReportedSince`).
 */
import type { BotConfig } from '../config';
import type { StatsContext } from './context';
import { type LlmQueryEntry, readLlmEntries } from './readers/llm-query-log';
import type { StatsWindow } from './types';
import { windowToMs } from './util';

export interface UsageRow {
  calls: number;
  failed: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface UsageDay {
  date: string;
  calls: number;
  totalTokens: number;
  costUsd: number;
}

export interface BotUsage extends UsageRow {
  botId: string;
  name: string;
  byCaller: Record<string, UsageRow>;
  byAccount: Record<string, UsageRow>;
  daily: UsageDay[];
}

export interface UsageResponse {
  window: StatsWindow;
  generatedAt: string;
  fleet: UsageRow & { byAccount: Record<string, UsageRow> };
  bots: BotUsage[];
  /** Oldest entry in the window that carries a cost; null when none does. */
  costReportedSince: string | null;
}

const DAY_MS = 86_400_000;

const emptyRow = (): UsageRow => ({
  calls: 0,
  failed: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  durationMs: 0,
});

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function add(row: UsageRow, e: LlmQueryEntry): void {
  const input = n(e.promptTokens);
  const read = n(e.cacheReadTokens);
  const write = n(e.cacheCreationTokens);
  const output = n(e.completionTokens);
  row.calls++;
  if (!e.success) row.failed++;
  row.inputTokens += input;
  row.cacheReadTokens += read;
  row.cacheCreationTokens += write;
  row.outputTokens += output;
  row.totalTokens += input + read + write + output;
  row.costUsd += n(e.costUsd);
  row.durationMs += n(e.durationMs);
}

/** Pure: the usage response from each bot's entries in the window. */
export function summarizeUsage(
  entriesByBot: Record<string, LlmQueryEntry[]>,
  names: Record<string, string>,
  window: StatsWindow,
  nowMs: number
): UsageResponse {
  const days = Math.max(1, Math.ceil(windowToMs(window) / DAY_MS));
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(nowMs - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10)
  );
  const fleet = { ...emptyRow(), byAccount: {} as Record<string, UsageRow> };
  let costSince: string | null = null;

  const bots: BotUsage[] = Object.entries(entriesByBot).map(([botId, entries]) => {
    const bot: BotUsage = {
      botId,
      name: names[botId] ?? botId,
      ...emptyRow(),
      byCaller: {},
      byAccount: {},
      daily: dates.map((date) => ({ date, calls: 0, totalTokens: 0, costUsd: 0 })),
    };
    for (const e of entries) {
      add(bot, e);
      add(fleet, e);
      add((bot.byCaller[e.caller || 'unknown'] ??= emptyRow()), e);
      if (e.account) {
        add((bot.byAccount[e.account] ??= emptyRow()), e);
        add((fleet.byAccount[e.account] ??= emptyRow()), e);
      }
      const day = bot.daily.find((d) => d.date === e.timestamp.slice(0, 10));
      if (day) {
        day.calls++;
        day.totalTokens +=
          n(e.promptTokens) +
          n(e.cacheReadTokens) +
          n(e.cacheCreationTokens) +
          n(e.completionTokens);
        day.costUsd += n(e.costUsd);
      }
      if (typeof e.costUsd === 'number' && (!costSince || e.timestamp < costSince))
        costSince = e.timestamp;
    }
    return bot;
  });

  bots.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  return {
    window,
    generatedAt: new Date(nowMs).toISOString(),
    fleet,
    bots,
    costReportedSince: costSince,
  };
}

/** Claude CLI sessions no bot could be tied to (scripts/usage/backfill-claude-costs.ts). */
export const UNATTRIBUTED_BOT = '_unattributed';

export function buildUsage(
  ctx: StatsContext,
  bots: BotConfig[],
  window: StatsWindow,
  opts: { includeUnattributed?: boolean } = {}
): UsageResponse {
  const now = ctx.now();
  const since = now - windowToMs(window);
  const entries: Record<string, LlmQueryEntry[]> = {};
  const names: Record<string, string> = {};
  const ids = bots.map((b) => b.id);
  for (const bot of bots) names[bot.id] = bot.name ?? bot.id;
  if (opts.includeUnattributed) {
    ids.push(UNATTRIBUTED_BOT);
    names[UNATTRIBUTED_BOT] = 'Not attributed to a bot';
  }
  for (const id of ids) {
    try {
      entries[id] = readLlmEntries(ctx.dirs.llmQueryLog, id, since, now);
    } catch {
      entries[id] = [];
    }
  }
  if (opts.includeUnattributed && entries[UNATTRIBUTED_BOT].length === 0)
    delete entries[UNATTRIBUTED_BOT];
  return summarizeUsage(entries, names, window, now);
}
