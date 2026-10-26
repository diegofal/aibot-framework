import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../../src/config';
import {
  ChangeLedger,
  type ValueAccess,
  changesFile,
  createConfigAccess,
  readChanges,
} from '../../../src/watcher/autonomy/ledger';
import { proposalHash } from '../../../src/watcher/autonomy/proposals';
import type { Proposal, ProposalInput } from '../../../src/watcher/autonomy/types';
import { proposalInput, rowLog, testConfig } from './fixtures';

let dir: string;
let t: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autonomy-ledger-'));
  t = Date.parse('2026-10-25T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const HOUR = 3_600_000;

function proposal(over: Partial<ProposalInput> = {}): Proposal {
  const input = proposalInput(over);
  return {
    ...input,
    id: 'p-abcdef01',
    contentHash: proposalHash(input),
    status: 'pending',
    createdAt: new Date(t).toISOString(),
  };
}

/** An in-memory value store. */
function memAccess(initial: Record<string, unknown>) {
  const values = new Map(Object.entries(initial));
  let failWrites = false;
  const access: ValueAccess = {
    read: (path) => values.get(path),
    write: async (vs) => {
      if (failWrites) throw new Error('disk full');
      for (const v of vs) values.set(v.path, v.value);
    },
  };
  return {
    access,
    values,
    failWrites: (on: boolean) => {
      failWrites = on;
    },
  };
}

function makeLedger(
  initial: Record<string, unknown>,
  guard?: (metric: string, range: { sinceMs: number; nowMs: number }) => number | undefined
) {
  const mem = memAccess(initial);
  const log = rowLog();
  const applied: string[] = [];
  const ledger = new ChangeLedger({
    watcherDir: dir,
    access: mem.access,
    log,
    now: () => t,
    guards: guard ?? (() => undefined),
    onApplied: (change, event) => applied.push(`${event}:${change.id}`),
  });
  return { ledger, mem, log, applied };
}

describe('ChangeLedger', () => {
  it('apply records before/after and the guard window', async () => {
    const { ledger, mem, log, applied } = makeLedger({ 'watcher.notice.salienceBar': 0.4 });
    const r = await ledger.apply(proposal());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.change.id).toMatch(/^c-[0-9a-f]{8}$/);
    expect(r.change.before).toEqual([{ path: 'watcher.notice.salienceBar', value: 0.4 }]);
    expect(r.change.after).toEqual([{ path: 'watcher.notice.salienceBar', value: 0.6 }]);
    expect(Date.parse(r.change.guardUntil) - t).toBe(72 * HOUR);
    expect(r.change.status).toBe('applied');
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.6);
    expect(readChanges(dir).map((c) => c.id)).toEqual([r.change.id]);
    expect(log.ops()).toEqual(['autonomy:applied']);
    expect(applied).toEqual([`applied:${r.change.id}`]);
  });

  it('refuses when a live value changed since it was proposed', async () => {
    const { ledger, mem } = makeLedger({ 'watcher.notice.salienceBar': 0.5 });
    const r = await ledger.apply(proposal());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('changed since it was proposed');
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.5);
    expect(readChanges(dir)).toEqual([]);
  });

  it('a write failure is an error and records nothing', async () => {
    const { ledger, mem } = makeLedger({ 'watcher.notice.salienceBar': 0.4 });
    mem.failWrites(true);
    const r = await ledger.apply(proposal());
    expect(r.ok).toBe(false);
    expect(readChanges(dir)).toEqual([]);
  });

  it('revert writes the before value back exactly, for the operator only', async () => {
    const { ledger, mem, log } = makeLedger({ 'watcher.notice.salienceBar': 0.4 });
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    const refused = await ledger.revert(r.change.id, { actor: 'watcher' as never });
    expect(refused).toMatchObject({ ok: false, status: 403 });
    const back = await ledger.revert(r.change.id, { actor: 'operator' });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.change.status).toBe('reverted');
    expect(back.change.endedAt).toBe(new Date(t).toISOString());
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.4);
    expect(log.ops()).toContain('autonomy:reverted');
    const again = await ledger.revert(r.change.id, { actor: 'operator' });
    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  it('revert restores a structured or missing before value byte for byte', async () => {
    const { ledger, mem } = makeLedger({});
    const p = proposal({
      kind: 'fleet-cadence',
      changes: [{ path: 'bots.b1.agentLoop.every', from: undefined, to: '6h' }],
    });
    const r = await ledger.apply(p);
    if (!r.ok) throw new Error(r.error);
    expect(mem.values.get('bots.b1.agentLoop.every')).toBe('6h');
    const back = await ledger.revert(r.change.id, { actor: 'operator' });
    expect(back.ok).toBe(true);
    expect(mem.values.get('bots.b1.agentLoop.every') ?? null).toBeNull();
  });

  it('revert is refused when the live value changed since apply; it stays applied', async () => {
    const { ledger, mem } = makeLedger({ 'watcher.notice.salienceBar': 0.4 });
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    mem.values.set('watcher.notice.salienceBar', 0.9);
    const back = await ledger.revert(r.change.id, { actor: 'operator' });
    expect(back).toMatchObject({ ok: false, status: 409 });
    expect(ledger.get(r.change.id)?.status).toBe('applied');
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.9);
  });

  it('unknown change id is 404', async () => {
    const { ledger } = makeLedger({});
    expect(await ledger.revert('c-00000000', { actor: 'operator' })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('a guard breach inside the window rolls back by code and says why', async () => {
    let reading: number | undefined = 2;
    const { ledger, mem, log, applied } = makeLedger(
      { 'watcher.notice.salienceBar': 0.4 },
      () => reading
    );
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    t += HOUR;
    expect(await ledger.checkGuards(t)).toEqual([]);
    expect(ledger.get(r.change.id)?.status).toBe('applied');
    reading = 3.5;
    const rolled = await ledger.checkGuards(t);
    expect(rolled.map((c) => c.id)).toEqual([r.change.id]);
    const c = ledger.get(r.change.id);
    expect(c?.status).toBe('rolled-back');
    expect(c?.endReason).toContain('watcher.costUsdPerDay');
    expect(c?.endReason).toContain('3.5');
    expect(c?.endReason).toContain('3');
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.4);
    expect(log.ops()).toContain('autonomy:rolled-back');
    expect(applied).toContain(`rolled-back:${r.change.id}`);
  });

  it('a min guard rolls back when the reading falls below the bound', async () => {
    const { ledger } = makeLedger({ 'watcher.notice.salienceBar': 0.4 }, () => 0.1);
    const r = await ledger.apply(
      proposal({
        guard: { metric: 'fleet.errorCycleShare', direction: 'min', bound: 0.2, windowHours: 24 },
      })
    );
    if (!r.ok) throw new Error('setup');
    await ledger.checkGuards(t + HOUR);
    expect(ledger.get(r.change.id)?.status).toBe('rolled-back');
  });

  it('no data never rolls back, and nothing is checked past the window', async () => {
    const g: { reading?: number } = {};
    const { ledger } = makeLedger({ 'watcher.notice.salienceBar': 0.4 }, () => g.reading);
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    await ledger.checkGuards(t + HOUR);
    expect(ledger.get(r.change.id)?.status).toBe('applied');
    g.reading = 100;
    await ledger.checkGuards(t + 73 * HOUR);
    expect(ledger.get(r.change.id)?.status).toBe('applied');
  });

  it('a guard reader that throws never rolls back and never throws', async () => {
    const { ledger } = makeLedger({ 'watcher.notice.salienceBar': 0.4 }, () => {
      throw new Error('boom');
    });
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    expect(await ledger.checkGuards(t + HOUR)).toEqual([]);
    expect(ledger.get(r.change.id)?.status).toBe('applied');
  });

  it('a failed rollback is revert-failed with the before values kept, and the operator can still revert', async () => {
    const { ledger, mem, log } = makeLedger({ 'watcher.notice.salienceBar': 0.4 }, () => 10);
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    mem.failWrites(true);
    await ledger.checkGuards(t + HOUR);
    const c = ledger.get(r.change.id);
    expect(c?.status).toBe('revert-failed');
    expect(c?.before).toEqual([{ path: 'watcher.notice.salienceBar', value: 0.4 }]);
    expect(log.ops()).toContain('autonomy:revert-failed');
    mem.failWrites(false);
    const back = await ledger.revert(r.change.id, { actor: 'operator' });
    expect(back.ok).toBe(true);
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.4);
  });

  it('a rollback leaves a value the operator changed by hand alone', async () => {
    const { ledger, mem } = makeLedger({ 'watcher.notice.salienceBar': 0.4 }, () => 10);
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    mem.values.set('watcher.notice.salienceBar', 1.2);
    await ledger.checkGuards(t + HOUR);
    expect(ledger.get(r.change.id)?.status).toBe('revert-failed');
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(1.2);
  });

  it('survives a malformed line', async () => {
    const { ledger } = makeLedger({ 'watcher.notice.salienceBar': 0.4 });
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    appendFileSync(changesFile(dir), 'garbage\n{"id":1}\n');
    expect(readChanges(dir).map((c) => c.id)).toEqual([r.change.id]);
  });
});

