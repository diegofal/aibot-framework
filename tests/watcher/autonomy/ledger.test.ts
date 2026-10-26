import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { appendJsonLine, autonomyDir, proposalHash } from '../../../src/watcher/autonomy/proposals';
import type { ChangeRecord, Proposal, ProposalInput } from '../../../src/watcher/autonomy/types';
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

describe('review round 1: ledger', () => {
  it('revert writes an env reference back to bots.json, and its expanded value to the live config', async () => {
    process.env.AUTONOMY_TEST_CADENCE = '2h';
    try {
      const config = testConfig(join(dir, 'data'));
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({ watcher: { enabled: true } }));
      const botsPath = join(dir, 'bots.json');
      writeFileSync(
        botsPath,
        JSON.stringify([{ id: 'b1', name: 'b1', agentLoop: { every: '${AUTONOMY_TEST_CADENCE}' } }])
      );
      const ledger = new ChangeLedger({
        watcherDir: dir,
        access: createConfigAccess({ config, configPath }),
        now: () => t,
      });
      const r = await ledger.apply(
        proposal({
          kind: 'fleet-cadence',
          changes: [{ path: 'bots.b1.agentLoop.every', from: '2h', to: '6h' }],
        })
      );
      if (!r.ok) throw new Error(r.error);
      expect(JSON.parse(readFileSync(botsPath, 'utf-8'))[0].agentLoop.every).toBe('6h');
      const back = await ledger.revert(r.change.id, { actor: 'operator' });
      expect(back.ok).toBe(true);
      expect(JSON.parse(readFileSync(botsPath, 'utf-8'))[0].agentLoop.every).toBe(
        '${AUTONOMY_TEST_CADENCE}'
      );
      const live = config.bots.find((b) => b.id === 'b1');
      expect(live?.agentLoop?.every).toBe('2h');
    } finally {
      Reflect.deleteProperty(process.env, 'AUTONOMY_TEST_CADENCE');
    }
  });

  it('revert restores an env reference with the variable changed: the live value is its current expansion', async () => {
    // Review round 2 (ledger.ts:519): the saved expansion (2h) must not go live
    // while the file says ${VAR} and VAR is now 3h.
    process.env.AUTONOMY_TEST_CADENCE = '2h';
    try {
      const config = testConfig(join(dir, 'data'));
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({ watcher: { enabled: true } }));
      const botsPath = join(dir, 'bots.json');
      writeFileSync(
        botsPath,
        JSON.stringify([{ id: 'b1', name: 'b1', agentLoop: { every: '${AUTONOMY_TEST_CADENCE}' } }])
      );
      const ledger = new ChangeLedger({
        watcherDir: dir,
        access: createConfigAccess({ config, configPath }),
        now: () => t,
      });
      const r = await ledger.apply(
        proposal({
          kind: 'fleet-cadence',
          changes: [{ path: 'bots.b1.agentLoop.every', from: '2h', to: '6h' }],
        })
      );
      if (!r.ok) throw new Error(r.error);
      process.env.AUTONOMY_TEST_CADENCE = '3h';
      const back = await ledger.revert(r.change.id, { actor: 'operator' });
      expect(back.ok).toBe(true);
      expect(JSON.parse(readFileSync(botsPath, 'utf-8'))[0].agentLoop.every).toBe(
        '${AUTONOMY_TEST_CADENCE}'
      );
      expect(config.bots.find((b) => b.id === 'b1')?.agentLoop?.every).toBe('3h');
    } finally {
      Reflect.deleteProperty(process.env, 'AUTONOMY_TEST_CADENCE');
    }
  });

  it('an env reference that cannot be expanded any more is not written: the change needs the operator', async () => {
    process.env.AUTONOMY_TEST_CADENCE = '2h';
    try {
      const config = testConfig(join(dir, 'data'));
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({ watcher: { enabled: true } }));
      const botsPath = join(dir, 'bots.json');
      writeFileSync(
        botsPath,
        JSON.stringify([{ id: 'b1', name: 'b1', agentLoop: { every: '${AUTONOMY_TEST_CADENCE}' } }])
      );
      const log = rowLog();
      const ledger = new ChangeLedger({
        watcherDir: dir,
        access: createConfigAccess({ config, configPath }),
        log,
        now: () => t,
      });
      const r = await ledger.apply(
        proposal({
          kind: 'fleet-cadence',
          changes: [{ path: 'bots.b1.agentLoop.every', from: '2h', to: '6h' }],
        })
      );
      if (!r.ok) throw new Error(r.error);
      Reflect.deleteProperty(process.env, 'AUTONOMY_TEST_CADENCE');
      const back = await ledger.revert(r.change.id, { actor: 'operator' });
      expect(back).toMatchObject({ ok: false, status: 409 });
      if (!back.ok) expect(back.error).toContain('AUTONOMY_TEST_CADENCE');
      expect(JSON.parse(readFileSync(botsPath, 'utf-8'))[0].agentLoop.every).toBe('6h');
      expect(config.bots.find((b) => b.id === 'b1')?.agentLoop?.every).toBe('6h');
      expect(ledger.get(r.change.id)?.status).toBe('revert-failed');
      expect(log.ops()).toContain('autonomy:revert-failed');
    } finally {
      Reflect.deleteProperty(process.env, 'AUTONOMY_TEST_CADENCE');
    }
  });
});

