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
  /** Human signals supplied by the caller (see `countFeedbackSignals`) */
  feedbackCount: number;
  /** Same value as `feedbackCount` — kept for callers reading the raw input */
  externalFeedbackCount: number;
  ratio: number;
  gateTriggered: boolean;
  /** Where `outputCount` came from */
  outputSource: 'durable' | 'recent-actions';
}

/** An outcome-ledger entry, reduced to what the gate needs. */
export interface DurableOutputEntry {
  timestamp: number;
  type: ActionType;
}

/** A production changelog entry, reduced to what the gate needs. */
export interface ProductionOutputEntry {
  timestamp: string;
  action: string;
}

/**
 * Outputs (CONTENT / OUTREACH productions) recorded strictly after `sinceTs`.
 * Pure over the outcome ledger's persisted shape — the ledger survives
 * container restarts, unlike the in-memory recent-actions window.
 */
export function countOutputsSince(entries: DurableOutputEntry[], sinceTs: number): number {
  let n = 0;
  for (const e of entries) {
    if (!Number.isFinite(e.timestamp) || e.timestamp <= sinceTs) continue;
    if (e.type === 'CONTENT' || e.type === 'OUTREACH') n++;
  }
  return n;
}

/** Production changelog `create` / `edit` entries recorded strictly after `sinceTs`. */
export function countProductionOutputsSince(
  entries: ProductionOutputEntry[],
  sinceTs: number
): number {
  let n = 0;
  for (const e of entries) {
    if (e.action !== 'create' && e.action !== 'edit') continue;
    const t = toMs(e.timestamp);
    if (Number.isFinite(t) && t > sinceTs) n++;
  }
  return n;
}

/**
 * Durable output count for the engagement gate: the outcome ledger is the
 * primary source; the production changelog covers bots whose ledger is not
 * wired (or was reset) so the gate never silently reads zero.
 */
export function resolveDurableOutputCount(
  sources: {
    outcomeEntries?: DurableOutputEntry[];
    productionEntries?: ProductionOutputEntry[];
  },
  sinceTs: number
): number {
  const fromLedger = countOutputsSince(sources.outcomeEntries ?? [], sinceTs);
  if (fromLedger > 0) return fromLedger;
  return countProductionOutputsSince(sources.productionEntries ?? [], sinceTs);
}

/**
 * Count outputs produced vs human feedback received.
 *
 * `durableOutputCount` — outputs counted from the outcome ledger / production
 * changelog since the last human signal — is authoritative when supplied: the
 * `recentActions` window is in-memory and resets on every restart, which made
 * the gate inert in production. The window count is only a fallback for
 * callers that have no durable source (the planner digest, tests).
 *
 * `externalFeedbackCount` carries the human signals the action log cannot see —
 * production approvals/rejections, answered ask_human questions, human inbound
 * messages (see `countFeedbackSignals`). It is the *only* feedback source: a
 * plan summary that merely mentions "feedback", and an ASSESSMENT the bot
 * performs on itself, are not feedback from anyone.
 */
export function detectUnconsumedOutput(
  recentActions: RecentAction[],
  threshold = 5,
  externalFeedbackCount = 0,
  durableOutputCount?: number
): UnconsumedOutputResult {
  let windowOutputCount = 0;
  for (const action of recentActions) {
    const type = classifyAction(action.planSummary);
    if (type === 'CONTENT' || type === 'OUTREACH') windowOutputCount++;
  }

  const useDurable = durableOutputCount !== undefined;
  const outputCount = useDurable ? durableOutputCount : windowOutputCount;
  const feedbackCount = externalFeedbackCount;

  const ratio = outputCount / Math.max(feedbackCount, 1);
  const gateTriggered = outputCount >= threshold && feedbackCount === 0;

  return {
    outputCount,
    feedbackCount,
    externalFeedbackCount,
    ratio,
    gateTriggered,
    outputSource: useDurable ? 'durable' : 'recent-actions',
  };
}

// ── Human feedback signals ──

/**
 * Hook event fired by `ConversationPipeline.handleChannelMessage()` once per
 * genuine human message on any channel (REST, web/WebSocket, WhatsApp,
 * Discord…). `AgentScheduler` listens for it and records the engagement-gate
 * feedback event, which is how non-Telegram humans earn `humanReply` karma.
 *
 * The Telegram message-buffer path deliberately does NOT emit this — it
 * already records the same signal through `requestImmediateRun()`, and
 * emitting here too would double-count it.
 *
 * Carried on the shared `HookEmitter` (it extends EventEmitter, so the
 * framework's own signals do not need a slot in the public `HookEvents` map).
 */
export const HUMAN_INBOUND_HOOK = 'human_inbound';

export interface HumanInboundEvent {
  botId: string;
  channelKind: string;
  chatId: string;
  userId?: string;
  timestamp: number;
}

export type FeedbackSource = 'ask_human' | 'agent_feedback' | 'human_message';

/** A human signal recorded on the bot's schedule (the stores it comes from are consumed destructively). */
export interface FeedbackEvent {
  timestamp: number;
  source: FeedbackSource;
}

export interface FeedbackSignals {
  total: number;
  /** Production changelog entries approved or rejected by the operator */
  productionEvaluations: number;
  /** ask_human questions that received an answer */
  askHumanAnswers: number;
  /** Dashboard agent-feedback entries processed */
  agentFeedback: number;
  /** Human inbound messages (channels + dashboard conversations) */
  humanMessages: number;
  /**
   * Timestamp (ms) of the most recent human signal in the window, or null when
   * none was found. The engagement gate anchors its output count here:
   * everything produced after the last human signal is unconsumed.
   */
  lastFeedbackAt: number | null;
}

