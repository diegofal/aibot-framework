import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Config } from '../../../src/config';
import {
  type AutonomyApi,
  createAutonomy,
  startAutonomyTimers,
} from '../../../src/watcher/autonomy';
import type { ValueAccess } from '../../../src/watcher/autonomy/ledger';
import type { ProposalsResponse } from '../../../src/watcher/autonomy/types';
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
