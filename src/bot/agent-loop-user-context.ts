/**
 * Build a summary of active users for agent loop planner injection.
 * Lightweight: scans session metadata, does not read full transcripts.
 */
import type { SessionManager } from '../session';

export interface UserAwarenessConfig {
  enabled: boolean;
  activeWindowHours: number;
  maxUsers: number;
}

export interface ActiveUserSummary {
  userId: string;
  lastActive: number;
  messageCount: number;
}

/**
 * Build a compact text summary of recently active users for a bot.
 * Returns null if no active users or feature is disabled.
 */
export function buildActiveUsersSummary(
  sessionManager: SessionManager,
  botId: string,
  config: UserAwarenessConfig
): string | null {
  if (!config.enabled) return null;

  const windowMs = config.activeWindowHours * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const maxUsers = config.maxUsers || 5;

  // Get all session keys for this bot
  const sessions = sessionManager.listSessions();
  const botPrefix = `bot:${botId}:private:`;

  const activeUsers: ActiveUserSummary[] = [];

  for (const session of sessions) {
    if (!session.key.startsWith(botPrefix)) continue;

    const meta = sessionManager.getSessionMeta(session.key);
    if (!meta) continue;

    const lastActive = new Date(meta.lastActivityAt).getTime();
    if (lastActive < cutoff) continue;

    // Extract userId from session key: bot:botId:private:userId
    const parts = session.key.split(':');
    const userId = parts[parts.length - 1];
    if (!userId || userId === '0' || userId === 'undefined') continue;

    activeUsers.push({
      userId,
      lastActive,
      messageCount: meta.messageCount ?? 0,
    });
  }

  if (activeUsers.length === 0) return null;

  // Sort by lastActive descending, take top N
  activeUsers.sort((a, b) => b.lastActive - a.lastActive);
  const top = activeUsers.slice(0, maxUsers);

  // Build compact summary
  const lines: string[] = [`## Active Users (last ${config.activeWindowHours}h)`];
  lines.push('');
  lines.push('| User | Last Active | Messages |');
  lines.push('|------|------------|----------|');

  for (const u of top) {
    const ago = formatTimeAgo(u.lastActive);
    lines.push(`| ${u.userId} | ${ago} | ${u.messageCount} |`);
  }

  if (activeUsers.length > maxUsers) {
    lines.push(`\n_...and ${activeUsers.length - maxUsers} more_`);
  }

  lines.push(
    '\nYou can send proactive messages to any of these users using the send_proactive_message tool.'
  );

  return lines.join('\n');
}

function formatTimeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}
