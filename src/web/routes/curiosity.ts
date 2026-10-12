/**
 * Curiosity DNA API (docs/plans/curiosity-navigator-plan.md, step C7).
 *
 *   GET  /api/curiosity/dispatches?limit=50&offset=0&before=<iso>
 *                                                    fleet inbox, newest first →
 *                                                    { dispatches, hasMore, nextBefore }.
 *                                                    `before` keeps only strictly older
 *                                                    dispatches; pass the last page's
 *                                                    `nextBefore` to read past the limit
 *                                                    cap (dispatches sharing that exact
 *                                                    timestamp are skipped)
 *   GET  /api/curiosity/:botId                       CuriositySnapshot (+ botName; dispatches,
 *                                                    directions and frontier items carry `why`)
 *   POST /api/curiosity/:botId/dispatches/:id/signal { signal: up|down|more }
 *   POST /api/curiosity/:botId/frontier/:id/signal   { signal: up|down }
 *   POST /api/curiosity/:botId/direction/signal      { signal: up|down }
 *
 * Tenant-scoped like /api/agents/:id/home: a bot outside the caller's tenant
 * is indistinguishable from an unknown one (404). The literal `/dispatches`
 * route is registered before `/:botId`, so a bot called "dispatches" can only
 * be reached through its sub-paths.
 */
import { type Context, Hono } from 'hono';
import { type CycleRow, digestSources, inferOrigin } from '../../bot/curiosity/origin';
import type { CuriosityService } from '../../bot/curiosity/service';
import type { Dispatch } from '../../bot/curiosity/types';
import type { Config } from '../../config';
import type { Logger } from '../../logger';
import { getTenantId, isBotAccessible, scopeBots } from '../../tenant/tenant-scoping';
import { directionToWhy } from '../../why/builders/direction';
import { dispatchToWhy } from '../../why/builders/dispatch';
import { frontierItemToWhy } from '../../why/builders/frontier';
import { CycleIndex } from '../../why/cycle-index';

/** The part of CuriosityService the routes use (tests pass a fake). */
export interface CuriosityRouteSource {
  snapshot: CuriosityService['snapshot'];
  signalDispatch: CuriosityService['signalDispatch'];
  signalFrontier: CuriosityService['signalFrontier'];
  signalDirection: CuriosityService['signalDirection'];
  storeFor(botId: string): { listDispatches(limit?: number): Dispatch[] } | null;
}

export interface CuriosityRouteDeps {
  config: Config;
  /** Structural subset of BotManager. */
  botManager: { getCuriosityService(): CuriosityRouteSource };
  logger: Logger;
  /** Face URL for the inbox (null = initials avatar). */
  avatarUrlFor?: (botId: string) => string | null;
  /**
   * Agent-loop cycle rows of a bot started in [sinceMs, untilMs]: dispatches
   * written before they recorded their origin get it inferred from these.
   */
  readCycles?: (botId: string, sinceMs: number, untilMs: number) => CycleRow[];
}

export const DEFAULT_DISPATCH_LIMIT = 50;
export const MAX_DISPATCH_LIMIT = 200;
export const SNAPSHOT_DISPATCH_LIMIT = 20;

const DISPATCH_SIGNALS = ['up', 'down', 'more'] as const;
const BINARY_SIGNALS = ['up', 'down'] as const;

export function parseLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DISPATCH_LIMIT;
  return Math.min(n, MAX_DISPATCH_LIMIT);
}

