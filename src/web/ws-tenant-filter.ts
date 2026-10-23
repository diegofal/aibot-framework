/**
 * Tenant scoping for the dashboard sockets (`/ws/activity`, `/ws/logs`).
 *
 * Before this module both sockets were firehoses: multi-tenant mode checked the
 * token at upgrade but bound no tenant to the socket, so every ActivityStream
 * event (and the 50-event replay on connect) reached every client.
 *
 * Rules:
 * - Single-tenant mode, admin session, admin key → `{ tenantId: null, isAdmin: true }`: sees all.
 * - Tenant session / tenant API key → `{ tenantId, isAdmin: false }`.
 * - Anything else in multi-tenant mode is rejected at upgrade (401), as before.
 * - An activity event reaches a tenant only when its `botId` names a bot in the
 *   live `config.bots` whose `tenantId` is the client's (same rule as
 *   `isBotAccessible` and REST `/api/activity`). Resolved at send time, so bots
 *   created after the client connected work.
 * - Events with no `botId` (e.g. `memory:rag` from the conversation pipeline,
 *   which carries query previews) or with a `botId` not in the config cannot be
 *   attributed to a tenant: admin only. No event type is exempt — a fleet-wide
 *   event is never "clearly harmless" enough to guess about.
 * - `?botId=` narrows a socket to one bot (accessible bots only; else 404).
 * - `/ws/logs` is admin-only in multi-tenant mode (403): log lines are not
 *   reliably attributable to a bot. Single-tenant mode is unchanged.
 */
import type { ActivityEvent } from '../bot/activity-stream';
import type { BotConfig } from '../config';
import { safeCompare } from '../crypto-utils';
import { isBotAccessible } from '../tenant/tenant-scoping';
import type { WatcherEvent, WatcherLogRow, WatcherState } from '../watcher/types';

export interface WsAuth {
  /** The client's tenant; `null` = admin or single-tenant mode. */
  tenantId: string | null;
  isAdmin: boolean;
}

export interface WsAuthDeps {
  multiTenant: boolean;
  adminKey: string | undefined;
  getSession: (token: string) => { role: 'admin' | 'tenant'; tenantId?: string } | undefined;
  getTenant: (id: string) => { id: string } | undefined;
  getTenantByApiKey: (key: string) => { id: string } | undefined;
}

const ALL: WsAuth = { tenantId: null, isAdmin: true };

/** Who is on the other end of a dashboard socket; `null` = reject. Mirrors the tenant auth middleware. */
export function resolveWsAuth(token: string | null, deps: WsAuthDeps): WsAuth | null {
  if (!deps.multiTenant) return { ...ALL };
  if (!token) return null;
  if (token.startsWith('sess_')) {
    const session = deps.getSession(token);
    if (!session) return null;
    if (session.role === 'admin') return { ...ALL };
    if (!session.tenantId || !deps.getTenant(session.tenantId)) return null;
    return { tenantId: session.tenantId, isAdmin: false };
  }
  const tenant = deps.getTenantByApiKey(token);
  if (tenant) return { tenantId: tenant.id, isAdmin: false };
  if (deps.adminKey && safeCompare(token, deps.adminKey)) return { ...ALL };
  return null;
}

/** Whether this client may access a bot of the live config. Admin: any configured bot. */
function canAccessBot(auth: WsAuth, botId: string, bots: readonly BotConfig[]): boolean {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) return false;
  return auth.isAdmin || isBotAccessible(bot, auth.tenantId ?? undefined);
}

/** The filtering rule for one activity event and one client (see module doc). */
export function canSeeActivityEvent(
  auth: WsAuth,
  event: ActivityEvent | null | undefined,
  bots: readonly BotConfig[],
  botFilter?: string
): boolean {
  if (!event || typeof event !== 'object') return false;
  const botId = typeof event.botId === 'string' ? event.botId : '';
  if (botFilter !== undefined && botId !== botFilter) return false;
  if (auth.isAdmin) return true;
  if (!botId) return false;
  return canAccessBot(auth, botId, bots);
}

export type DashboardSocketData =
  | { type: 'activity'; auth: WsAuth; botFilter: string | undefined }
  | { type: 'logs'; auth: WsAuth }
  | { type: 'watcher'; auth: WsAuth };

