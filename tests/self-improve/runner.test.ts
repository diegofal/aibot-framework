import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSelfImprove } from '../../src/bot/self-improve/runner';
import type { SelfImproveDeps } from '../../src/bot/self-improve/runner';
import { LessonStore } from '../../src/bot/self-improve/store';
import type { Lesson, ResolvedSelfImprove } from '../../src/bot/self-improve/types';
import { readSoulEvents } from '../../src/bot/soul-events';
import type { ToolAuditEntry } from '../../src/bot/tool-audit-log';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-27T12:00:00.000Z');

const CFG: ResolvedSelfImprove = {
  enabled: true,
  minRepeats: 3,
  maxActive: 5,
  measureCalls: 20,
  measureDays: 5,
  minDrop: 0.5,
};

const NOT_FOUND = 'File not found: /app/productions/jarvis-factory/longlist.md';
const NOTE_LONG = 'Error: note is longer than 600 characters (812). Shorten it.';

function row(ms: number, over: Partial<ToolAuditEntry> = {}): ToolAuditEntry {
  return {
    timestamp: new Date(ms).toISOString(),
    botId: 'jarvis-factory',
    chatId: 0,
    toolName: 'file_read',
    args: { path: 'longlist.md' },
    success: false,
    result: NOT_FOUND,
    durationMs: 12,
    retryAttempts: 0,
    cycleId: 'c-old',
    ...over,
  };
}
const ok = (ms: number, over: Partial<ToolAuditEntry> = {}) =>
  row(ms, {
    success: true,
    result: '# Longlist\n- Acme',
    args: { path: '01_longlist.md' },
    ...over,
  });
const noteLong = (ms: number) =>
  row(ms, {
    toolName: 'manage_goals',
    args: { action: 'update', note: 'x'.repeat(812) },
    result: NOTE_LONG,
  });

/** `n` failing file_read calls one hour apart, ending one hour before NOW. */
function notFound(n: number, endMs = NOW - HOUR): ToolAuditEntry[] {
  return Array.from({ length: n }, (_, i) => row(endMs - i * HOUR));
}

/** A model answer citing the first ref the digest showed. */
const goodGenerate = mock(async (_system: string, prompt: string) => {
  const ref = /ref: (.+)/.exec(prompt)?.[1]?.trim();
  return JSON.stringify({
    lesson: 'List productions with read_production_log and read the exact numbered path.',
    evidence: [ref],
  });
});

let soulDir: string;
let warn: ReturnType<typeof mock>;
beforeEach(() => {
  soulDir = mkdtempSync(join(tmpdir(), 'aibot-self-improve-runner-'));
  warn = mock(() => {});
  goodGenerate.mockClear();
});
afterEach(() => rmSync(soulDir, { recursive: true, force: true }));

function deps(entries: ToolAuditEntry[], over: Partial<SelfImproveDeps> = {}) {
  const readAudit = mock((_since: number, _now: number) => entries);
  const d: SelfImproveDeps = {
    store: new LessonStore(soulDir),
    readAudit,
    generate: goodGenerate,
    nowMs: () => NOW,
    logger: { warn } as unknown as SelfImproveDeps['logger'],
    soulDir,
    ...over,
  };
  return { d, readAudit };
}

function lesson(over: Partial<Lesson> = {}): Lesson {
  const created = new Date(NOW - 6 * DAY).toISOString();
  return {
    id: 'l-aaaaaaaa',
    classKey: 'file_read:file-not-found',
    tool: 'file_read',
    errorClass: 'file-not-found',
    text: 'Read the exact path.',
    textSource: 'model',
    evidence: [],
    source: 'own',
    status: 'active',
    createdAt: created,
    updatedAt: created,
    baseline: { failures: 5, calls: 10, rate: 0.5, sinceMs: 0, untilMs: 0 },
    ...over,
  };
}

const run = (d: SelfImproveDeps, cfg: Partial<ResolvedSelfImprove> = {}) =>
  runSelfImprove(d, { botId: 'jarvis-factory', cfg: { ...CFG, ...cfg }, cycleId: 'c-now' });