/** A garbage or negative offset reads as 0, like a garbage limit reads as the default. */
export function parseOffset(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function readSignal<T extends string>(c: Context, allowed: readonly T[]): Promise<T | null> {
  try {
    const body = (await c.req.json()) as { signal?: unknown };
    const s = body?.signal;
    return typeof s === 'string' && (allowed as readonly string[]).includes(s) ? (s as T) : null;
  } catch {
    return null;
  }
}

export function curiosityRoutes(deps: CuriosityRouteDeps) {
  const app = new Hono();
  const svc = () => deps.botManager.getCuriosityService();

  const findBot = (c: Context) => {
    const id = c.req.param('botId');
    const bot = deps.config.bots.find((b) => b.id === id);
    if (!bot || !isBotAccessible(bot, getTenantId(c))) return null;
    return bot;
  };

  const avatarFor = (botId: string): string | null => {
    try {
      return deps.avatarUrlFor?.(botId) ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Each dispatch with its origin (recorded or inferred), for a digest its
   * sources, and the `why` the dashboard renders.
   */
  const explain = <T extends Dispatch>(page: T[], byBot: Map<string, Dispatch[]>) => {
    const cycles = CycleIndex.for(
      deps.readCycles,
      page.filter((d) => !d.origin).map((d) => ({ botId: d.botId, at: d.createdAt })),
      (botId, err) => deps.logger.warn({ err, botId }, 'Curiosity: cycle log read failed')
    );
    return page.map((d) => {
      const origin = inferOrigin(d, cycles.rowsFor(d.botId));
      const sources = digestSources(d, byBot.get(d.botId) ?? []);
      const explained = { ...d, ...(origin ? { origin } : {}), ...(sources ? { sources } : {}) };
      return { ...explained, why: dispatchToWhy(explained) };
    });
  };

  app.get('/dispatches', (c) => {
    const limit = parseLimit(c.req.query('limit'));
    const offset = parseOffset(c.req.query('offset'));
    const beforeRaw = c.req.query('before');
    const beforeMs = beforeRaw === undefined ? null : Date.parse(beforeRaw);
    if (beforeMs !== null && Number.isNaN(beforeMs)) {
      return c.json({ error: '`before` must be an ISO timestamp' }, 400);
    }
    const bots = scopeBots(deps.config.bots, getTenantId(c));
    const all: Array<Dispatch & { botName: string }> = [];
    /** Every dispatch of a bot, cursor or not: a digest's sources may be older. */
    const byBot = new Map<string, Dispatch[]>();
    for (const bot of bots) {
      try {
        // Unbounded: the store reads the whole JSONL either way, and a bounded
        // read would hide anything past the first `limit` behind the cursor.
        const list = svc().storeFor(bot.id)?.listDispatches() ?? [];
        byBot.set(bot.id, list);
        for (const d of list) {
          if (beforeMs !== null && !(Date.parse(d.createdAt) < beforeMs)) continue;
          all.push({ ...d, botId: d.botId || bot.id, botName: bot.name ?? bot.id });
        }
      } catch (err) {
        deps.logger.warn({ err, botId: bot.id }, 'Curiosity dispatches read failed');
      }
    }
    all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const faces = new Map<string, string | null>();
    const page = explain(all.slice(offset, offset + limit), byBot).map((d) => {
      if (!faces.has(d.botId)) faces.set(d.botId, avatarFor(d.botId));
      return { ...d, avatarUrl: faces.get(d.botId) ?? null };
    });
    return c.json({
      dispatches: page,
      hasMore: all.length > offset + limit,
      nextBefore: page.at(-1)?.createdAt ?? null,
    });
  });

  app.get('/:botId', (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    try {
      const snap = svc().snapshot(bot.id, { dispatchLimit: SNAPSHOT_DISPATCH_LIMIT });
      if (!snap) return c.json({ error: 'No curiosity state for this bot' }, 404);
      const own = svc().storeFor(bot.id)?.listDispatches() ?? [];
      const dispatches = explain(
        snap.dispatches.map((d) => ({ ...d, botId: d.botId || bot.id })),
        new Map([[bot.id, own]])
      );
      const history = snap.directions ?? [];
      const current = snap.navigator?.direction ?? null;
      const directions = history.map((d) => {
        // The operator's verdict lives on the current direction only.
        const signal =
          current?.runId && current.runId === d.runId ? current.operatorSignal : undefined;
        const row = signal ? { ...d, operatorSignal: signal } : d;
        return { ...row, why: directionToWhy({ botId: bot.id, direction: row }) };
      });
      const runs = new Map(history.map((d) => [d.runId, d]));
      const frontier = (snap.frontier ?? []).map((f) => {
        const runId = f.item.createdBy?.runId;
        const run = runId ? (runs.get(runId) ?? null) : undefined;
        return {
          ...f,
          why: frontierItemToWhy({ botId: bot.id, item: f.item, verdict: f.verdict, run }),
        };
      });
      return c.json({
        ...snap,
        dispatches,
        directions,
        frontier,
        botName: bot.name ?? bot.id,
        avatarUrl: avatarFor(bot.id),
      });
    } catch (err) {
      deps.logger.warn({ err, botId: bot.id }, 'Curiosity snapshot failed');
      return c.json({ error: 'Curiosity snapshot failed' }, 500);
    }
  });

  app.post('/:botId/dispatches/:id/signal', async (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const signal = await readSignal(c, DISPATCH_SIGNALS);
    if (!signal) return c.json({ error: 'signal must be one of up, down, more' }, 400);
    const dispatch = svc().signalDispatch(bot.id, c.req.param('id'), signal);
    if (!dispatch) return c.json({ error: 'Dispatch not found' }, 404);
    return c.json({ ok: true, dispatch });
  });

  app.post('/:botId/frontier/:id/signal', async (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const signal = await readSignal(c, BINARY_SIGNALS);
    if (!signal) return c.json({ error: 'signal must be up or down' }, 400);
    const item = svc().signalFrontier(bot.id, c.req.param('id'), signal);
    if (!item) return c.json({ error: 'Frontier item not found' }, 404);
    return c.json({ ok: true, item });
  });

  app.post('/:botId/direction/signal', async (c) => {
    const bot = findBot(c);
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    const signal = await readSignal(c, BINARY_SIGNALS);
    if (!signal) return c.json({ error: 'signal must be up or down' }, 400);
    const direction = svc().signalDirection(bot.id, signal);
    if (!direction) return c.json({ error: 'No direction yet' }, 404);
    return c.json({ ok: true, direction });
  });

  return app;
}