/** Breaks `changesFile` right after the next successful value write (so only the record after it fails). */
function failNextRecordAfterWrite(access: ValueAccess): { restore: () => void } {
  const out = { restore: () => {} };
  const write = access.write;
  let armed = true;
  access.write = async (vs) => {
    await write(vs);
    if (armed) {
      armed = false;
      out.restore = breakFile(changesFile(dir));
    }
  };
  return out;
}

/** A change record put on disk as a previous process left it. */
function putRecord(over: Partial<ChangeRecord> & Pick<ChangeRecord, 'status'>): ChangeRecord {
  const rec: ChangeRecord = {
    id: 'c-12345678',
    proposalId: 'p-abcdef01',
    before: [{ path: 'watcher.notice.salienceBar', value: 0.4 }],
    after: [{ path: 'watcher.notice.salienceBar', value: 0.6 }],
    guard: proposalInput().guard,
    appliedAt: new Date(t - HOUR).toISOString(),
    guardUntil: new Date(t + 71 * HOUR).toISOString(),
    ...over,
  };
  appendJsonLine(changesFile(dir), rec, autonomyDir(dir));
  return rec;
}

describe('write-ahead: persistence failures', () => {
  it('a change whose finish cannot be recorded is reported live (never undone), and the next tick records it applied', async () => {
    // Replaces round 1's compensation test: the new values are never written back over.
    const { ledger, mem, log } = makeLedger({ 'watcher.notice.salienceBar': 0.4 });
    const broken = failNextRecordAfterWrite(mem.access);
    const r = await ledger.apply(proposal());
    broken.restore();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.live).toBe(true);
      expect(r.error).not.toContain('not applied');
    }
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.6);
    expect(readChanges(dir).map((c) => c.status)).toEqual(['applying']);
    await ledger.recover();
    expect(readChanges(dir).map((c) => c.status)).toEqual(['applied']);
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.6);
    expect(log.ops()).toContain('autonomy:applied');
  });

  it('when the intent cannot be recorded, nothing is written and it is an honest error', async () => {
    const { ledger, mem } = makeLedger({ 'watcher.notice.salienceBar': 0.4 });
    mkdirSync(autonomyDir(dir), { recursive: true });
    const restore = breakFile(changesFile(dir));
    const r = await ledger.apply(proposal());
    restore();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.live).toBeUndefined();
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.4);
    expect(readChanges(dir)).toEqual([]);
  });

  it('a revert whose finish cannot be recorded is 500 with the old values live, and the next tick records it reverted', async () => {
    // Replaces round 1's test that expected the change to be put back (applied, 0.6).
    const { ledger, mem, log } = makeLedger({ 'watcher.notice.salienceBar': 0.4 });
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    const broken = failNextRecordAfterWrite(mem.access);
    const back = await ledger.revert(r.change.id, { actor: 'operator' });
    broken.restore();
    expect(back).toMatchObject({ ok: false, status: 500 });
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.4);
    expect(ledger.get(r.change.id)?.status).toBe('reverting');
    expect(ledger.get(r.change.id)?.cause).toBe('operator');
    await ledger.recover();
    expect(ledger.get(r.change.id)?.status).toBe('reverted');
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.4);
    expect(log.ops()).toContain('autonomy:reverted');
  });

  it('a rollback at 48.5 h whose finish cannot be recorded is completed by a later tick, after guardUntil', async () => {
    // Review round 2 (ledger.ts:326): the old code put the breached change back
    // and never retried once the 49 h window was over.
    const { ledger, mem, log, applied } = makeLedger(
      { 'watcher.notice.salienceBar': 0.4 },
      () => 10
    );
    const r = await ledger.apply(
      proposal({
        guard: { metric: 'watcher.costUsdPerDay', direction: 'max', bound: 3, windowHours: 49 },
      })
    );
    if (!r.ok) throw new Error('setup');
    const broken = failNextRecordAfterWrite(mem.access);
    const rolled = await ledger.checkGuards(t + 48.5 * HOUR);
    broken.restore();
    expect(rolled).toEqual([]);
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.4);
    const mid = ledger.get(r.change.id);
    expect(mid?.status).toBe('reverting');
    expect(mid?.cause).toBe('guard');
    expect(mid?.guardReading).toBe(10);
    t += 49.5 * HOUR;
    expect(t).toBeGreaterThan(Date.parse(r.change.guardUntil));
    await ledger.recover();
    await ledger.checkGuards(t);
    const end = ledger.get(r.change.id);
    expect(end?.status).toBe('rolled-back');
    expect(end?.endReason).toContain('10');
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.4);
    expect(log.ops()).toContain('autonomy:rolled-back');
    expect(applied).toContain(`rolled-back:${r.change.id}`);
  });

  for (const via of ['revert', 'rollback'] as const) {
    it(`an async ${via} write, an intervening edit and a failed finish record: the edit is never clobbered, the change needs the operator`, async () => {
      // Review round 2 (ledger.ts:346): the old compensation wrote 6h over the 8h edit.
      const values = new Map<string, unknown>([['bots.b1.agentLoop.every', '2h']]);
      let gate: Promise<void> | undefined;
      let open: () => void = () => {};
      const access: ValueAccess = {
        read: (p) => values.get(p),
        write: async (vs) => {
          for (const v of vs) values.set(v.path, v.value);
          if (gate) await gate;
        },
      };
      const log = rowLog();
      const ledger = new ChangeLedger({
        watcherDir: dir,
        access,
        log,
        now: () => t,
        guards: () => 0.9,
      });
      const r = await ledger.apply(
        proposal({
          kind: 'fleet-cadence',
          changes: [{ path: 'bots.b1.agentLoop.every', from: '2h', to: '6h' }],
          guard: { metric: 'fleet.errorCycleShare', direction: 'max', bound: 0.2, windowHours: 24 },
        })
      );
      if (!r.ok) throw new Error(r.error);
      gate = new Promise((resolve) => {
        open = resolve;
      });
      const pending =
        via === 'revert'
          ? ledger.revert(r.change.id, { actor: 'operator' })
          : ledger.checkGuards(t + HOUR);
      await Bun.sleep(5);
      expect(values.get('bots.b1.agentLoop.every')).toBe('2h');
      values.set('bots.b1.agentLoop.every', '8h'); // someone else edits it meanwhile
      const restore = breakFile(changesFile(dir));
      open();
      const out = await pending;
      restore();
      if (via === 'revert') expect(out).toMatchObject({ ok: false, status: 500 });
      else expect(out).toEqual([]);
      expect(values.get('bots.b1.agentLoop.every')).toBe('8h');
      gate = undefined;
      await ledger.recover();
      expect(values.get('bots.b1.agentLoop.every')).toBe('8h');
      const c = ledger.get(r.change.id);
      expect(c?.status).toBe('revert-failed');
      expect(c?.found).toEqual([{ path: 'bots.b1.agentLoop.every', value: '8h' }]);
      expect(log.ops()).toContain('autonomy:needs-operator');
    });
  }

  it('no code path writes config values without an intent record for exactly those values', async () => {
    const values = new Map<string, unknown>([['watcher.notice.salienceBar', 0.4]]);
    const writes: string[] = [];
    const access: ValueAccess = {
      read: (p) => values.get(p),
      write: async (vs) => {
        const last = readChanges(dir).at(-1);
        const want =
          last?.status === 'applying'
            ? last.after
            : last?.status === 'reverting'
              ? last.before
              : [];
        expect(vs.map((v) => [v.path, v.value])).toEqual(want.map((w) => [w.path, w.value]));
        writes.push(last?.status ?? 'none');
        for (const v of vs) values.set(v.path, v.value);
      },
    };
    let reading = 0;
    const ledger = new ChangeLedger({
      watcherDir: dir,
      access,
      now: () => t,
      guards: () => reading,
    });
    const a = await ledger.apply(proposal());
    if (!a.ok) throw new Error(a.error);
    await ledger.revert(a.change.id, { actor: 'operator' });
    const b = await ledger.apply({ ...proposal(), id: 'p-abcdef02' });
    if (!b.ok) throw new Error(b.error);
    reading = 10;
    await ledger.checkGuards(t + HOUR);
    // A reverting intent left with the after-values live: recovery writes, after its intent.
    values.set('watcher.notice.salienceBar', 0.6);
    putRecord({ id: 'c-0000000f', status: 'reverting', cause: 'operator' });
    await ledger.recover();
    expect(writes).toEqual(['applying', 'reverting', 'applying', 'reverting', 'reverting']);
    expect(values.get('watcher.notice.salienceBar')).toBe(0.4);
  });

  it('a write that fails after its intent is apply-failed when nothing is live', async () => {
    // Replaces "a write failure is an error and records nothing": the intent is kept, settled.
    const { ledger, mem, log } = makeLedger({ 'watcher.notice.salienceBar': 0.4 });
    mem.failWrites(true);
    const r = await ledger.apply(proposal());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.live).toBeUndefined();
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.4);
    expect(readChanges(dir).map((c) => c.status)).toEqual(['apply-failed']);
    expect(log.ops()).toContain('autonomy:apply-failed');
  });
});

