import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import {
  type AutonomyApi,
  LIST_HISTORY_LIMIT,
  createAutonomy,
  startAutonomyTimers,
} from '../../../src/watcher/autonomy';
import { type ValueAccess, changesFile } from '../../../src/watcher/autonomy/ledger';
import { appendJsonLine, autonomyDir } from '../../../src/watcher/autonomy/proposals';
import type {
  ChangeRecord,
  ChangeStatus,
  ProposalsResponse,
} from '../../../src/watcher/autonomy/types';
import { watcherRoutes } from '../../../src/web/routes/watcher';
import { proposalInput, rowLog, testConfig } from './fixtures';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

let root: string;
let t: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'autonomy-routes-'));
  t = Date.parse('2026-10-25T10:00:00Z');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(opts: { enabled?: boolean; guard?: () => number | undefined } = {}) {
  const config = testConfig(join(root, 'data'), { enabled: opts.enabled ?? true });
  const values = new Map<string, unknown>([['watcher.notice.salienceBar', 0.4]]);
  const access: ValueAccess = {
    read: (p) => values.get(p),
    write: async (vs) => {
      for (const v of vs) values.set(v.path, v.value);
    },
  };
  const applied: string[] = [];
  const autonomy = createAutonomy({
    watcherDir: join(root, 'watcher'),
    config,
    log: rowLog(),
    now: () => t,
    access,
    guards: opts.guard ?? (() => undefined),
    onApplied: (change, event) => applied.push(`${event}:${change.id}`),
  });
  return { config, autonomy, values, applied };
}

function app(config: Config, autonomy: AutonomyApi | undefined, tenantId?: string) {
  const a = new Hono();
  if (tenantId) {
    a.use('*', async (c, next) => {
      c.set('tenant', { tenantId, apiKey: 'k', plan: 'pro' });
      return next();
    });
  }
  a.route(
    '/api/watcher',
    watcherRoutes({ config, logger: noopLogger, watcher: () => undefined, autonomy })
  );
  return a;
}

const post = (a: Hono, path: string, body?: unknown) =>
  a.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('createAutonomy', () => {
  it('submit is refused while proposals are off', async () => {
    const { autonomy } = setup({ enabled: false });
    const r = await autonomy.submit(proposalInput());
    expect(r.ok).toBe(false);
    expect(autonomy.list()).toEqual({ enabled: false, proposals: [], changes: [], maxPending: 3 });
  });

  it('list never shows queued or rejected-locked proposals for review', async () => {
    const { autonomy } = setup();
    for (let i = 0; i < 4; i++) await autonomy.submit(proposalInput({ title: `P${i}` }));
    await autonomy.submit(
      proposalInput({ changes: [{ path: 'watcher.integrate.maxPerDay', from: 24, to: 40 }] })
    );
    const res = autonomy.list();
    expect(res.enabled).toBe(true);
    expect(res.proposals.map((p) => p.status)).toEqual(['pending', 'pending', 'pending']);
  });

  it('tick rolls back a breached change', async () => {
    const g: { reading?: number } = {};
    const { autonomy, values } = setup({ guard: () => g.reading });
    const s = await autonomy.submit(proposalInput());
    if (!s.ok) throw new Error('setup');
    const a = await autonomy.approve(s.proposal.id, {
      contentHash: s.proposal.contentHash,
      actor: 'operator',
    });
    expect(a.ok).toBe(true);
    expect(values.get('watcher.notice.salienceBar')).toBe(0.6);
    t += 3_600_000;
    await autonomy.tick(t);
    expect(values.get('watcher.notice.salienceBar')).toBe(0.6);
    g.reading = 99;
    await autonomy.tick(t);
    expect(values.get('watcher.notice.salienceBar')).toBe(0.4);
    expect(autonomy.list().changes[0].status).toBe('rolled-back');
  });

  it('timers start and stop', () => {
    const { autonomy } = setup();
    const timers = startAutonomyTimers(autonomy, { everyMs: 60_000 });
    timers.stop();
    timers.stop();
  });
});

