import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatcherLog } from '../../src/watcher/log';
import { graphFiles, watcherDir, watcherLogDir } from '../../src/watcher/paths';
import type { WatcherLogRow } from '../../src/watcher/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-log-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function clock(start: string) {
  let t = Date.parse(start);
  return {
    now: () => t,
    set: (iso: string) => {
      t = Date.parse(iso);
    },
  };
}

describe('watcher paths', () => {
  test('watcherDir lives under paths.data', () => {
    expect(watcherDir({ paths: { data: '/d' } } as never)).toBe(join('/d', 'watcher'));
  });
  test('watcherDir falls back to ./data', () => {
    expect(watcherDir({} as never)).toBe(join('./data', 'watcher'));
  });
  test('watcherLogDir and graphFiles sit inside the watcher dir', () => {
    expect(watcherLogDir('/w')).toBe(join('/w', 'log'));
    const g = graphFiles('/w');
    expect(g.neurons).toBe(join('/w', 'neurons.jsonl'));
    expect(g.edges).toBe(join('/w', 'edges.jsonl'));
    expect(g.embeddings).toBe(join('/w', 'embeddings.jsonl'));
    expect(g.graph).toBe(join('/w', 'graph.json'));
  });
});

describe('WatcherLog', () => {
  test('append then read returns the row, newest first', () => {
    const c = clock('2026-10-23T10:00:00Z');
    const log = new WatcherLog(dir, { now: c.now });
    log.say('birth', 'wake', 'Waking up.');
    c.set('2026-10-23T10:00:01Z');
    log.say('birth', 'fleet', 'Met jarvis.', { neuronIds: ['n-1'] });
    const rows = log.read('2026-10-23');
    expect(rows.map((r) => r.op)).toEqual(['fleet', 'wake']);
    expect(rows[0].neuronIds).toEqual(['n-1']);
    expect(rows[0].ts).toBe('2026-10-23T10:00:01.000Z');
  });

  test('rows split by UTC date', () => {
    const c = clock('2026-10-22T23:59:59Z');
    const log = new WatcherLog(dir, { now: c.now });
    log.say('sense', 'summary', 'a');
    c.set('2026-10-23T00:00:01Z');
    log.say('sense', 'summary', 'b');
    expect(log.read('2026-10-22').map((r) => r.text)).toEqual(['a']);
    expect(log.read('2026-10-23').map((r) => r.text)).toEqual(['b']);
    expect(log.dates()).toEqual(['2026-10-22', '2026-10-23']);
  });

  test('a missing dir reads []', () => {
    const log = new WatcherLog(join(dir, 'nope'));
    expect(log.read('2026-10-23')).toEqual([]);
    expect(log.dates()).toEqual([]);
    expect(log.recent(10)).toEqual([]);
  });

  test('a bad line is skipped', () => {
    mkdirSync(dir, { recursive: true });
    const good: WatcherLogRow = {
      ts: '2026-10-23T10:00:00.000Z',
      seq: 1,
      phase: 'birth',
      op: 'wake',
      text: 'x',
    };
    writeFileSync(join(dir, '2026-10-23.jsonl'), `${JSON.stringify(good)}\n{not json\n`);
    expect(new WatcherLog(dir).read('2026-10-23')).toEqual([good]);
  });

  test('seq is monotonic across a restart', () => {
    const c = clock('2026-10-22T10:00:00Z');
    const first = new WatcherLog(dir, { now: c.now });
    first.say('birth', 'wake', 'a');
    first.say('birth', 'fleet', 'b');
    c.set('2026-10-23T10:00:00Z');
    const second = new WatcherLog(dir, { now: c.now });
    const row = second.say('sleep', 'wake', 'c');
    expect(row.seq).toBe(3);
  });

  test('read pages with limit and before', () => {
    const c = clock('2026-10-23T10:00:00Z');
    const log = new WatcherLog(dir, { now: c.now });
    for (let i = 0; i < 5; i++) log.say('sense', 'summary', `r${i}`);
    expect(log.read('2026-10-23', { limit: 2 }).map((r) => r.text)).toEqual(['r4', 'r3']);
    expect(log.read('2026-10-23', { limit: 2, before: 3 }).map((r) => r.text)).toEqual([
      'r1',
      'r0',
    ]);
  });

  test('recent reads across dates, newest first', () => {
    const c = clock('2026-10-22T10:00:00Z');
    const log = new WatcherLog(dir, { now: c.now });
    log.say('sense', 'summary', 'old');
    c.set('2026-10-23T10:00:00Z');
    log.say('sense', 'summary', 'new');
    expect(log.recent(10).map((r) => r.text)).toEqual(['new', 'old']);
    expect(log.recent(1).map((r) => r.text)).toEqual(['new']);
    expect(log.recent(10, 2).map((r) => r.text)).toEqual(['old']);
  });

  test('every row goes to the logger and to onRow', () => {
    const infos: unknown[][] = [];
    const seen: WatcherLogRow[] = [];
    const log = new WatcherLog(dir, {
      logger: { info: (...a: unknown[]) => infos.push(a), warn: () => {} },
      onRow: (r) => seen.push(r),
    });
    const row = log.say('birth', 'wake', 'Waking up.');
    expect(seen).toEqual([row]);
    expect(infos[0][1]).toBe('Waking up.');
    expect((infos[0][0] as { watcher: string }).watcher).toBe('wake');
  });

  test('a failing write never throws', () => {
    writeFileSync(join(dir, 'file'), 'x');
    const log = new WatcherLog(join(dir, 'file', 'sub'), {
      logger: { info: () => {}, warn: () => {} },
    });
    expect(() => log.say('birth', 'wake', 'x')).not.toThrow();
  });

  test('lastRow is the newest row on disk', () => {
    const log = new WatcherLog(dir);
    expect(log.lastRow()).toBeUndefined();
    log.say('birth', 'wake', 'a');
    log.say('sleep', 'sleep', 'b');
    expect(new WatcherLog(dir).lastRow()?.text).toBe('b');
  });
});
