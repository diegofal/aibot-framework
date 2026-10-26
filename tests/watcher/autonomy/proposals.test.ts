import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCKED_EXAMPLES } from '../../../src/watcher/autonomy/locked';
import {
  ProposalStore,
  parseProposal,
  proposalHash,
  proposalsFile,
  readProposals,
} from '../../../src/watcher/autonomy/proposals';
import type { ChangeRecord, Proposal } from '../../../src/watcher/autonomy/types';
import { proposalInput, rowLog, testConfig } from './fixtures';

let dir: string;
let t: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autonomy-proposals-'));
  t = Date.parse('2026-10-25T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const HOUR = 3_600_000;

function makeStore(
  opts: {
    maxPending?: number;
    apply?: (
      p: Proposal
    ) => Promise<{ ok: true; change: ChangeRecord } | { ok: false; error: string }>;
  } = {}
) {
  const config = testConfig(join(dir, 'data'));
  const log = rowLog();
  let applied = 0;
  const store = new ProposalStore({
    watcherDir: dir,
    log,
    now: () => t,
    settings: () => ({ maxPending: opts.maxPending ?? 3, approvalTtlHours: 72 }),
    lockContext: () => ({ config }),
    apply:
      opts.apply ??
      (async (p) => {
        applied++;
        return {
          ok: true,
          change: {
            id: `c-0000000${applied}`,
            proposalId: p.id,
            before: [],
            after: [],
            guard: p.guard,
            appliedAt: new Date(t).toISOString(),
            guardUntil: new Date(t + p.guard.windowHours * HOUR).toISOString(),
            status: 'applied',
          },
        };
      }),
  });
  return { store, log, config, applied: () => applied };
}

const ctx = () => ({ config: testConfig('/tmp/none') });

describe('parseProposal', () => {
  it('accepts a valid threshold proposal and drops unknown fields', () => {
    const r = parseProposal({ ...proposalInput(), extra: 'x' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect('extra' in r.input).toBe(false);
  });

  it('rejects bad structure', () => {
    const bad = [
      null,
      'nope',
      proposalInput({ title: 'x'.repeat(121) }),
      proposalInput({ rationale: 'x'.repeat(1001) }),
      proposalInput({ support: [] }),
      proposalInput({ support: Array.from({ length: 21 }, (_, i) => `n-${i}`) }),
      proposalInput({ changes: [] }),
      proposalInput({
        changes: Array.from({ length: 6 }, () => ({
          path: 'watcher.notice.salienceBar',
          from: 0.4,
          to: 0.5,
        })),
      }),
      proposalInput({ guard: { metric: 'made.up', direction: 'max', bound: 1, windowHours: 24 } }),
      proposalInput({
        guard: { metric: 'watcher.costUsdPerDay', direction: 'max', bound: 1, windowHours: 0 },
      }),
      proposalInput({
        guard: { metric: 'watcher.costUsdPerDay', direction: 'max', bound: 1, windowHours: 337 },
      }),
      proposalInput({ proposedBy: 'operator' as never }),
      proposalInput({ kind: 'magic' as never }),
    ];
    for (const b of bad) {
      const r = parseProposal(b, ctx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.locked).toBe(false);
    }
  });

  it('a locked path or an out-of-range value is rejected-locked, with a note', () => {
    const r = parseProposal(
      proposalInput({ changes: [{ path: 'watcher.integrate.maxPerDay', from: 24, to: 40 }] }),
      ctx()
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.locked) expect(r.note).toContain('watcher.integrate.maxPerDay');
    const range = parseProposal(
      proposalInput({ changes: [{ path: 'watcher.notice.salienceBar', from: 0.4, to: 9 }] }),
      ctx()
    );
    expect(range.ok === false && range.locked).toBe(true);
  });

  it('kind must match the path family', () => {
    const wrong = parseProposal(
      proposalInput({ kind: 'fleet-cadence' }), // watcher.* path under fleet-cadence
      ctx()
    );
    expect(wrong.ok === false && wrong.locked).toBe(true);
    const right = parseProposal(
      proposalInput({
        kind: 'fleet-cadence',
        changes: [{ path: 'bots.b1.agentLoop.every', from: '2h', to: '6h' }],
      }),
      ctx()
    );
    expect(right.ok).toBe(true);
  });

  it('prompt-section is not available in rung 0', () => {
    const r = parseProposal(proposalInput({ kind: 'prompt-section' }), ctx());
    expect(r.ok === false && r.locked).toBe(true);
    if (!r.ok && r.locked) expect(r.note).toContain('not available in rung 0');
  });
});

describe('proposalHash', () => {
  it('is sha256 hex, independent of key order, and changes with the content', () => {
    const a = proposalInput();
    const reordered = {
      ...Object.fromEntries(Object.entries(a).reverse()),
      guard: Object.fromEntries(Object.entries(a.guard).reverse()),
    } as typeof a;
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(a)[0]);
    expect(proposalHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(proposalHash(reordered)).toBe(proposalHash(a));
    expect(proposalHash(proposalInput({ title: 'Other' }))).not.toBe(proposalHash(a));
  });
});

describe('ProposalStore', () => {
  it('every locked example is stored rejected-locked, never pending, with one row each', () => {
    const { store, log } = makeStore();
    for (const [i, path] of LOCKED_EXAMPLES.entries()) {
      const r = store.submit(
        proposalInput({ title: `Locked ${i}`, changes: [{ path, from: 1, to: 2 }] })
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.proposal?.status).toBe('rejected-locked');
    }
    const all = store.all();
    expect(all.length).toBe(LOCKED_EXAMPLES.length);
    expect(all.every((p) => p.status === 'rejected-locked' && p.note)).toBe(true);
    expect(store.reviewable()).toEqual([]);
    expect(log.ops().filter((o) => o === 'autonomy:rejected-locked').length).toBe(
      LOCKED_EXAMPLES.length
    );
  });

  it('a prompt-section proposal is stored rejected-locked', () => {
    const { store } = makeStore();
    const r = store.submit(proposalInput({ kind: 'prompt-section' }));
    expect(r.ok).toBe(false);
    expect(store.all()[0].status).toBe('rejected-locked');
  });

  it('a structurally invalid proposal is not stored, but is logged', () => {
    const { store, log } = makeStore();
    const r = store.submit({ title: 'x' });
    expect(r.ok).toBe(false);
    expect(store.all()).toEqual([]);
    expect(log.ops()).toEqual(['autonomy:invalid']);
  });

  it('a valid proposal goes pending with a 72 h expiry and a hash', () => {
    const { store, log } = makeStore();
    const r = store.submit(proposalInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.id).toMatch(/^p-[0-9a-f]{8}$/);
    expect(r.proposal.status).toBe('pending');
    expect(r.proposal.contentHash).toBe(proposalHash(proposalInput()));
    expect(Date.parse(r.proposal.expiresAt ?? '') - t).toBe(72 * HOUR);
    expect(log.ops()).toEqual(['autonomy:proposed']);
  });

  it('dedupes an identical open proposal', () => {
    const { store } = makeStore();
    const a = store.submit(proposalInput());
    const b = store.submit(proposalInput());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.proposal.id).toBe(a.proposal.id);
      expect(b.deduped).toBe(true);
    }
    expect(store.all().length).toBe(1);
  });

  it('the 4th proposal is queued and not shown; a decision promotes it', async () => {
    const { store } = makeStore();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = store.submit(proposalInput({ title: `Proposal ${i}` }));
      if (r.ok) ids.push(r.proposal.id);
    }
    expect(store.get(ids[3])?.status).toBe('queued');
    expect(store.reviewable().map((p) => p.id)).toEqual(ids.slice(0, 3));
    t += HOUR;
    const rej = await store.reject(ids[0], { actor: 'operator', note: 'no' });
    expect(rej.ok).toBe(true);
    const promoted = store.get(ids[3]);
    expect(promoted?.status).toBe('pending');
    expect(Date.parse(promoted?.expiresAt ?? '') - t).toBe(72 * HOUR);
    expect(store.get(ids[0])?.note).toBe('no');
  });

  it('a pending proposal expires after its TTL and frees its slot', () => {
    const { store, log } = makeStore({ maxPending: 1 });
    const a = store.submit(proposalInput({ title: 'A' }));
    const b = store.submit(proposalInput({ title: 'B' }));
    if (!a.ok || !b.ok) throw new Error('setup');
    expect(store.get(b.proposal.id)?.status).toBe('queued');
    t += 72 * HOUR;
    store.refresh();
    expect(store.get(a.proposal.id)?.status).toBe('expired');
    expect(store.get(b.proposal.id)?.status).toBe('pending');
    expect(log.ops()).toContain('autonomy:expired');
  });

  it('approve applies, binds the decision to the operator and the hash', async () => {
    const { store, log, applied } = makeStore();
    const r = store.submit(proposalInput());
    if (!r.ok) throw new Error('setup');
    const res = await store.approve(r.proposal.id, {
      contentHash: r.proposal.contentHash,
      actor: 'operator',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.proposal.status).toBe('approved');
    expect(res.proposal.decidedBy).toBe('operator');
    expect(res.proposal.changeId).toBe(res.change?.id);
    expect(applied()).toBe(1);
    expect(log.ops()).toContain('autonomy:approved');
  });

  it('refuses a mismatched hash, an actor that is not the operator, and an expired proposal', async () => {
    const { store, applied } = makeStore();
    const r = store.submit(proposalInput());
    if (!r.ok) throw new Error('setup');
    const wrongHash = await store.approve(r.proposal.id, {
      contentHash: 'f'.repeat(64),
      actor: 'operator',
    });
    expect(wrongHash).toMatchObject({ ok: false, status: 409 });
    for (const actor of ['watcher', 'bot', 'test', undefined, 'Operator']) {
      const res = await store.approve(r.proposal.id, {
        contentHash: r.proposal.contentHash,
        actor: actor as never,
      });
      expect(res).toMatchObject({ ok: false, status: 403 });
      const rej = await store.reject(r.proposal.id, { actor: actor as never });
      expect(rej).toMatchObject({ ok: false, status: 403 });
    }
    t += 73 * HOUR;
    const late = await store.approve(r.proposal.id, {
      contentHash: r.proposal.contentHash,
      actor: 'operator',
    });
    expect(late).toMatchObject({ ok: false, status: 409 });
    expect(store.get(r.proposal.id)?.status).toBe('expired');
    expect(applied()).toBe(0);
  });

  it('refuses to approve a queued or rejected-locked proposal, and an unknown id', async () => {
    const { store } = makeStore({ maxPending: 1 });
    store.submit(proposalInput({ title: 'A' }));
    const q = store.submit(proposalInput({ title: 'B' }));
    const locked = store.submit(
      proposalInput({ changes: [{ path: 'watcher.enabled', from: true, to: false }] })
    );
    if (!q.ok || locked.ok || !locked.proposal) throw new Error('setup');
    expect(
      await store.approve(q.proposal.id, { contentHash: q.proposal.contentHash, actor: 'operator' })
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      await store.approve(locked.proposal.id, {
        contentHash: locked.proposal.contentHash,
        actor: 'operator',
      })
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      await store.approve('p-00000000', { contentHash: 'x', actor: 'operator' })
    ).toMatchObject({ ok: false, status: 404 });
  });

  it('an apply failure leaves the proposal pending with a note', async () => {
    const { store } = makeStore({
      apply: async () => ({
        ok: false,
        error: 'watcher.notice.salienceBar changed since it was proposed',
      }),
    });
    const r = store.submit(proposalInput());
    if (!r.ok) throw new Error('setup');
    const res = await store.approve(r.proposal.id, {
      contentHash: r.proposal.contentHash,
      actor: 'operator',
    });
    expect(res).toMatchObject({ ok: false, status: 409 });
    const p = store.get(r.proposal.id);
    expect(p?.status).toBe('pending');
    expect(p?.note).toContain('changed since it was proposed');
  });

  it('re-checks the lock at approval time (the bot became a tenant bot)', async () => {
    const { store, config, applied } = makeStore();
    const r = store.submit(
      proposalInput({
        kind: 'fleet-cadence',
        changes: [{ path: 'bots.b1.agentLoop.every', from: '2h', to: '6h' }],
      })
    );
    if (!r.ok) throw new Error('setup');
    (config.bots[0] as { tenantId?: string }).tenantId = 't9';
    const res = await store.approve(r.proposal.id, {
      contentHash: r.proposal.contentHash,
      actor: 'operator',
    });
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(applied()).toBe(0);
  });

  it('the store survives a malformed line and keeps the last line per id', () => {
    const { store } = makeStore();
    const r = store.submit(proposalInput());
    if (!r.ok) throw new Error('setup');
    appendFileSync(proposalsFile(dir), '{not json\n\n{"id": 5}\n');
    appendFileSync(
      proposalsFile(dir),
      `${JSON.stringify({ ...r.proposal, note: 'later line' })}\n`
    );
    const rows = readProposals(dir);
    expect(rows.length).toBe(1);
    expect(rows[0].note).toBe('later line');
    const fresh = makeStore().store;
    expect(fresh.get(r.proposal.id)?.status).toBe('pending');
  });

  it('readers never throw on a missing dir', () => {
    expect(readProposals(join(dir, 'nope'))).toEqual([]);
  });
});
