import { describe, expect, test } from 'bun:test';
import type { ActivityEvent } from '../../src/bot/activity-stream';
import type { BotConfig } from '../../src/config';
import {
  ActivitySocketHub,
  WatcherSocketHub,
  type WsAuth,
  canSeeActivityEvent,
  planDashboardSocketUpgrade,
  resolveWsAuth,
} from '../../src/web/ws-tenant-filter';

const bots = [
  { id: 'a1', tenantId: 't-a' },
  { id: 'a2', tenantId: 't-a' },
  { id: 'b1', tenantId: 't-b' },
  { id: 'legacy' },
] as unknown as BotConfig[];

const ADMIN: WsAuth = { tenantId: null, isAdmin: true };
const TENANT_A: WsAuth = { tenantId: 't-a', isAdmin: false };

function ev(botId: string, type: ActivityEvent['type'] = 'tool:end'): ActivityEvent {
  return { type, botId, timestamp: 1 };
}

const authDeps = {
  multiTenant: true,
  adminKey: 'admin-key',
  getSession: (t: string) =>
    t === 'sess_admin'
      ? { role: 'admin' as const }
      : t === 'sess_a'
        ? { role: 'tenant' as const, tenantId: 't-a' }
        : t === 'sess_gone'
          ? { role: 'tenant' as const, tenantId: 't-gone' }
          : t === 'sess_none'
            ? { role: 'tenant' as const }
            : undefined,
  getTenant: (id: string) => (id === 't-a' || id === 't-b' ? { id } : undefined),
  getTenantByApiKey: (k: string) => (k === 'key-b' ? { id: 't-b' } : undefined),
};

describe('resolveWsAuth', () => {
  test('single-tenant mode sees everything, no token needed', () => {
    expect(resolveWsAuth(null, { ...authDeps, multiTenant: false })).toEqual(ADMIN);
  });

  test('multi-tenant without a token is rejected', () => {
    expect(resolveWsAuth(null, authDeps)).toBeNull();
    expect(resolveWsAuth('', authDeps)).toBeNull();
  });

  test('admin session and admin key are admin', () => {
    expect(resolveWsAuth('sess_admin', authDeps)).toEqual(ADMIN);
    expect(resolveWsAuth('admin-key', authDeps)).toEqual(ADMIN);
  });

  test('tenant session binds its tenant', () => {
    expect(resolveWsAuth('sess_a', authDeps)).toEqual(TENANT_A);
  });

  test('tenant session whose tenant is gone, or without tenant, is rejected', () => {
    expect(resolveWsAuth('sess_gone', authDeps)).toBeNull();
    expect(resolveWsAuth('sess_none', authDeps)).toBeNull();
    expect(resolveWsAuth('sess_unknown', authDeps)).toBeNull();
  });

  test('tenant API key binds its tenant', () => {
    expect(resolveWsAuth('key-b', authDeps)).toEqual({ tenantId: 't-b', isAdmin: false });
  });

  test('unknown key is rejected; an unset admin key never matches', () => {
    expect(resolveWsAuth('nope', authDeps)).toBeNull();
    expect(resolveWsAuth('nope', { ...authDeps, adminKey: undefined })).toBeNull();
  });
});

describe('canSeeActivityEvent', () => {
  test('admin sees every event, including ones without a bot', () => {
    expect(canSeeActivityEvent(ADMIN, ev('b1'), bots)).toBe(true);
    expect(canSeeActivityEvent(ADMIN, ev(''), bots)).toBe(true);
    expect(canSeeActivityEvent(ADMIN, ev('ghost'), bots)).toBe(true);
  });

  test('a tenant sees only its own bots', () => {
    expect(canSeeActivityEvent(TENANT_A, ev('a1'), bots)).toBe(true);
    expect(canSeeActivityEvent(TENANT_A, ev('b1'), bots)).toBe(false);
    expect(canSeeActivityEvent(TENANT_A, ev('legacy'), bots)).toBe(false);
  });

  test('a tenant never sees bot-less or unknown-bot events', () => {
    expect(canSeeActivityEvent(TENANT_A, ev(''), bots)).toBe(false);
    expect(canSeeActivityEvent(TENANT_A, { type: 'memory:rag', timestamp: 1 } as never, bots)).toBe(
      false
    );
    expect(canSeeActivityEvent(TENANT_A, ev('ghost'), bots)).toBe(false);
  });

  test('a botId filter narrows to that bot, for admin too', () => {
    expect(canSeeActivityEvent(ADMIN, ev('a1'), bots, 'a1')).toBe(true);
    expect(canSeeActivityEvent(ADMIN, ev('b1'), bots, 'a1')).toBe(false);
    expect(canSeeActivityEvent(ADMIN, ev(''), bots, 'a1')).toBe(false);
    expect(canSeeActivityEvent(TENANT_A, ev('a2'), bots, 'a1')).toBe(false);
  });

  test('null / malformed events are never sent to a tenant', () => {
    expect(canSeeActivityEvent(TENANT_A, null as never, bots)).toBe(false);
  });
});