describe('proposal routes', () => {
  it('GET /proposals lists with the hash the operator approves against', async () => {
    const { config, autonomy } = setup();
    const s = await autonomy.submit(proposalInput());
    if (!s.ok) throw new Error('setup');
    const res = await app(config, autonomy).request('/api/watcher/proposals');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProposalsResponse;
    expect(body.enabled).toBe(true);
    expect(body.maxPending).toBe(3);
    expect(body.proposals[0].contentHash).toBe(s.proposal.contentHash);
  });

  it('approve → 200 with the change; a wrong hash is 409; revert → 200 then 409', async () => {
    const { config, autonomy, values, applied } = setup();
    const s = await autonomy.submit(proposalInput());
    if (!s.ok) throw new Error('setup');
    const a = app(config, autonomy);
    const wrong = await post(a, `/api/watcher/proposals/${s.proposal.id}/approve`, {
      contentHash: 'a'.repeat(64),
    });
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error).toBeTruthy();
    const missing = await post(a, `/api/watcher/proposals/${s.proposal.id}/approve`, {});
    expect(missing.status).toBe(400);
    const ok = await post(a, `/api/watcher/proposals/${s.proposal.id}/approve`, {
      contentHash: s.proposal.contentHash,
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.proposal.status).toBe('approved');
    expect(body.proposal.decidedBy).toBe('operator');
    expect(body.change.status).toBe('applied');
    expect(values.get('watcher.notice.salienceBar')).toBe(0.6);
    const again = await post(a, `/api/watcher/proposals/${s.proposal.id}/approve`, {
      contentHash: s.proposal.contentHash,
    });
    expect(again.status).toBe(409);
    const rev = await post(a, `/api/watcher/changes/${body.change.id}/revert`);
    expect(rev.status).toBe(200);
    expect((await rev.json()).change.status).toBe('reverted');
    expect(values.get('watcher.notice.salienceBar')).toBe(0.4);
    expect((await post(a, `/api/watcher/changes/${body.change.id}/revert`)).status).toBe(409);
    expect((await post(a, '/api/watcher/changes/c-00000000/revert')).status).toBe(404);
    expect(applied).toEqual([`applied:${body.change.id}`, `reverted:${body.change.id}`]);
  });

  it('approve is 409 when the live value changed since it was proposed', async () => {
    const { config, autonomy, values } = setup();
    const s = await autonomy.submit(proposalInput());
    if (!s.ok) throw new Error('setup');
    values.set('watcher.notice.salienceBar', 0.5);
    const res = await post(
      app(config, autonomy),
      `/api/watcher/proposals/${s.proposal.id}/approve`,
      {
        contentHash: s.proposal.contentHash,
      }
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('changed since it was proposed');
  });

  it('reject → 200 with the note', async () => {
    const { config, autonomy } = setup();
    const s = await autonomy.submit(proposalInput());
    if (!s.ok) throw new Error('setup');
    const res = await post(
      app(config, autonomy),
      `/api/watcher/proposals/${s.proposal.id}/reject`,
      {
        note: 'not now',
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposal.status).toBe('rejected');
    expect(body.proposal.note).toBe('not now');
  });

  it('with proposals off: GET is enabled false and every POST is 404', async () => {
    const { config, autonomy } = setup({ enabled: false });
    for (const a of [app(config, autonomy), app(config, undefined)]) {
      const res = await a.request('/api/watcher/proposals');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        enabled: false,
        proposals: [],
        changes: [],
        maxPending: 3,
      });
      for (const path of [
        '/api/watcher/proposals/p-1/approve',
        '/api/watcher/proposals/p-1/reject',
        '/api/watcher/changes/c-1/revert',
      ]) {
        const r = await post(a, path, { contentHash: 'x' });
        expect(r.status).toBe(404);
        expect((await r.json()).enabled).toBe(false);
      }
    }
  });

  it('a tenant gets 404 on every proposal route', async () => {
    const { config, autonomy } = setup();
    const s = await autonomy.submit(proposalInput());
    if (!s.ok) throw new Error('setup');
    const a = app(config, autonomy, 't1');
    expect((await a.request('/api/watcher/proposals')).status).toBe(404);
    expect(
      (
        await post(a, `/api/watcher/proposals/${s.proposal.id}/approve`, {
          contentHash: s.proposal.contentHash,
        })
      ).status
    ).toBe(404);
    expect((await post(a, `/api/watcher/proposals/${s.proposal.id}/reject`, {})).status).toBe(404);
    expect((await post(a, '/api/watcher/changes/c-1/revert')).status).toBe(404);
    expect(autonomy.list().proposals[0].status).toBe('pending');
  });

  it('an admin in multi-tenant passes', async () => {
    const { config, autonomy } = setup();
    const res = await app(config, autonomy, '__admin__').request('/api/watcher/proposals');
    expect(res.status).toBe(200);
  });
});