describe('createConfigAccess', () => {
  function files(config: Config) {
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ watcher: { enabled: true, notice: { salienceBar: 0.4, model: '${PATH}' } } })
    );
    writeFileSync(
      join(dir, 'bots.json'),
      JSON.stringify([
        { id: 'b1', name: 'b1', token: '${B1_TOKEN}', agentLoop: { every: '2h' } },
        { id: 'b2', name: 'b2' },
      ])
    );
    return { configPath, access: createConfigAccess({ config, configPath }) };
  }

  it('reads live values by path', () => {
    const config = testConfig(join(dir, 'data'));
    const access = createConfigAccess({ config });
    expect(access.read('watcher.notice.salienceBar')).toBe(0.4);
    expect(access.read('bots.b1.agentLoop.every')).toBe('2h');
    expect(access.read('bots.b2.agentLoop.every')).toBeUndefined();
    expect(access.read('bots.nobody.agentLoop.every')).toBeUndefined();
  });

  it('persists a watcher value raw and replaces the live tier object', async () => {
    const config = testConfig(join(dir, 'data'));
    const notice = config.watcher?.notice;
    const { configPath, access } = files(config);
    await access.write([{ path: 'watcher.notice.salienceBar', value: 0.6 }]);
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(raw.watcher.notice.salienceBar).toBe(0.6);
    expect(raw.watcher.notice.model).toBe('${PATH}');
    expect(config.watcher?.notice.salienceBar).toBe(0.6);
    expect(config.watcher?.notice).not.toBe(notice);
    expect(notice?.salienceBar).toBe(0.4);
  });

  it('persists a bot cadence into bots.json raw, and removes it on a missing before value', async () => {
    const config = testConfig(join(dir, 'data'));
    const { access } = files(config);
    await access.write([{ path: 'bots.b2.agentLoop.every', value: '6h' }]);
    let raw = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect(raw[1].agentLoop.every).toBe('6h');
    expect(raw[0].token).toBe('${B1_TOKEN}');
    expect(access.read('bots.b2.agentLoop.every')).toBe('6h');
    await access.write([{ path: 'bots.b2.agentLoop.every', value: undefined }]);
    raw = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf-8'));
    expect('every' in (raw[1].agentLoop ?? {})).toBe(false);
    expect(access.read('bots.b2.agentLoop.every')).toBeUndefined();
  });

  it('a write that would not validate leaves file and live config untouched', async () => {
    const config = testConfig(join(dir, 'data'));
    const { configPath, access } = files(config);
    await expect(
      access.write([{ path: 'watcher.notice.salienceBar', value: -1 }])
    ).rejects.toThrow();
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).watcher.notice.salienceBar).toBe(0.4);
    expect(config.watcher?.notice.salienceBar).toBe(0.4);
  });

  it('refuses a path outside the tunables', async () => {
    const config = testConfig(join(dir, 'data'));
    const { configPath, access } = files(config);
    await expect(access.write([{ path: 'watcher.enabled', value: false }])).rejects.toThrow();
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).watcher.enabled).toBe(true);
  });
});
