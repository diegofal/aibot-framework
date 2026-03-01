import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sendLongMessage } from './telegram-utils';
import type { BotContext } from './types';

/**
 * Represents a single recent action in the schedule tracker.
 */
export interface RecentAction {
  cycle: number;
  timestamp: number;
  tools: string[];
  planSummary: string;
}

/**
 * Build a digest of recent actions for the planner to detect repetition.
 */
export function buildRecentActionsDigest(recentActions: RecentAction[]): string | null {
  if (recentActions.length === 0) return null;

  const now = Date.now();
  const lines: string[] = ['## Recent Actions (last 24h)'];

  // Group actions and detect repeats
  const summaryCount = new Map<string, number>();
  for (const action of recentActions) {
    const normalized = action.planSummary.toLowerCase().replace(/\s+/g, ' ').trim();
    summaryCount.set(normalized, (summaryCount.get(normalized) ?? 0) + 1);
  }

  for (const action of recentActions) {
    const hoursAgo = Math.round((now - action.timestamp) / 3_600_000);
    const toolsStr = action.tools.length > 0 ? ` (${action.tools.join(', ')})` : '';
    const normalized = action.planSummary.toLowerCase().replace(/\s+/g, ' ').trim();
    const count = summaryCount.get(normalized) ?? 0;
    const repeatTag = count >= 3 ? ` ← REPEATED x${count}` : count >= 2 ? ' ← REPEATED' : '';
    lines.push(`- ${hoursAgo}h ago: ${action.planSummary}${toolsStr}${repeatTag}`);
  }

  // Identify exhausted patterns
  const exhausted: string[] = [];
  for (const [summary, count] of summaryCount) {
    if (count >= 3) {
      exhausted.push(summary.slice(0, 60));
    }
  }

  if (exhausted.length > 0) {
    lines.push('');
    lines.push(`EXHAUSTED PATTERNS (done 3+ times): ${exhausted.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Check if two summaries are semantically similar (for memory dedup).
 * Strips timestamps before comparing.
 */
export function isSimilarSummary(a: string, b: string): boolean {
  if (!a || !b) return false;
  const normalize = (s: string) =>
    s
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/gi, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  return normalize(a) === normalize(b);
}

/**
 * Check if the current plan summary matches a pattern done 3+ times in recentActions.
 */
export function isRepetitiveAction(recentActions: RecentAction[], planSummary: string): boolean {
  const normalized = planSummary.toLowerCase().replace(/\s+/g, ' ').trim();
  let count = 0;
  for (const action of recentActions) {
    const actionNorm = action.planSummary.toLowerCase().replace(/\s+/g, ' ').trim();
    if (actionNorm === normalized) count++;
  }
  return count >= 3;
}

/**
 * Scan a directory tree up to MAX_DEPTH and MAX_ENTRIES for the executor prompt.
 * Returns a formatted tree string, or null if the directory is empty or missing.
 */
export function scanFileTree(dirPath: string): string | null {
  const MAX_DEPTH = 3;
  const MAX_ENTRIES = 100;
  let count = 0;

  if (!existsSync(dirPath)) return null;

  const walk = (dir: string, depth: number, prefix: string): string[] => {
    if (depth > MAX_DEPTH || count >= MAX_ENTRIES) return [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    // Sort with INDEX.md first for priority visibility when truncated
    entries.sort((a, b) => {
      if (a === 'INDEX.md') return -1;
      if (b === 'INDEX.md') return 1;
      return a.localeCompare(b);
    });
    const lines: string[] = [];
    for (const entry of entries) {
      if (count >= MAX_ENTRIES) {
        lines.push(`${prefix}... (truncated)`);
        break;
      }
      const fullPath = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(fullPath).isDirectory();
      } catch {
        isDir = false;
      }
      count++;
      if (isDir) {
        lines.push(`${prefix}${entry}/`);
        lines.push(...walk(fullPath, depth + 1, `${prefix}  `));
      } else {
        lines.push(`${prefix}${entry}`);
      }
    }
    return lines;
  };

  const lines = walk(dirPath, 0, '');
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Log a summary to the bot's daily memory file.
 */
export function logToMemory(ctx: BotContext, botId: string, summary: string): void {
  try {
    const soulLoader = ctx.getSoulLoader(botId);
    const truncated = summary.length > 500 ? `${summary.slice(0, 500)}...` : summary;
    soulLoader.appendDailyMemory(`[agent-loop] ${truncated}`);
  } catch (err) {
    ctx.logger.warn({ err, botId }, 'Agent loop: failed to log to memory');
  }
}

/**
 * Send an agent loop report to a Telegram chat.
 */
export async function sendReport(
  ctx: BotContext,
  botId: string,
  chatId: number,
  summary: string
): Promise<void> {
  const bot = ctx.bots.get(botId);
  if (!bot) return;

  const header = '🤖 **Agent Loop Report**\n\n';
  const report = header + summary;
  try {
    await sendLongMessage((t) => bot.api.sendMessage(chatId, t), report);
  } catch (err) {
    ctx.getBotLogger(botId).warn({ err, chatId }, 'Agent loop: failed to send report');
  }
}