describe('review round 1: list', () => {
  it('a live, settling or revert-failed change is always listed; only ended ones are capped', () => {
    const { autonomy } = setup();
    const watcherDir = join(root, 'watcher');
    const HOUR = 3_600_000;
    const rec = (id: string, status: ChangeStatus, at: number): ChangeRecord => ({
      id,
      proposalId: `p-${id.slice(2)}`,
      before: [{ path: 'watcher.notice.salienceBar', value: 0.4 }],
      after: [{ path: 'watcher.notice.salienceBar', value: 0.6 }],
      guard: proposalInput().guard,
      appliedAt: new Date(at).toISOString(),
      guardUntil: new Date(at + 72 * HOUR).toISOString(),
      status,
    });
    const put = (c: ChangeRecord) =>
      appendJsonLine(changesFile(watcherDir), c, autonomyDir(watcherDir));
    put(rec('c-aaaaaaa1', 'applied', t - 200 * HOUR));
    put(rec('c-aaaaaaa2', 'revert-failed', t - 199 * HOUR));
    put(rec('c-aaaaaaa3', 'applying', t - 198 * HOUR));
    put(rec('c-aaaaaaa4', 'reverting', t - 197 * HOUR));
    for (let i = 0; i < LIST_HISTORY_LIMIT + 10; i++) {
      put(rec(`c-${String(i).padStart(8, '0')}`, 'reverted', t - i * 60_000));
    }
    const ids = autonomy.list().changes.map((c) => c.id);
    expect(ids).toContain('c-aaaaaaa1');
    expect(ids).toContain('c-aaaaaaa2');
    expect(ids).toContain('c-aaaaaaa3');
    expect(ids).toContain('c-aaaaaaa4');
    expect(ids.filter((id) => !id.startsWith('c-aaaaaaa')).length).toBe(LIST_HISTORY_LIMIT);
  });
});

/** Makes `path` unwritable for appends (a directory in its place); the returned function restores it. */
function breakFile(path: string): () => void {
  const had = existsSync(path);
  if (had) renameSync(path, `${path}.aside`);
  mkdirSync(path, { recursive: true });
  return () => {
    rmSync(path, { recursive: true, force: true });
    if (had) renameSync(`${path}.aside`, path);
  };
}

