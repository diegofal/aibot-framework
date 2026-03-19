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

// ── Behavioral Pattern Classification ──

export type ActionType =
  | 'CONTENT'
  | 'OUTREACH'
  | 'RESEARCH'
  | 'ASSESSMENT'
  | 'MAINTENANCE'
  | 'IDLE';

/** Keyword sets for action type classification — each match scores +1 */
const TYPE_KEYWORDS: Array<[ActionType, RegExp]> = [
  ['IDLE', /\b(idle|no.?action|waiting|no.?novel|skip|nothing)\w*/gi],
  ['CONTENT', /\b(creat|writ|generat|produc|draft|compos|file_write|file_edit|archiv)\w*/gi],
  [
    'OUTREACH',
    /\b(send|nudg|check.?in|ask_human|outreach|contact|email|notif|proactiv|reach.?out)\w*/gi,
  ],
  [
    'RESEARCH',
    /\b(search|research|web_search|web_fetch|investig|analyz|explor|fetch|browse|scrap)\w*/gi,
  ],
  [
    'ASSESSMENT',
    /\b(review|evaluat|assess|measur|feedback|impact|result|diagnos|audit|verif|test)\w*/gi,
  ],
  [
    'MAINTENANCE',
    /\b(goal|memory|consolidat|updat.*soul|updat.*identity|improv|reflect|maintain|clean|organiz|manage_goals|save_memory|update_soul)\w*/gi,
  ],
];

/**
 * Classify an action summary into a behavioral type using keyword scoring.
 * Each matching keyword adds +1 to the type's score; highest score wins.
 */
export function classifyAction(summary: string): ActionType {
  if (!summary || summary.trim().length === 0) return 'IDLE';
  const s = summary.toLowerCase();

  const scores: Record<ActionType, number> = {
    CONTENT: 0,
    OUTREACH: 0,
    RESEARCH: 0,
    ASSESSMENT: 0,
    MAINTENANCE: 0,
    IDLE: 0,
  };

  for (const [type, pattern] of TYPE_KEYWORDS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    const matches = s.match(pattern);
    if (matches) scores[type] += matches.length;
  }

  // IDLE is a special case — if any idle keyword matches, return immediately
  if (scores.IDLE > 0) return 'IDLE';

  // Priority order for tie-breaking: outreach > assessment > research > content > maintenance
  let best: ActionType = 'MAINTENANCE';
  let bestScore = 0;
  for (const type of [
    'MAINTENANCE',
    'CONTENT',
    'RESEARCH',
    'ASSESSMENT',
    'OUTREACH',
  ] as ActionType[]) {
    if (scores[type] >= bestScore && scores[type] > 0) {
      bestScore = scores[type];
      best = type;
    }
  }

  return best;
}

export interface ActionDiversityResult {
  entropy: number;
  dominantType: ActionType;
  dominantPct: number;
  distribution: Record<ActionType, number>;
  isRut: boolean;
}

/**
 * Compute Shannon entropy of action type distribution.
 * Returns 0.0 (monotony) to ~1.79 (uniform across 6 types).
 */
export function computeActionDiversity(recentActions: RecentAction[]): ActionDiversityResult {
  const allTypes: ActionType[] = [
    'CONTENT',
    'OUTREACH',
    'RESEARCH',
    'ASSESSMENT',
    'MAINTENANCE',
    'IDLE',
  ];
  const distribution: Record<ActionType, number> = {
    CONTENT: 0,
    OUTREACH: 0,
    RESEARCH: 0,
    ASSESSMENT: 0,
    MAINTENANCE: 0,
    IDLE: 0,
  };

  if (recentActions.length === 0) {
    return { entropy: 0, dominantType: 'IDLE', dominantPct: 0, distribution, isRut: false };
  }

  for (const action of recentActions) {
    const type = classifyAction(action.planSummary);
    distribution[type]++;
  }

  const total = recentActions.length;
  let entropy = 0;
  let dominantType: ActionType = 'IDLE';
  let dominantCount = 0;

  for (const type of allTypes) {
    if (distribution[type] > dominantCount) {
      dominantCount = distribution[type];
      dominantType = type;
    }
    const p = distribution[type] / total;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  const dominantPct = dominantCount / total;
  const isRut = entropy < 0.5 || dominantPct > 0.7;

  return { entropy, dominantType, dominantPct, distribution, isRut };
}

export interface UnconsumedOutputResult {
  outputCount: number;
  feedbackCount: number;
  ratio: number;
  gateTriggered: boolean;
}

/**
 * Count outputs produced vs feedback received in recent actions.
 */
export function detectUnconsumedOutput(
  recentActions: RecentAction[],
  threshold = 5
): UnconsumedOutputResult {
  let outputCount = 0;
  let feedbackCount = 0;

  for (const action of recentActions) {
    const type = classifyAction(action.planSummary);
    if (type === 'CONTENT' || type === 'OUTREACH') {
      outputCount++;
    }
    // Detect feedback signals: responses received, confirmations, assessments with results
    const s = action.planSummary.toLowerCase();
    if (
      /\b(received|confirmed|responded|feedback|approved|denied|answer)\w*/i.test(s) ||
      type === 'ASSESSMENT'
    ) {
      feedbackCount++;
    }
  }

  const ratio = outputCount / Math.max(feedbackCount, 1);
  const gateTriggered = outputCount >= threshold && feedbackCount === 0;

  return { outputCount, feedbackCount, ratio, gateTriggered };
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

  // Action type diversity analysis
  const diversity = computeActionDiversity(recentActions);
  const typeCounts = Object.entries(diversity.distribution)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type}:${count}`)
    .join(', ');
  lines.push('');
  lines.push(
    `Action types: ${typeCounts} (entropy=${diversity.entropy.toFixed(2)}, dominant=${diversity.dominantType} ${Math.round(diversity.dominantPct * 100)}%)`
  );

  if (diversity.isRut) {
    lines.push(
      `⚠️ BEHAVIORAL RUT — ${Math.round(diversity.dominantPct * 100)}% of recent actions are ${diversity.dominantType}. Your next action MUST be a DIFFERENT type.`
    );
  }

  const engagement = detectUnconsumedOutput(recentActions);
  if (engagement.gateTriggered) {
    lines.push(
      `⚠️ ENGAGEMENT GAP — ${engagement.outputCount} outputs produced, ${engagement.feedbackCount} feedback received. Production without feedback is waste. Prioritize ASSESSMENT or OUTREACH.`
    );
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
    // Sort with index.html first for priority visibility when truncated
    entries.sort((a, b) => {
      if (a === 'index.html' || a === 'INDEX.md') return -1;
      if (b === 'index.html' || b === 'INDEX.md') return 1;
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
 * Tolerates bot-stopped-mid-execution: if the soulLoader was removed
 * by a concurrent stopBot(), we skip silently instead of warning.
 */
export function logToMemory(ctx: BotContext, botId: string, summary: string): void {
  try {
    const soulLoader = ctx.soulLoaders.get(botId);
    if (!soulLoader) return;
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
