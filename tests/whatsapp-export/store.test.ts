import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WaMessage } from '../../src/whatsapp-export/parser';
import {
  RETENTION_DAYS,
  WhatsAppExportStore,
  localTsToMs,
  startWhatsAppExportSweep,
} from '../../src/whatsapp-export/store';

const BOT = 'finny-test';
const NOW = localTsToMs('2026-10-16T12:00:00');
const msg = (ts: string, author: string, text: string): WaMessage => ({ ts, author, text });

describe('WhatsAppExportStore', () => {
  let dir: string;
  let store: WhatsAppExportStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-store-'));
    store = new WhatsAppExportStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('first export: every message within retention is new', () => {
    const r = store.ingest(
      BOT,
      '3B Padres',
      [
        msg('2026-08-01T10:00:00', 'Laura', 'viejo, fuera de retención'),
        msg('2026-10-15T10:00:00', 'Laura', 'hola'),
        msg('2026-10-16T08:22:00', 'Pablo', 'llevar $500'),
      ],
      { nowMs: NOW, fileName: 'WhatsApp Chat with 3B Padres.txt' }
    );
    expect(r.firstExport).toBe(true);
    expect(r.newCount).toBe(2);
    expect(r.droppedOld).toBe(1);
    expect(r.slug).toBe('3b-padres');
    expect(store.newMessages(BOT, r.slug, NOW).map((m) => m.text)).toEqual(['hola', 'llevar $500']);
    // The file lives where the plan says: <dir>/<botId>/<slug>.json
    expect(existsSync(join(dir, BOT, '3b-padres.json'))).toBe(true);
  });

  test('second export of the same group: only messages after the previous one', () => {
    const first = [
      msg('2026-10-14T09:00:00', 'Laura', 'uno'),
      msg('2026-10-15T09:00:00', 'Pablo', 'ok'),
    ];
    store.ingest(BOT, '3B Padres', first, { nowMs: NOW, fileName: 'a.txt' });
    const r = store.ingest(
      BOT,
      '3B Padres',
      [
        ...first,
        // Same minute, same author, same text as a stored one: a second "ok" is still new.
        msg('2026-10-15T09:00:00', 'Pablo', 'ok'),
        msg('2026-10-16T08:00:00', 'Marta', 'reunión lunes'),
      ],
      { nowMs: NOW + 1000, fileName: 'b.txt' }
    );
    expect(r.firstExport).toBe(false);
    expect(r.newCount).toBe(2);
    expect(r.previousLastMessageAt).toBe('2026-10-15T09:00:00');
    expect(store.newMessages(BOT, '3b-padres', NOW + 1000).map((m) => m.text)).toEqual([
      'ok',
      'reunión lunes',
    ]);
  });

  test('re-sending the same export yields nothing new', () => {
    const msgs = [msg('2026-10-15T09:00:00', 'Pablo', 'ok')];
    store.ingest(BOT, 'G', msgs, { nowMs: NOW, fileName: 'a.txt' });
    const r = store.ingest(BOT, 'G', msgs, { nowMs: NOW + 1, fileName: 'a.txt' });
    expect(r.newCount).toBe(0);
    expect(store.newMessages(BOT, 'g', NOW + 1)).toEqual([]);
  });

  test('an older-than-cursor message missing from the store is not treated as new', () => {
    store.ingest(BOT, 'G', [msg('2026-10-15T09:00:00', 'A', 'x')], { nowMs: NOW, fileName: 'a' });
    const r = store.ingest(BOT, 'G', [msg('2026-10-10T09:00:00', 'A', 'old')], {
      nowMs: NOW + 1,
      fileName: 'b',
    });
    expect(r.newCount).toBe(0);
  });

  test(`retention: messages older than ${RETENTION_DAYS} days are dropped from disk on read`, () => {
    store.ingest(BOT, 'G', [msg('2026-10-15T09:00:00', 'A', 'x')], { nowMs: NOW, fileName: 'a' });
    const later = NOW + (RETENTION_DAYS + 1) * 24 * 3600_000;
    expect(store.newMessages(BOT, 'g', later)).toEqual([]);
    const onDisk = JSON.parse(readFileSync(join(dir, BOT, 'g.json'), 'utf-8'));
    expect(onDisk.messages).toEqual([]);
    // The cursor survives: a later export still starts after it.
    expect(onDisk.lastMessageAt).toBe('2026-10-15T09:00:00');
  });

  test('ingest also prunes the other groups of the bot', () => {
    store.ingest(BOT, 'G1', [msg('2026-10-15T09:00:00', 'A', 'x')], { nowMs: NOW, fileName: 'a' });
    const later = NOW + (RETENTION_DAYS + 1) * 24 * 3600_000;
    store.ingest(BOT, 'G2', [], { nowMs: later, fileName: 'b' });
    const g1 = JSON.parse(readFileSync(join(dir, BOT, 'g1.json'), 'utf-8'));
    expect(g1.messages).toEqual([]);
  });

  test('find: by slug, by part of the name, or the latest export when no group is given', () => {
    store.ingest(BOT, '3B Padres', [msg('2026-10-15T09:00:00', 'A', 'x')], {
      nowMs: NOW,
      fileName: 'a',
    });
    store.ingest(BOT, 'Fútbol Sábados', [msg('2026-10-15T09:00:00', 'A', 'y')], {
      nowMs: NOW + 5,
      fileName: 'b',
    });
    expect(store.find(BOT, undefined, NOW)?.group).toBe('Fútbol Sábados');
    expect(store.find(BOT, '3b-padres', NOW)?.group).toBe('3B Padres');
    expect(store.find(BOT, 'padres', NOW)?.group).toBe('3B Padres');
    expect(store.find(BOT, 'futbol', NOW)?.group).toBe('Fútbol Sábados');
    expect(store.find(BOT, 'nope', NOW)).toBeUndefined();
    expect(
      store
        .list(BOT)
        .map((g) => g.group)
        .sort()
    ).toEqual(['3B Padres', 'Fútbol Sábados']);
    expect(store.find('other-bot', undefined, NOW)).toBeUndefined();
  });

  test('long messages are clipped before they are stored', () => {
    store.ingest(BOT, 'G', [msg('2026-10-15T09:00:00', 'A', 'z'.repeat(10_000))], {
      nowMs: NOW,
      fileName: 'a',
    });
    expect(store.newMessages(BOT, 'g', NOW)[0].text.length).toBeLessThan(2100);
  });
  // Mode bits are POSIX-only; on Windows the ACLs decide and stat reports 0o666.
  test.skipIf(process.platform === 'win32')('group files are written owner-only (0o600)', () => {
    store.ingest(BOT, 'G', [msg('2026-10-15T09:00:00', 'A', 'hola')], {
      nowMs: NOW,
      fileName: 'a',
    });
    expect(statSync(join(dir, BOT, 'g.json')).mode & 0o777).toBe(0o600);
  });

  test('pruneAll drops expired messages of every group of every bot, cursor kept', () => {
    const t0 = localTsToMs('2026-10-01T12:00:00');
    store.ingest(BOT, 'G1', [msg('2026-09-30T09:00:00', 'A', 'old')], { nowMs: t0, fileName: 'a' });
    store.ingest('other-bot', 'G2', [msg('2026-10-01T09:00:00', 'B', 'old too')], {
      nowMs: t0,
      fileName: 'b',
    });
    store.ingest(BOT, 'G3', [msg('2026-10-15T09:00:00', 'C', 'fresh')], {
      nowMs: NOW,
      fileName: 'c',
    });
    const later = NOW + 20 * 86_400_000;
    const r = store.pruneAll(later);
    expect(r).toEqual({ groups: 3, dropped: 2 });
    const raw = JSON.parse(readFileSync(join(dir, BOT, 'g1.json'), 'utf-8'));
    expect(raw.messages).toEqual([]);
    expect(raw.lastMessageAt).toBe('2026-09-30T09:00:00');
    expect(JSON.parse(readFileSync(join(dir, BOT, 'g3.json'), 'utf-8')).messages).toHaveLength(1);
  });

  test('pruneAll on an empty or missing dir is a no-op', () => {
    expect(new WhatsAppExportStore(join(dir, 'nope')).pruneAll(NOW)).toEqual({
      groups: 0,
      dropped: 0,
    });
  });
});

