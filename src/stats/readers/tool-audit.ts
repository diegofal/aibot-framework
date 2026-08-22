import type { ToolAuditEntry } from '../../bot/tool-audit-log';
import type { ToolStats } from '../types';
import { ratio } from '../util';
import { groupByDay, readDailyEntries } from './daily-files';

export type { ToolAuditEntry };

const TOP_TOOLS = 10;

/** Tools whose calls count as bot-to-bot collaboration. */
const COLLAB_TOOLS = new Set(['collaborate', 'delegate']);

export function readToolEntries(
  baseDir: string,
  botId: string,
  sinceMs: number,
  nowMs: number
): ToolAuditEntry[] {
  return readDailyEntries<ToolAuditEntry>(baseDir, botId, sinceMs, nowMs);
}

export function aggregateTools(entries: ToolAuditEntry[], loopBreaks: number): ToolStats {
  const perTool = new Map<string, { count: number; failed: number }>();
  let failed = 0;
  for (const e of entries) {
    const ok = e.success !== false;
    if (!ok) failed++;
    const name = e.toolName || 'unknown';
    const t = perTool.get(name) ?? { count: 0, failed: 0 };
    t.count++;
    if (!ok) t.failed++;
    perTool.set(name, t);
  }
  const top = [...perTool.entries()]
    .map(([name, t]) => ({ name, count: t.count, failed: t.failed }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, TOP_TOOLS);
  return {
    calls: entries.length,
    failed,
    failRate: ratio(failed, entries.length),
    top,
    loopBreaks,
  };
}

export function toolsDaily(
  entries: ToolAuditEntry[]
): Array<{ date: string; calls: number; failed: number }> {
  return groupByDay(
    entries,
    () => ({ calls: 0, failed: 0 }),
    (acc, e) => {
      acc.calls++;
      if (e.success === false) acc.failed++;
    }
  );
}

export interface ToolEngagement {
  asksSent: number;
  messagesSentProactive: number;
  collaborateCalls: number;
  collaborateFailed: number;
  meshPublishCalls: number;
  edges: Array<{ from: string; to: string; calls: number; failed: number }>;
}

/**
 * Engagement counters derived from the tool audit: how often the bot reached
 * out (ask_human, send_message), collaborated (collaborate/delegate, with the
 * target bot taken from `args.targetBotId`) and published to the mesh.
 */
export function engagementFromTools(entries: ToolAuditEntry[], botId: string): ToolEngagement {
  const out: ToolEngagement = {
    asksSent: 0,
    messagesSentProactive: 0,
    collaborateCalls: 0,
    collaborateFailed: 0,
    meshPublishCalls: 0,
    edges: [],
  };
  const edges = new Map<string, { calls: number; failed: number }>();
  for (const e of entries) {
    const ok = e.success !== false;
    switch (e.toolName) {
      case 'ask_human':
        out.asksSent++;
        break;
      case 'send_message':
        if (ok) out.messagesSentProactive++;
        break;
      case 'mesh_publish':
        if (ok) out.meshPublishCalls++;
        break;
      default:
        if (COLLAB_TOOLS.has(e.toolName)) {
          out.collaborateCalls++;
          if (!ok) out.collaborateFailed++;
          const target = targetOf(e.args);
          if (target) {
            const edge = edges.get(target) ?? { calls: 0, failed: 0 };
            edge.calls++;
            if (!ok) edge.failed++;
            edges.set(target, edge);
          }
        }
    }
  }
  out.edges = [...edges.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([to, e]) => ({ from: botId, to, calls: e.calls, failed: e.failed }));
  return out;
}

function targetOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const v = a.targetBotId ?? a.target_bot_id ?? a.botId ?? a.target;
  return typeof v === 'string' && v ? v : null;
}