describe('write-ahead: unsettled outcomes are 500 through approve and revert', () => {
  // Review round 2 (ledger.test.ts:402): `live: true` and the 500 were never asserted.
  function brokenAfterNextWrite(values: Map<string, unknown>, watcherDir: string) {
    const state = { armed: false, restore: () => {} };
    const access: ValueAccess = {
      read: (p) => values.get(p),
      write: async (vs) => {
        for (const v of vs) values.set(v.path, v.value);
        if (state.armed) {
          state.armed = false;
          state.restore = breakFile(changesFile(watcherDir));
        }
      },
    };
    return { state, access };
  }

  function brokenSetup() {
    const config = testConfig(join(root, 'data'));
    const watcherDir = join(root, 'watcher');
    const values = new Map<string, unknown>([['watcher.notice.salienceBar', 0.4]]);
    const { state, access } = brokenAfterNextWrite(values, watcherDir);
    const autonomy = createAutonomy({ watcherDir, config, log: rowLog(), now: () => t, access });
    return { config, autonomy, values, state };
  }

  it('approve: the ledger result is live, the store says 500, the route says 500; the next tick settles it, never applied twice', async () => {
    const { config, autonomy, values, state } = brokenSetup();
    await autonomy.ready();
    const s = await autonomy.submit(proposalInput());
    if (!s.ok) throw new Error('setup');
    state.armed = true;
    const res = await post(
      app(config, autonomy),
      `/api/watcher/proposals/${s.proposal.id}/approve`,
      {
        contentHash: s.proposal.contentHash,
      }
    );
    state.restore();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('0.6');
    expect(values.get('watcher.notice.salienceBar')).toBe(0.6);
    const listed = autonomy.list();
    expect(listed.changes.map((c) => c.status)).toEqual(['applying']);
    // approving again while it settles never applies twice
    const again = await autonomy.approve(s.proposal.id, {
      contentHash: s.proposal.contentHash,
      actor: 'operator',
    });
    expect(again).toMatchObject({ ok: false, status: 500 });
    expect(autonomy.list().changes.length).toBe(1);
    await autonomy.tick(t);
    const after = autonomy.list();
    expect(after.changes.map((c) => c.status)).toEqual(['applied']);
    expect(after.proposals.find((p) => p.id === s.proposal.id)?.status).toBe('approved');
    expect(after.proposals.find((p) => p.id === s.proposal.id)?.changeId).toBe(after.changes[0].id);
  });

  it('the store maps a live apply failure to 500, an ordinary one to 409', async () => {
    const { autonomy, values, state } = brokenSetup();
    const s = await autonomy.submit(proposalInput());
    if (!s.ok) throw new Error('setup');
    values.set('watcher.notice.salienceBar', 0.5);
    const conflict = await autonomy.approve(s.proposal.id, {
      contentHash: s.proposal.contentHash,
      actor: 'operator',
    });
    expect(conflict).toMatchObject({ ok: false, status: 409 });
    values.set('watcher.notice.salienceBar', 0.4);
    state.armed = true;
    const live = await autonomy.approve(s.proposal.id, {
      contentHash: s.proposal.contentHash,
      actor: 'operator',
    });
    state.restore();
    expect(live).toMatchObject({ ok: false, status: 500 });
  });

  it('revert: a finish that cannot be recorded is 500 on the route; the next tick records it reverted', async () => {
    const { config, autonomy, values, state } = brokenSetup();
    const s = await autonomy.submit(proposalInput());
    if (!s.ok) throw new Error('setup');
    const a = await autonomy.approve(s.proposal.id, {
      contentHash: s.proposal.contentHash,
      actor: 'operator',
    });
    if (!a.ok || !a.change) throw new Error('setup');
    state.armed = true;
    const rev = await post(app(config, autonomy), `/api/watcher/changes/${a.change.id}/revert`);
    state.restore();
    expect(rev.status).toBe(500);
    expect(values.get('watcher.notice.salienceBar')).toBe(0.4);
    expect(autonomy.list().changes[0].status).toBe('reverting');
    await autonomy.tick(t);
    expect(autonomy.list().changes[0].status).toBe('reverted');
  });
});