describe('write-ahead: recovery of intermediate records', () => {
  const cases: Array<{
    name: string;
    rec: Partial<ChangeRecord> & Pick<ChangeRecord, 'status'>;
    live: unknown;
    status: string;
    after: unknown;
    op: string;
  }> = [
    {
      name: 'applying with the after-values live → applied',
      rec: { status: 'applying' },
      live: 0.6,
      status: 'applied',
      after: 0.6,
      op: 'autonomy:applied',
    },
    {
      name: 'applying with the before-values live → apply-failed',
      rec: { status: 'applying' },
      live: 0.4,
      status: 'apply-failed',
      after: 0.4,
      op: 'autonomy:apply-failed',
    },
    {
      name: 'applying with something else live → needs the operator, nothing written',
      rec: { status: 'applying' },
      live: 0.9,
      status: 'revert-failed',
      after: 0.9,
      op: 'autonomy:needs-operator',
    },
    {
      name: 'reverting (operator) with the before-values live → reverted',
      rec: { status: 'reverting', cause: 'operator' },
      live: 0.4,
      status: 'reverted',
      after: 0.4,
      op: 'autonomy:reverted',
    },
    {
      name: 'reverting (guard) with the after-values live → before written, rolled-back',
      rec: { status: 'reverting', cause: 'guard', guardReading: 9, endReason: 'cost read 9' },
      live: 0.6,
      status: 'rolled-back',
      after: 0.4,
      op: 'autonomy:rolled-back',
    },
    {
      name: 'reverting with something else live → needs the operator, nothing written',
      rec: { status: 'reverting', cause: 'guard' },
      live: 0.9,
      status: 'revert-failed',
      after: 0.9,
      op: 'autonomy:needs-operator',
    },
  ];
  for (const c of cases) {
    it(`at construction: ${c.name}`, async () => {
      putRecord(c.rec);
      const { ledger, mem, log } = makeLedger({ 'watcher.notice.salienceBar': c.live });
      await ledger.recover();
      const rec = ledger.get('c-12345678');
      expect(rec?.status).toBe(c.status as never);
      expect(mem.values.get('watcher.notice.salienceBar')).toBe(c.after);
      expect(log.ops()).toContain(c.op);
      if (c.status === 'revert-failed') {
        expect(rec?.found).toEqual([{ path: 'watcher.notice.salienceBar', value: 0.9 }]);
        expect(rec?.before).toEqual([{ path: 'watcher.notice.salienceBar', value: 0.4 }]);
        expect(rec?.after).toEqual([{ path: 'watcher.notice.salienceBar', value: 0.6 }]);
      }
      // settled once: a second pass changes nothing
      const rows = log.ops().length;
      await ledger.recover();
      expect(log.ops().length).toBe(rows);
    });
  }
});