export interface FeedbackSignalDeps {
  productionsService?: {
    getChangelog: (
      botId: string,
      opts?: { limit?: number; since?: string }
    ) => Array<{ evaluation?: { status?: string; evaluatedAt?: string } }>;
  };
  conversationsService?: {
    listConversations: (
      botId: string,
      opts?: { limit?: number }
    ) => Array<{
      id: string;
      updatedAt: string;
    }>;
    getMessages: (
      botId: string,
      conversationId: string,
      opts?: { limit?: number }
    ) => Array<{ role: string; createdAt: string }>;
  };
  feedbackEvents?: FeedbackEvent[];
}

const toMs = (iso: string | undefined): number => (iso ? new Date(iso).getTime() : Number.NaN);

/**
 * Count human feedback received since `sinceTs` from every source the
 * framework has: production evaluations (changelog), schedule-recorded events
 * (ask_human answers, agent feedback, channel messages) and human-role
 * messages in dashboard conversations. Every source is best-effort — a failing
 * service contributes zero rather than breaking the cycle.
 */
export function countFeedbackSignals(
  deps: FeedbackSignalDeps,
  botId: string,
  sinceTs: number
): FeedbackSignals {
  const signals: FeedbackSignals = {
    total: 0,
    productionEvaluations: 0,
    askHumanAnswers: 0,
    agentFeedback: 0,
    humanMessages: 0,
    lastFeedbackAt: null,
  };

  const seen = (ts: number): void => {
    if (!Number.isFinite(ts)) return;
    if (signals.lastFeedbackAt === null || ts > signals.lastFeedbackAt) signals.lastFeedbackAt = ts;
  };

  try {
    const entries = deps.productionsService?.getChangelog(botId, { limit: 500 }) ?? [];
    for (const entry of entries) {
      const ev = entry.evaluation;
      if (!ev || (ev.status !== 'approved' && ev.status !== 'rejected')) continue;
      const ts = toMs(ev.evaluatedAt);
      if (ts >= sinceTs) {
        signals.productionEvaluations++;
        seen(ts);
      }
    }
  } catch {
    /* best-effort */
  }

  for (const event of deps.feedbackEvents ?? []) {
    if (event.timestamp < sinceTs) continue;
    if (event.source === 'ask_human') signals.askHumanAnswers++;
    else if (event.source === 'agent_feedback') signals.agentFeedback++;
    else signals.humanMessages++;
    seen(event.timestamp);
  }

  try {
    const convos = deps.conversationsService?.listConversations(botId, { limit: 100 }) ?? [];
    for (const convo of convos) {
      if (toMs(convo.updatedAt) < sinceTs) continue;
      const messages =
        deps.conversationsService?.getMessages(botId, convo.id, { limit: 200 }) ?? [];
      for (const msg of messages) {
        const ts = toMs(msg.createdAt);
        if (msg.role === 'human' && ts >= sinceTs) {
          signals.humanMessages++;
          seen(ts);
        }
      }
    }
  } catch {
    /* best-effort */
  }

  signals.total =
    signals.productionEvaluations +
    signals.askHumanAnswers +
    signals.agentFeedback +
    signals.humanMessages;
  return signals;
}

// ── Engagement gate enforcement ──

export interface EngagementGateDecision {
  blocked: boolean;
  actionType: ActionType;
  /** Canonical cycle summary when blocked */
  summary?: string;
}

/**
 * Hard-mode enforcement: when the gate is triggered and the planner still
 * returns a CONTENT plan, the cycle is downgraded to idle. OUTREACH,
 * ASSESSMENT, RESEARCH and MAINTENANCE plans pass — they are how the bot earns
 * feedback. Soft mode only annotates the prompt and never blocks.
 */
export function evaluateEngagementGate(params: {
  plan: string[];
  engagement: Pick<UnconsumedOutputResult, 'gateTriggered' | 'outputCount' | 'feedbackCount'>;
  mode: 'soft' | 'hard';
  enabled: boolean;
}): EngagementGateDecision {
  const actionType = classifyAction(params.plan.join('; ').slice(0, 200));
  if (!params.enabled || params.mode !== 'hard' || !params.engagement.gateTriggered) {
    return { blocked: false, actionType };
  }
  if (actionType !== 'CONTENT') return { blocked: false, actionType };
  return {
    blocked: true,
    actionType,
    summary: `Engagement gate: content blocked until feedback (${params.engagement.outputCount} outputs, ${params.engagement.feedbackCount} feedback)`,
  };
}

/**
 * Build a digest of recent actions for the planner to detect repetition.
 */
export function buildRecentActionsDigest(
  recentActions: RecentAction[],
  opts?: { externalFeedbackCount?: number; durableOutputCount?: number }
): string | null {
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

  const engagement = detectUnconsumedOutput(
    recentActions,
    5,
    opts?.externalFeedbackCount ?? 0,
    opts?.durableOutputCount
  );
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

/**
 * How long an identical agent-loop error is suppressed from a bot's daily
 * memory. The circuit breaker already collapses CONTEXTUAL (quota) outages;
 * this covers the rest — notably a PERMANENT auth failure, which deliberately
 * does not open the circuit but does recur on every cycle until an operator
 * fixes the credential.
 */
export const ERROR_MEMO_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Whether this error should be appended to the bot's daily memory. */
export function shouldRecordErrorInMemory(
  last: { message: string; at: number } | undefined,
  message: string,
  now: number,
  windowMs: number = ERROR_MEMO_WINDOW_MS
): boolean {
  if (!last || last.message !== message) return true;
  return now - last.at >= windowMs;
}