export type UpgradePlan =
  | { kind: 'upgrade'; data: DashboardSocketData }
  | { kind: 'reject'; status: number; body: string };

/** Decide a `/ws/activity` or `/ws/logs` upgrade: reject, or the data to bind to `ws.data`. */
export function planDashboardSocketUpgrade(
  url: URL,
  deps: WsAuthDeps & { getBots: () => readonly BotConfig[] }
): UpgradePlan {
  const auth = resolveWsAuth(url.searchParams.get('token'), deps);
  if (!auth) return { kind: 'reject', status: 401, body: 'Unauthorized' };

  if (url.pathname === '/ws/logs') {
    if (deps.multiTenant && !auth.isAdmin) {
      return { kind: 'reject', status: 403, body: 'Admin access required' };
    }
    return { kind: 'upgrade', data: { type: 'logs', auth } };
  }

  // The watcher sees the whole fleet: admin (or single-tenant) only.
  if (url.pathname === '/ws/watcher') {
    if (deps.multiTenant && !auth.isAdmin) {
      return { kind: 'reject', status: 403, body: 'Admin access required' };
    }
    return { kind: 'upgrade', data: { type: 'watcher', auth } };
  }

  const botFilter = url.searchParams.get('botId') || undefined;
  if (botFilter !== undefined && !canAccessBot(auth, botFilter, deps.getBots())) {
    return { kind: 'reject', status: 404, body: 'Bot not found' };
  }
  return { kind: 'upgrade', data: { type: 'activity', auth, botFilter } };
}

export interface ActivitySocket {
  data: { auth: WsAuth; botFilter?: string };
  send(data: string): unknown;
}

/** The `/ws/activity` clients: every send goes through `canSeeActivityEvent`. */
export class ActivitySocketHub<W extends ActivitySocket = ActivitySocket> {
  private readonly clients = new Set<W>();

  constructor(
    private readonly getBots: () => readonly BotConfig[],
    private readonly onSendError?: (err: unknown) => void
  ) {}

  get size(): number {
    return this.clients.size;
  }

  add(ws: W): void {
    this.clients.add(ws);
  }

  remove(ws: W): void {
    this.clients.delete(ws);
  }

  broadcast(event: ActivityEvent): void {
    const bots = this.getBots();
    let payload: string | null = null;
    for (const ws of this.clients) {
      if (!canSeeActivityEvent(ws.data.auth, event, bots, ws.data.botFilter)) continue;
      payload ??= JSON.stringify({ type: 'activity', event });
      try {
        ws.send(payload);
      } catch (err) {
        this.onSendError?.(err);
        this.clients.delete(ws);
      }
    }
  }

  /** The replay on connect, filtered with the same rule as live events. */
  sendHistory(ws: W, events: readonly ActivityEvent[]): void {
    const bots = this.getBots();
    const visible = events.filter((e) =>
      canSeeActivityEvent(ws.data.auth, e, bots, ws.data.botFilter)
    );
    ws.send(JSON.stringify({ type: 'history', events: visible }));
  }
}

export interface WatcherSocket {
  send(data: string): unknown;
}

/**
 * The `/ws/watcher` clients (admin only, checked at upgrade): every watcher
 * event goes out as `{ type: 'watcher', event }`; on connect the client gets
 * `{ type: 'history', state, log }`.
 */
export class WatcherSocketHub<W extends WatcherSocket = WatcherSocket> {
  private readonly clients = new Set<W>();

  constructor(private readonly onSendError?: (err: unknown) => void) {}

  get size(): number {
    return this.clients.size;
  }

  add(ws: W): void {
    this.clients.add(ws);
  }

  remove(ws: W): void {
    this.clients.delete(ws);
  }

  broadcast(event: WatcherEvent): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify({ type: 'watcher', event });
    for (const ws of this.clients) {
      try {
        ws.send(payload);
      } catch (err) {
        this.onSendError?.(err);
        this.clients.delete(ws);
      }
    }
  }

  sendHistory(ws: W, state: WatcherState, log: readonly WatcherLogRow[]): void {
    ws.send(JSON.stringify({ type: 'history', state, log }));
  }
}
