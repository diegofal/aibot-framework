import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenUsage } from '../core/llm-client';
import type { Logger } from '../logger';

export interface LlmQueryEntry {
  timestamp: string;
  botId: string;
  chatId?: number;
  userId?: string;
  caller:
    | 'conversation'
    | 'planner'
    | 'strategist'
    | 'executor'
    | 'memory_flush'
    | 'compaction'
    | 'overflow_retry'
    | 'topic_guard'
    | 'curiosity:navigator'
    | 'curiosity:extractor'
    | 'curiosity:editor'
    | 'worker'
    | 'watcher:notice'
    | 'watcher:integrate'
    | 'watcher:introspect'
    | 'watcher:consolidate';
  model: string;
  backend: string;
  temperature?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Claude prompt-cache reads and writes, billed apart from `promptTokens`. */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Cost the provider reported (Claude CLI `total_cost_usd`). */
  costUsd?: number;
  /** Claude account that served a claude-cli call (stamped by `append`). */
  account?: string;
  /** Claude CLI sessions of the call (transcripts); several when it was retried. */
  sessionIds?: string[];
  /** Cost and cache tokens filled in later from the CLI transcripts (scripts/usage/backfill-claude-costs.ts). */
  backfilled?: boolean;
  messageCount?: number;
  toolCount?: number;
  durationMs: number;
  attempts?: number;
  success: boolean;
  error?: string;
  /** Agent-loop cycle the call belongs to (absent outside a cycle and on old entries). */
  cycleId?: string;
  /** Goal that cycle served, when known at call time. */
  goalId?: string;
  /** Task worker run (never together with `cycleId`). */
  runId?: string;
  taskId?: string;
  /** Cycle that dispatched the run. */
  dispatchCycleId?: string;
}

/**
 * Persists LLM query entries to daily JSONL files for traceability.
 * Path: {dataDir}/{botId}/YYYY-MM-DD.jsonl
 */
/** The cache and cost fields of a call's usage, only those present (for a query-log entry). */
export function usageExtras(
  usage:
    | Pick<TokenUsage, 'cacheReadTokens' | 'cacheCreationTokens' | 'costUsd' | 'sessionId'>
    | undefined
): Pick<LlmQueryEntry, 'cacheReadTokens' | 'cacheCreationTokens' | 'costUsd' | 'sessionIds'> {
  if (!usage) return {};
  return {
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    ...(usage.sessionId ? { sessionIds: [usage.sessionId] } : {}),
  };
}

/**
 * The Claude account a config dir belongs to: its folder under
 * `claude-accounts/`, or `default` for the original login (src/claude-accounts).
 */
export function claudeAccountOf(configDir: string | undefined): string {
  const parts = (configDir ?? '').split(/[\\/]+/).filter(Boolean);
  const i = parts.lastIndexOf('claude-accounts');
  return i >= 0 && parts[i + 1] ? parts[i + 1] : 'default';
}

export class LlmQueryLog {
  constructor(
    private dataDir: string,
    private logger: Logger
  ) {}

  /** Append an LLM query entry to the daily JSONL file. */
  append(raw: LlmQueryEntry): void {
    const entry =
      raw.backend === 'claude-cli' && !raw.account
        ? { ...raw, account: claudeAccountOf(process.env.CLAUDE_CONFIG_DIR) }
        : raw;
    try {
      const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
      const botDir = join(this.dataDir, entry.botId);
      mkdirSync(botDir, { recursive: true });
      const filePath = join(botDir, `${date}.jsonl`);
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch (err) {
      this.logger.warn({ err, botId: entry.botId }, 'LlmQueryLog: failed to append entry');
    }
  }

  /** Read all entries for a bot on a given date. */
  getEntries(botId: string, date: string): LlmQueryEntry[] {
    const filePath = join(this.dataDir, botId, `${date}.jsonl`);
    if (!existsSync(filePath)) return [];

    const entries: LlmQueryEntry[] = [];
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        this.logger.warn(
          { botId, line: line.slice(0, 100) },
          'LlmQueryLog: skipping malformed line'
        );
      }
    }
    return entries;
  }

  /** Remove all LLM query log files for a bot. Returns true if the directory existed. */
  clearForBot(botId: string): boolean {
    const botDir = join(this.dataDir, botId);
    if (!existsSync(botDir)) return false;
    rmSync(botDir, { recursive: true });
    return true;
  }

  /** List available dates for a bot (sorted newest first). */
  getAvailableDates(botId: string): string[] {
    const botDir = join(this.dataDir, botId);
    if (!existsSync(botDir)) return [];

    return readdirSync(botDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''))
      .sort()
      .reverse();
  }
}