describe('write-ahead: recovery at construction', () => {
  it('createAutonomy settles every intermediate record before its first call', async () => {
    const watcherDir = join(root, 'watcher');
    const HOUR = 3_600_000;
    const rec = (
      id: string,
      path: string,
      status: ChangeStatus,
      extra: Partial<ChangeRecord> = {}
    ) =>
      appendJsonLine(
        changesFile(watcherDir),
        {
          id,
          proposalId: `p-${id.slice(2)}`,
          before: [{ path, value: 0.4 }],
          after: [{ path, value: 0.6 }],
          guard: proposalInput().guard,
          appliedAt: new Date(t - HOUR).toISOString(),
          guardUntil: new Date(t + HOUR).toISOString(),
          status,
          ...extra,
        } satisfies ChangeRecord,
        autonomyDir(watcherDir)
      );
    rec('c-0000000a', 'watcher.notice.salienceBar', 'applying');
    rec('c-0000000b', 'watcher.integrate.wakeSalience', 'reverting', { cause: 'guard' });
    const config = testConfig(join(root, 'data'));
    const values = new Map<string, unknown>([
      ['watcher.notice.salienceBar', 0.6],
      ['watcher.integrate.wakeSalience', 0.6],
    ]);
    const access: ValueAccess = {
      read: (p) => values.get(p),
      write: async (vs) => {
        for (const v of vs) values.set(v.path, v.value);
      },
    };
    const autonomy = createAutonomy({ watcherDir, config, log: rowLog(), now: () => t, access });
    // before it settles, both are listed as active
    expect(
      autonomy
        .list()
        .changes.map((c) => c.status)
        .sort()
    ).toEqual(['applying', 'reverting']);
    await autonomy.ready();
    const byId = new Map(autonomy.list().changes.map((c) => [c.id, c.status]));
    expect(byId.get('c-0000000a')).toBe('applied');
    expect(byId.get('c-0000000b')).toBe('rolled-back');
    expect(values.get('watcher.integrate.wakeSalience')).toBe(0.4);
    expect(values.get('watcher.notice.salienceBar')).toBe(0.6);
  });
});

describe('write-ahead: an apply-failed change', () => {
  it('leaves its proposal pending and approvable again; the next approval applies once', async () => {
    const config = testConfig(join(root, 'data'));
    const values = new Map<string, unknown>([['watcher.notice.salienceBar', 0.4]]);
    let fail = true;
    const access: ValueAccess = {
      read: (p) => values.get(p),
      write: async (vs) => {
        if (fail) throw new Error('disk full');
        for (const v of vs) values.set(v.path, v.value);
      },
    };
    const autonomy = createAutonomy({
      watcherDir: join(root, 'watcher'),
      config,
      log: rowLog(),
      now: () => t,
      access,
    });
    const s = await autonomy.submit(proposalInput());
    if (!s.ok) throw new Error('setup');
    const opts = { contentHash: s.proposal.contentHash, actor: 'operator' as const };
    expect(await autonomy.approve(s.proposal.id, opts)).toMatchObject({ ok: false, status: 409 });
    expect(autonomy.list().changes.map((c) => c.status)).toEqual(['apply-failed']);
    await autonomy.tick(t);
    expect(autonomy.list().proposals.find((p) => p.id === s.proposal.id)?.status).toBe('pending');
    fail = false;
    const ok = await autonomy.approve(s.proposal.id, opts);
    expect(ok.ok).toBe(true);
    expect(values.get('watcher.notice.salienceBar')).toBe(0.6);
    expect(
      autonomy
        .list()
        .changes.map((c) => c.status)
        .sort()
    ).toEqual(['applied', 'apply-failed']);
  });
});