describe('planDashboardSocketUpgrade', () => {
  const deps = { ...authDeps, getBots: () => bots };
  const url = (s: string) => new URL(`http://x${s}`);

  test('activity: unauthenticated multi-tenant is 401', () => {
    expect(planDashboardSocketUpgrade(url('/ws/activity'), deps)).toEqual({
      kind: 'reject',
      status: 401,
      body: 'Unauthorized',
    });
  });

  test('activity: tenant gets its auth bound to the socket data', () => {
    expect(planDashboardSocketUpgrade(url('/ws/activity?token=sess_a'), deps)).toEqual({
      kind: 'upgrade',
      data: { type: 'activity', auth: TENANT_A, botFilter: undefined },
    });
  });

  test('activity: ?botId= is accepted for an accessible bot', () => {
    expect(planDashboardSocketUpgrade(url('/ws/activity?token=sess_a&botId=a1'), deps)).toEqual({
      kind: 'upgrade',
      data: { type: 'activity', auth: TENANT_A, botFilter: 'a1' },
    });
  });

  test('activity: ?botId= of another tenant or unknown bot is 404', () => {
    for (const id of ['b1', 'ghost']) {
      const plan = planDashboardSocketUpgrade(url(`/ws/activity?token=sess_a&botId=${id}`), deps);
      expect(plan).toMatchObject({ kind: 'reject', status: 404 });
    }
  });

  test('activity: admin may filter on any configured bot', () => {
    expect(
      planDashboardSocketUpgrade(url('/ws/activity?token=admin-key&botId=b1'), deps)
    ).toMatchObject({ kind: 'upgrade', data: { botFilter: 'b1' } });
  });

  test('logs: tenant is 403 in multi-tenant mode, admin is allowed', () => {
    expect(planDashboardSocketUpgrade(url('/ws/logs?token=sess_a'), deps)).toMatchObject({
      kind: 'reject',
      status: 403,
    });
    expect(planDashboardSocketUpgrade(url('/ws/logs?token=sess_admin'), deps)).toEqual({
      kind: 'upgrade',
      data: { type: 'logs', auth: ADMIN },
    });
  });

  test('single-tenant: logs and activity open without a token', () => {
    const single = { ...deps, multiTenant: false };
    expect(planDashboardSocketUpgrade(url('/ws/logs'), single)).toMatchObject({ kind: 'upgrade' });
    expect(planDashboardSocketUpgrade(url('/ws/activity?botId=a1'), single)).toMatchObject({
      kind: 'upgrade',
      data: { botFilter: 'a1' },
    });
  });
});