describe('review round 3: ledger', () => {
  it('a rollback whose write failed is retried at a later tick while it still breaches, past its window too', async () => {
    const { ledger, mem, applied } = makeLedger({ 'watcher.notice.salienceBar': 0.4 }, () => 10);
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    mem.failWrites(true);
    await ledger.checkGuards(t + HOUR);
    expect(ledger.get(r.change.id)?.status).toBe('revert-failed');
    // still failing: still revert-failed, still the new value, retried again later
    await ledger.checkGuards(t + 2 * HOUR);
    expect(ledger.get(r.change.id)?.status).toBe('revert-failed');
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.6);
    mem.failWrites(false);
    const rolled = await ledger.checkGuards(t + 80 * HOUR); // past the 72 h window
    expect(rolled.map((c) => c.id)).toEqual([r.change.id]);
    const c = ledger.get(r.change.id);
    expect(c?.status).toBe('rolled-back');
    expect(c?.found).toBeUndefined();
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.4);
    expect(applied).toContain(`rolled-back:${r.change.id}`);
  });

  it('a failed rollback is not retried once its guard stops breaching, nor over a hand edit', async () => {
    const g = { reading: 10 };
    const { ledger, mem } = makeLedger({ 'watcher.notice.salienceBar': 0.4 }, () => g.reading);
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    mem.failWrites(true);
    await ledger.checkGuards(t + HOUR);
    mem.failWrites(false);
    g.reading = 1;
    await ledger.checkGuards(t + 2 * HOUR);
    expect(ledger.get(r.change.id)?.status).toBe('revert-failed');
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.6);
    // a hand edit: never written over
    g.reading = 10;
    mem.values.set('watcher.notice.salienceBar', 1.2);
    await ledger.checkGuards(t + 3 * HOUR);
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(1.2);
    expect(ledger.get(r.change.id)?.status).toBe('revert-failed');
  });

  it('an operator revert whose write failed is for the operator to retry, never the guard', async () => {
    const { ledger, mem } = makeLedger({ 'watcher.notice.salienceBar': 0.4 }, () => 10);
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    mem.failWrites(true);
    expect((await ledger.revert(r.change.id, { actor: 'operator' })).ok).toBe(false);
    mem.failWrites(false);
    await ledger.checkGuards(t + HOUR);
    expect(ledger.get(r.change.id)?.status).toBe('revert-failed');
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(0.6);
  });

  it('the operator accepts the live values of a change that is neither old nor new: terminal, with what was live', async () => {
    const { ledger, mem, log, applied } = makeLedger(
      { 'watcher.notice.salienceBar': 0.4 },
      () => 10
    );
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    mem.values.set('watcher.notice.salienceBar', 1.2);
    await ledger.checkGuards(t + HOUR);
    expect(ledger.get(r.change.id)?.status).toBe('revert-failed');
    expect((await ledger.revert(r.change.id, { actor: 'operator' })).ok).toBe(false);
    expect(await ledger.accept(r.change.id, { actor: 'watcher' as never })).toMatchObject({
      ok: false,
      status: 403,
    });
    mem.values.set('watcher.notice.salienceBar', 1.3); // what is live at the click counts
    t += 2 * HOUR;
    const ok = await ledger.accept(r.change.id, { actor: 'operator' });
    expect(ok.ok).toBe(true);
    const c = ledger.get(r.change.id);
    expect(c?.status).toBe('accepted');
    expect(c?.found).toEqual([{ path: 'watcher.notice.salienceBar', value: 1.3 }]);
    expect(c?.endedAt).toBe(new Date(t).toISOString());
    expect(c?.endReason).toContain('1.3');
    expect(c?.before).toEqual([{ path: 'watcher.notice.salienceBar', value: 0.4 }]);
    expect(mem.values.get('watcher.notice.salienceBar')).toBe(1.3);
    expect(log.ops()).toContain('autonomy:accepted');
    expect(applied).toEqual([`applied:${r.change.id}`]);
    // terminal: no second accept, no revert, never retried
    expect(await ledger.accept(r.change.id, { actor: 'operator' })).toMatchObject({
      ok: false,
      status: 409,
    });
    await ledger.checkGuards(t + HOUR);
    expect(ledger.get(r.change.id)?.status).toBe('accepted');
    expect(await ledger.accept('c-00000000', { actor: 'operator' })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('accept is refused while the new values are live (Revert is the action) and for a change that does not need the operator', async () => {
    const { ledger, mem } = makeLedger({ 'watcher.notice.salienceBar': 0.4 }, () => 10);
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    const applied = await ledger.accept(r.change.id, { actor: 'operator' });
    expect(applied).toMatchObject({ ok: false, status: 409 });
    mem.failWrites(true);
    await ledger.checkGuards(t + HOUR);
    expect(ledger.get(r.change.id)?.status).toBe('revert-failed');
    const afterLive = await ledger.accept(r.change.id, { actor: 'operator' });
    expect(afterLive).toMatchObject({ ok: false, status: 409 });
    if (!afterLive.ok) expect(afterLive.error).toContain('revert');
    expect(ledger.get(r.change.id)?.status).toBe('revert-failed');
  });

  it('apply keeps the proposal title on the change record', async () => {
    const { ledger } = makeLedger({ 'watcher.notice.salienceBar': 0.4 });
    const r = await ledger.apply(proposal());
    if (!r.ok) throw new Error('setup');
    expect(ledger.get(r.change.id)?.title).toBe(proposalInput().title);
  });
});