describe('review round 3: list and accept', () => {
  async function approved(autonomy: AutonomyApi) {
    const s = await autonomy.submit(proposalInput());
    if (!s.ok) throw new Error('setup');
    const a = await autonomy.approve(s.proposal.id, {
      contentHash: s.proposal.contentHash,
      actor: 'operator',
    });
    if (!a.ok || !a.change) throw new Error('setup');
    return a.change;
  }

  it('list writes nothing (GET and Needs You stay read-only): an expired proposal shows expired, the tick stores it', async () => {
    const { autonomy } = setup();
    const s = await autonomy.submit(proposalInput());
    if (!s.ok) throw new Error('setup');
    const file = join(autonomyDir(join(root, 'watcher')), 'proposals.jsonl');
    t += 73 * 3_600_000;
    const before = readFileSync(file, 'utf-8');
    expect(autonomy.list().proposals.find((p) => p.id === s.proposal.id)?.status).toBe('expired');
    expect(readFileSync(file, 'utf-8')).toBe(before);
    await autonomy.tick(t);
    expect(readFileSync(file, 'utf-8')).not.toBe(before);
    expect(autonomy.list().proposals.find((p) => p.id === s.proposal.id)?.status).toBe('expired');
  });

  it('a change keeps its title after its proposal left the decided history', async () => {
    const { autonomy } = setup();
    const change = await approved(autonomy);
    const watcherDir = join(root, 'watcher');
    for (let i = 0; i < LIST_HISTORY_LIMIT + 5; i++) {
      t += 60_000;
      const s = await autonomy.submit(proposalInput({ title: `Other ${i}` }));
      if (!s.ok) throw new Error('setup');
      await autonomy.reject(s.proposal.id, { actor: 'operator' });
    }
    const listed = autonomy.list();
    expect(listed.proposals.some((p) => p.id === change.proposalId)).toBe(false);
    expect(listed.changes.find((c) => c.id === change.id)?.title).toBe(proposalInput().title);
    // a record from before the field: filled from the full store
    const { title: _drop, ...old } = change;
    appendJsonLine(changesFile(watcherDir), old, autonomyDir(watcherDir));
    expect(autonomy.list().changes.find((c) => c.id === change.id)?.title).toBe(
      proposalInput().title
    );
  });

  it('a needs-you change carries the values live now; accept → 200 accepted, then it leaves the open list', async () => {
    const { config, autonomy, values } = setup({ guard: () => 99 });
    const change = await approved(autonomy);
    values.set('watcher.notice.salienceBar', 1.2);
    t += 3_600_000;
    await autonomy.tick(t);
    const listed = autonomy.list().changes.find((c) => c.id === change.id);
    expect(listed?.status).toBe('revert-failed');
    expect(listed?.live).toEqual([{ path: 'watcher.notice.salienceBar', value: 1.2 }]);
    const a = app(config, autonomy);
    expect((await post(a, `/api/watcher/changes/${change.id}/revert`)).status).toBe(409);
    const res = await post(a, `/api/watcher/changes/${change.id}/accept`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.change.status).toBe('accepted');
    expect(body.change.found).toEqual([{ path: 'watcher.notice.salienceBar', value: 1.2 }]);
    expect(values.get('watcher.notice.salienceBar')).toBe(1.2);
    expect((await post(a, `/api/watcher/changes/${change.id}/accept`)).status).toBe(409);
    expect((await post(a, '/api/watcher/changes/c-00000000/accept')).status).toBe(404);
    const after = autonomy.list().changes.find((c) => c.id === change.id);
    expect(after?.status).toBe('accepted');
    expect(after?.live).toBeUndefined();
    // ended: subject to the history cap like any other ended change
    const watcherDir = join(root, 'watcher');
    for (let i = 0; i < LIST_HISTORY_LIMIT; i++) {
      appendJsonLine(
        changesFile(watcherDir),
        {
          ...after,
          id: `c-${String(i).padStart(8, '0')}`,
          appliedAt: new Date(t + i).toISOString(),
        },
        autonomyDir(watcherDir)
      );
    }
    expect(autonomy.list().changes.some((c) => c.id === change.id)).toBe(false);
  });

  it('accept is 404 with proposals off and for a tenant', async () => {
    const off = setup({ enabled: false });
    expect(
      (await post(app(off.config, off.autonomy), '/api/watcher/changes/c-1/accept')).status
    ).toBe(404);
    const on = setup();
    expect(
      (await post(app(on.config, on.autonomy, 't1'), '/api/watcher/changes/c-1/accept')).status
    ).toBe(404);
  });
});