describe('startWhatsAppExportSweep', () => {
  test('prunes after the start delay and then on every interval; timers are unref-able and stoppable', () => {
    const scheduled: Array<{ kind: string; fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const timers = {
      setTimeout: (fn: () => void, ms: number) => {
        const h = { kind: 'timeout', fn, ms, unref: () => {} };
        scheduled.push(h);
        return h;
      },
      setInterval: (fn: () => void, ms: number) => {
        const h = { kind: 'interval', fn, ms, unref: () => {} };
        scheduled.push(h);
        return h;
      },
      clear: (h: unknown) => cleared.push(h),
    };
    const calls: number[] = [];
    const fakeStore = {
      pruneAll: (nowMs: number) => {
        calls.push(nowMs);
        return { groups: 1, dropped: 0 };
      },
    };
    const quiet = { info() {}, warn() {}, debug() {}, error() {} } as never;
    const sweep = startWhatsAppExportSweep({
      store: fakeStore,
      logger: quiet,
      timers,
      now: () => 42,
      startDelayMs: 5,
      intervalMs: 1000,
    });
    expect(scheduled[0]).toMatchObject({ kind: 'timeout', ms: 5 });
    scheduled[0].fn();
    expect(calls).toEqual([42]);
    expect(scheduled[1]).toMatchObject({ kind: 'interval', ms: 1000 });
    scheduled[1].fn();
    expect(calls).toEqual([42, 42]);
    sweep.stop();
    expect(cleared).toHaveLength(2);
  });

  test('a prune that throws is logged, never escapes', () => {
    let fire: () => void = () => {};
    const timers = {
      setTimeout: (fn: () => void) => {
        fire = fn;
        return {};
      },
      setInterval: () => ({}),
      clear: () => {},
    };
    const warned: unknown[] = [];
    startWhatsAppExportSweep({
      store: {
        pruneAll: () => {
          throw new Error('disk gone');
        },
      },
      logger: {
        info() {},
        warn: (...a: unknown[]) => warned.push(a),
        debug() {},
        error() {},
      } as never,
      timers,
    });
    expect(() => fire()).not.toThrow();
    expect(warned).toHaveLength(1);
  });
});

describe('WhatsAppExportStore: group names that share a slug', () => {
  let dir: string;
  let store: WhatsAppExportStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-store-'));
    store = new WhatsAppExportStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('"Class 1/A" and "Class 1-A" keep separate records and never suppress each other', () => {
    store.ingest(BOT, 'Class 1/A', [msg('2026-10-16T08:00:00', 'A', 'one')], {
      nowMs: NOW,
      fileName: 'a',
    });
    const r = store.ingest(BOT, 'Class 1-A', [msg('2026-10-15T08:00:00', 'B', 'two')], {
      nowMs: NOW + 1,
      fileName: 'b',
    });
    expect(r.newCount).toBe(1);
    expect(store.list(BOT)).toHaveLength(2);
    expect(store.find(BOT, 'Class 1/A', NOW + 2)?.messages.map((m) => m.text)).toEqual(['one']);
    expect(store.find(BOT, 'Class 1-A', NOW + 2)?.messages.map((m) => m.text)).toEqual(['two']);
  });
});
