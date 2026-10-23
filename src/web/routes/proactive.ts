/**
 * "Sent to you" (docs/plans/why-everywhere-plan.md, phase 1 row 10): the
 * messages agents chose to send on their own (`send_proactive_message`),
 * read from the tool audit. Read-only.
 *
 *   GET /api/proactive?limit=50&before=<iso>&days=30
 *       fleet list, newest first → { messages, hasMore, nextBefore, days }.
 *       Each message: botId, botName, avatarUrl, sentAt, recipient,
 *       toOperator, message, status (delivered | refused | failed),
 *       delivered, reason (refusal or error text, when not delivered),
 *       cycleId?, goalId?, why. `before` keeps only strictly older sends and
 *       anchors the `days` window (default 30, max 90); pass the last page's
 *       `nextBefore` to read on.
 *
 * Tenant-scoped like /api/curiosity/dispatches: only the caller's bots are read.
 */
import { Hono } from 'hono';
import type { ToolAuditEntry } from '../../bot/tool-audit-log';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import { getTenantId, isAdminOrSingleTenant, scopeBots } from '../../tenant/tenant-scoping';
import { resolveOperatorTarget } from '../../tools/send-proactive-message';
import {
  type ProactiveSend,
  proactiveFromAudit,
  proactiveToWhy,
} from '../../why/builders/proactive';
import { CycleIndex, type CycleReader } from '../../why/cycle-index';

export interface ProactiveRouteDeps {
  config: Config;
  logger: Logger;
  /** Tool-audit entries of a bot with a timestamp in [sinceMs, untilMs]. */
  readToolAudit: (botId: string, sinceMs: number, untilMs: number) => ToolAuditEntry[];
  /** Agent-loop cycle rows of a bot started in [sinceMs, untilMs]. */
  readCycles?: CycleReader;
  avatarUrlFor?: (botId: string) => string | null;
  now?: () => number;
}

/** The tool-audit bot id of the watcher's question broadcasts (`deliverWatcherQuestion`). */
export const WATCHER_AUDIT_ID = '__watcher__';

export const DEFAULT_PROACTIVE_LIMIT = 50;
export const MAX_PROACTIVE_LIMIT = 200;
export const DEFAULT_PROACTIVE_DAYS = 30;
export const MAX_PROACTIVE_DAYS = 90;
const DAY_MS = 86_400_000;

function parsePositive(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export function proactiveRoutes(deps: ProactiveRouteDeps) {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  const avatarFor = (botId: string): string | null => {
    try {
      return deps.avatarUrlFor?.(botId) ?? null;
    } catch {
      return null;
    }
  };

  app.get('/', (c) => {
    const limit = parsePositive(c.req.query('limit'), DEFAULT_PROACTIVE_LIMIT, MAX_PROACTIVE_LIMIT);
    const days = parsePositive(c.req.query('days'), DEFAULT_PROACTIVE_DAYS, MAX_PROACTIVE_DAYS);
    const beforeRaw = c.req.query('before');
    const beforeMs = beforeRaw === undefined ? null : Date.parse(beforeRaw);
    if (beforeMs !== null && Number.isNaN(beforeMs)) {
      return c.json({ error: '`before` must be an ISO timestamp' }, 400);
    }
    const untilMs = beforeMs ?? now();
    const sinceMs = untilMs - days * DAY_MS;
    const isOperator = (raw: string) =>
      resolveOperatorTarget(raw, deps.config.operator).kind === 'operator';

    const tenantId = getTenantId(c);
    const bots: Array<{ id: string; name?: string }> = scopeBots(deps.config.bots, tenantId);
    // The fleet watcher's questions to the operator (`__watcher__` in the tool audit): admin only.
    if (isAdminOrSingleTenant(tenantId)) bots.push({ id: WATCHER_AUDIT_ID, name: 'Fleet watcher' });
    const all: Array<ProactiveSend & { botName: string }> = [];
    for (const bot of bots) {
      let entries: ToolAuditEntry[];
      try {
        entries = deps.readToolAudit(bot.id, sinceMs, untilMs);
      } catch (err) {
        deps.logger.warn({ err, botId: bot.id }, 'Proactive: tool audit read failed');
        continue;
      }
      for (const e of entries) {
        const s = proactiveFromAudit(e, isOperator);
        if (!s) continue;
        const t = Date.parse(s.sentAt);
        if (!Number.isFinite(t) || t < sinceMs) continue;
        if (beforeMs !== null ? !(t < beforeMs) : t > untilMs) continue;
        all.push({ ...s, botId: s.botId || bot.id, botName: bot.name ?? bot.id });
      }
    }
    all.sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
    const page = all.slice(0, limit);

    const cycles = CycleIndex.for(
      deps.readCycles,
      page.filter((s) => s.cycleId).map((s) => ({ botId: s.botId, at: s.sentAt })),
      (botId, err) => deps.logger.warn({ err, botId }, 'Proactive: cycle log read failed')
    );
    const faces = new Map<string, string | null>();
    const messages = page.map((s) => {
      const row = s.cycleId ? cycles.byId(s.botId, s.cycleId) : undefined;
      const send: ProactiveSend = row ? { ...s, cycle: row } : s;
      if (!faces.has(s.botId)) faces.set(s.botId, avatarFor(s.botId));
      const { result, ...rest } = s;
      return {
        ...rest,
        avatarUrl: faces.get(s.botId) ?? null,
        delivered: s.status === 'delivered',
        ...(s.status !== 'delivered' ? { reason: result } : {}),
        why: proactiveToWhy(send),
      };
    });
    return c.json({
      messages,
      hasMore: all.length > limit,
      nextBefore: messages.at(-1)?.sentAt ?? null,
      days,
    });
  });

  return app;
}