describe('ActivitySocketHub', () => {
  type Fake = { data: { type: 'activity'; auth: WsAuth; botFilter?: string }; sent: string[] };
  function sock(auth: WsAuth, botFilter?: string, fail = false): Fake & { send(d: string): void } {
    const s = {
      data: { type: 'activity' as const, auth, botFilter },
      sent: [] as string[],
      send(d: string) {
        if (fail) throw new Error('closed');
        s.sent.push(d);
      },
    };
    return s;
  }
  let currentBots = bots;
  const hub = () => new ActivitySocketHub(() => currentBots);

  test('broadcast reaches only clients that may see the event', () => {
    const h = hub();
    const admin = sock(ADMIN);
    const a = sock(TENANT_A);
    const b = sock({ tenantId: 't-b', isAdmin: false });
    h.add(admin);
    h.add(a);
    h.add(b);
    h.broadcast(ev('a1'));
    h.broadcast(ev(''));
    expect(admin.sent.length).toBe(2);
    expect(a.sent.map((s) => JSON.parse(s))).toEqual([{ type: 'activity', event: ev('a1') }]);
    expect(b.sent).toEqual([]);
  });

  test('bots added after connect are resolved at send time', () => {
    const h = hub();
    const a = sock(TENANT_A);
    h.add(a);
    h.broadcast(ev('new-bot'));
    expect(a.sent).toEqual([]);
    currentBots = [...bots, { id: 'new-bot', tenantId: 't-a' } as unknown as BotConfig];
    h.broadcast(ev('new-bot'));
    expect(a.sent.length).toBe(1);
    currentBots = bots;
  });

  test('history replay is filtered the same way', () => {
    const h = hub();
    const a = sock(TENANT_A, 'a1');
    h.sendHistory(a, [ev('a1'), ev('a2'), ev('b1'), ev('')]);
    expect(JSON.parse(a.sent[0])).toEqual({ type: 'history', events: [ev('a1')] });
  });

  test('a failing client is dropped, the others still get the event', () => {
    const h = hub();
    const bad = sock(ADMIN, undefined, true);
    const good = sock(ADMIN);
    h.add(bad);
    h.add(good);
    h.broadcast(ev('a1'));
    expect(h.size).toBe(1);
    expect(good.sent.length).toBe(1);
  });

  test('remove stops delivery', () => {
    const h = hub();
    const a = sock(ADMIN);
    h.add(a);
    h.remove(a);
    h.broadcast(ev('a1'));
    expect(a.sent).toEqual([]);
    expect(h.size).toBe(0);
  });
});

describe('/ws/watcher upgrade', () => {
  const url = (s: string) => new URL(`http://x${s}`);
  const deps = { ...authDeps, getBots: () => bots };

  test('admin in multi-tenant mode is allowed', () => {
    expect(planDashboardSocketUpgrade(url('/ws/watcher?token=sess_admin'), deps)).toEqual({
      kind: 'upgrade',
      data: { type: 'watcher', auth: ADMIN },
    });
  });

  test('a tenant is 403 in multi-tenant mode', () => {
    expect(planDashboardSocketUpgrade(url('/ws/watcher?token=sess_a'), deps)).toEqual({
      kind: 'reject',
      status: 403,
      body: 'Admin access required',
    });
  });

  test('no token in multi-tenant mode is 401', () => {
    expect(planDashboardSocketUpgrade(url('/ws/watcher'), deps)).toMatchObject({
      kind: 'reject',
      status: 401,
    });
  });

  test('single-tenant opens without a token', () => {
    expect(planDashboardSocketUpgrade(url('/ws/watcher'), { ...deps, multiTenant: false })).toEqual(
      {
        kind: 'upgrade',
        data: { type: 'watcher', auth: ADMIN },
      }
    );
  });
});

describe('WatcherSocketHub', () => {
  type Sock = { data: { type: 'watcher'; auth: WsAuth }; sent: string[]; send(d: string): void };
  function sock(fail = false): Sock {
    const s: Sock = {
      data: { type: 'watcher', auth: ADMIN },
      sent: [],
      send(d: string) {
        if (fail) throw new Error('closed');
        s.sent.push(d);
      },
    };
    return s;
  }

  test('broadcast wraps the event as { type: watcher, event }', () => {
    const h = new WatcherSocketHub<Sock>();
    const a = sock();
    h.add(a);
    const event = { type: 'watcher:log' as const, ts: 'x', data: { seq: 1 } };
    h.broadcast(event);
    expect(JSON.parse(a.sent[0])).toEqual({ type: 'watcher', event });
  });

  test('a failing socket is dropped', () => {
    const errors: unknown[] = [];
    const h = new WatcherSocketHub<Sock>((e) => errors.push(e));
    h.add(sock(true));
    h.broadcast({ type: 'watcher:state', ts: 'x', data: {} });
    expect(h.size).toBe(0);
    expect(errors).toHaveLength(1);
  });

  test('remove stops delivery', () => {
    const h = new WatcherSocketHub<Sock>();
    const a = sock();
    h.add(a);
    h.remove(a);
    h.broadcast({ type: 'watcher:state', ts: 'x', data: {} });
    expect(a.sent).toEqual([]);
  });

  test('sendHistory sends the state and the log tail', () => {
    const h = new WatcherSocketHub<Sock>();
    const a = sock();
    const state = { running: true, phase: 'sense' };
    h.sendHistory(a, state as never, [{ seq: 2 } as never]);
    expect(JSON.parse(a.sent[0])).toEqual({ type: 'history', state, log: [{ seq: 2 }] });
  });
});