describe('runSelfImprove', () => {
  test('disabled: reads nothing and writes nothing', async () => {
    const { d, readAudit } = deps(notFound(5));
    const res = await run(d, { enabled: false });
    expect(res).toEqual({ ok: true, skipped: 'disabled' });
    expect(readAudit).not.toHaveBeenCalled();
    expect(goodGenerate).not.toHaveBeenCalled();
    expect(existsSync(join(soulDir, 'LESSONS.json'))).toBe(false);
    expect(readSoulEvents(soulDir)).toEqual([]);
  });

  test('a class with 3 failures becomes one lesson with its baseline and a soul event', async () => {
    const entries = [...notFound(3), ok(NOW - 30 * 60_000), ok(NOW - 2 * DAY)];
    const { d, readAudit } = deps(entries);
    const res = await run(d);

    expect(readAudit).toHaveBeenCalledTimes(1);
    const [since, now] = readAudit.mock.calls[0];
    expect(now).toBe(NOW);
    expect(since).toBeLessThanOrEqual(NOW - 7 * DAY - 5 * DAY);

    const file = new LessonStore(soulDir).read();
    expect(file.lessons).toHaveLength(1);
    const l = file.lessons[0];
    expect(res).toEqual({ ok: true, evaluated: 0, changed: [], created: l.id });
    expect(l.id).toMatch(/^l-[0-9a-f]{8}$/);
    expect(l).toMatchObject({
      classKey: 'file_read:file-not-found',
      tool: 'file_read',
      errorClass: 'file-not-found',
      textSource: 'model',
      source: 'own',
      status: 'active',
      cycleId: 'c-now',
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    expect(l.text).toContain('read_production_log');
    expect(l.evidence).toHaveLength(1);
    expect(l.baseline).toMatchObject({ failures: 3, calls: 5, rate: 3 / 5, untilMs: NOW });

    const events = readSoulEvents(soulDir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: 'lesson',
      actor: 'agent',
      file: 'LESSONS.json',
      cycleId: 'c-now',
    });
    expect(events[0].summary).toStartWith('New lesson: List productions');
  });

  test('two classes: one lesson per run, the most repeated first', async () => {
    const entries = [...notFound(4), noteLong(NOW - 2 * HOUR), noteLong(NOW - 3 * HOUR)];
    entries.push(noteLong(NOW - 4 * HOUR));
    const { d } = deps(entries, {
      newId: (() => {
        let n = 0;
        return () => `l-0000000${++n}`;
      })(),
    });

    const first = await run(d);
    expect(first.created).toBe('l-00000001');
    let lessons = new LessonStore(soulDir).read().lessons;
    expect(lessons.map((l) => l.classKey)).toEqual(['file_read:file-not-found']);

    const second = await run(d);
    expect(second.created).toBe('l-00000002');
    lessons = new LessonStore(soulDir).read().lessons;
    expect(lessons.map((l) => l.classKey).sort()).toEqual([
      'file_read:file-not-found',
      'manage_goals:note-too-long',
    ]);

    const third = await run(d);
    expect(third.created).toBeUndefined();
  });

  test('maxActive reached: no new lesson', async () => {
    new LessonStore(soulDir).write({
      version: 1,
      lessons: [
        lesson({
          classKey: 'web_fetch:guessed-url',
          tool: 'web_fetch',
          errorClass: 'guessed-url',
          createdAt: new Date(NOW - DAY).toISOString(),
        }),
      ],
      suppressed: [],
    });
    const { d } = deps(notFound(5));
    const res = await run(d, { maxActive: 1 });
    expect(res.ok).toBe(true);
    expect(res.created).toBeUndefined();
    expect(new LessonStore(soulDir).read().lessons).toHaveLength(1);
    expect(goodGenerate).not.toHaveBeenCalled();
  });

  test('a class the watcher suppressed gets no lesson', async () => {
    new LessonStore(soulDir).write({
      version: 1,
      lessons: [],
      suppressed: [
        {
          classKey: 'file_read:file-not-found',
          reason: 'tool problem in 4 bots',
          since: new Date(NOW - DAY).toISOString(),
          bots: ['a', 'b', 'c', 'd'],
        },
      ],
    });
    const { d } = deps(notFound(5));
    const res = await run(d);
    expect(res).toEqual({ ok: true, evaluated: 0, changed: [] });
    expect(new LessonStore(soulDir).read().lessons).toEqual([]);
    expect(readSoulEvents(soulDir)).toEqual([]);
  });

  test('cool-down: a class whose lesson was just retired is not rewritten at once', async () => {
    const retired = (daysAgo: number) =>
      lesson({ status: 'retired', updatedAt: new Date(NOW - daysAgo * DAY).toISOString() });

    new LessonStore(soulDir).write({ version: 1, lessons: [retired(1)], suppressed: [] });
    expect((await run(deps(notFound(5)).d)).created).toBeUndefined();

    new LessonStore(soulDir).write({
      version: 1,
      lessons: [lesson({ status: 'unproven', updatedAt: new Date(NOW - DAY).toISOString() })],
      suppressed: [],
    });
    expect((await run(deps(notFound(5)).d)).created).toBeUndefined();

    new LessonStore(soulDir).write({ version: 1, lessons: [retired(6)], suppressed: [] });
    expect((await run(deps(notFound(5)).d)).created).toBeDefined();
  });

  describe('evaluation', () => {
    /** 10 file_read calls after the lesson, `failing` of them failing its class. */
    function callsAfter(failing: number): ToolAuditEntry[] {
      return Array.from({ length: 10 }, (_, i) => {
        const ms = NOW - 5 * DAY + i * HOUR;
        return i < failing ? row(ms) : ok(ms);
      });
    }

    test('active → proven: stores the measure, writes a soul event', async () => {
      new LessonStore(soulDir).write({ version: 1, lessons: [lesson()], suppressed: [] });
      const res = await run(deps(callsAfter(0)).d);
      expect(res).toEqual({
        ok: true,
        evaluated: 1,
        changed: [{ id: 'l-aaaaaaaa', from: 'active', to: 'proven' }],
      });
      const [l] = new LessonStore(soulDir).read().lessons;
      expect(l.status).toBe('proven');
      expect(l.statusReason).toContain('50% → 0%');
      expect(l.measure).toMatchObject({ failures: 0, calls: 10, untilMs: NOW });
      expect(l.extended).toBe(false);
      expect(l.updatedAt).toBe(new Date(NOW).toISOString());
      const events = readSoulEvents(soulDir);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ op: 'lesson', cycleId: 'c-now', file: 'LESSONS.json' });
      expect(events[0].summary).toBe('Lesson proven: Read the exact path.');
    });

    test('active → retired', async () => {
      new LessonStore(soulDir).write({ version: 1, lessons: [lesson()], suppressed: [] });
      const res = await run(deps(callsAfter(5)).d);
      expect(res.changed).toEqual([{ id: 'l-aaaaaaaa', from: 'active', to: 'retired' }]);
      const [l] = new LessonStore(soulDir).read().lessons;
      expect(l.status).toBe('retired');
      expect(l.measure?.failures).toBe(5);
      expect(readSoulEvents(soulDir)[0].summary).toStartWith('Lesson retired: ');
      // The retired class does not come straight back.
      expect(new LessonStore(soulDir).read().lessons).toHaveLength(1);
    });

    test('too few calls: extended once without an event, then unproven with one', async () => {
      new LessonStore(soulDir).write({ version: 1, lessons: [lesson()], suppressed: [] });
      const thin = [ok(NOW - 5 * DAY + HOUR), ok(NOW - 5 * DAY + 2 * HOUR)];
      const first = await run(deps(thin).d);
      expect(first).toEqual({ ok: true, evaluated: 1, changed: [] });
      let [l] = new LessonStore(soulDir).read().lessons;
      expect(l.status).toBe('active');
      expect(l.extended).toBe(true);
      expect(l.measure?.calls).toBe(2);
      expect(readSoulEvents(soulDir)).toEqual([]);

      const later = NOW + 6 * DAY;
      const res = await run(deps(thin, { nowMs: () => later }).d);
      expect(res.changed).toEqual([{ id: 'l-aaaaaaaa', from: 'active', to: 'unproven' }]);
      [l] = new LessonStore(soulDir).read().lessons;
      expect(l.status).toBe('unproven');
      expect(readSoulEvents(soulDir)[0].summary).toStartWith('Lesson unproven: ');
    });

    test('an open window changes nothing and writes nothing', async () => {
      new LessonStore(soulDir).write({
        version: 1,
        lessons: [lesson({ createdAt: new Date(NOW - DAY).toISOString() })],
        suppressed: [],
      });
      const before = new LessonStore(soulDir).read();
      const res = await run(deps([ok(NOW - HOUR)]).d);
      expect(res).toEqual({ ok: true, evaluated: 1, changed: [] });
      expect(new LessonStore(soulDir).read()).toEqual(before);
    });
  });

  test('a throwing store: ok false, no throw, a warn', async () => {
    const store = {
      read: () => {
        throw new Error('disk gone');
      },
      update: () => {
        throw new Error('disk gone');
      },
    } as unknown as LessonStore;
    const res = await run(deps(notFound(5), { store }).d);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('disk gone');
    expect(warn).toHaveBeenCalled();
  });

  test('a throwing readAudit: ok false, nothing written', async () => {
    const res = await run(
      deps([], {
        readAudit: () => {
          throw new Error('audit unreadable');
        },
      }).d
    );
    expect(res).toMatchObject({ ok: false, error: 'audit unreadable' });
    expect(warn).toHaveBeenCalled();
    expect(existsSync(join(soulDir, 'LESSONS.json'))).toBe(false);
  });

  test('a failing generate falls back to the fixed sentence', async () => {
    const generate = mock(async () => {
      throw new Error('429');
    });
    const res = await run(deps(notFound(3), { generate }).d);
    expect(res.created).toBeDefined();
    const [l] = new LessonStore(soulDir).read().lessons;
    expect(l.textSource).toBe('fallback');
    expect(l.text).toContain('Never guess a path');
    expect(l.evidence).toHaveLength(3);
  });
});
