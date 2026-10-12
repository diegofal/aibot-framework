import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SOUL_EVENTS_FILE,
  SOUL_EVENT_HEAD_CHARS,
  SOUL_EVENT_MAX_HEADS,
  appendSoulEvent,
  diffLines,
  readSoulEvents,
  soulEventHead,
} from '../../src/bot/soul-events';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'soul-events-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('soulEventHead', () => {
  it('collapses whitespace and clips to the head length with an ellipsis', () => {
    expect(soulEventHead('  a\n  b  ')).toBe('a b');
    const long = soulEventHead('x'.repeat(500));
    expect(long.length).toBe(SOUL_EVENT_HEAD_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('appendSoulEvent / readSoulEvents', () => {
  it('appends one row and reads it back, oldest first', () => {
    appendSoulEvent(dir, {
      file: 'MEMORY.md',
      op: 'consolidate',
      actor: 'system',
      summary: 'first',
      now: () => new Date('2026-10-11T10:00:00Z'),
    });
    appendSoulEvent(dir, {
      file: 'core-memory',
      op: 'facts-saved',
      actor: 'system',
      summary: 'second',
      conversation: 'bot:b1:private:1',
    });
    const events = readSoulEvents(dir);
    expect(events.map((e) => e.summary)).toEqual(['first', 'second']);
    expect(events[0].ts).toBe('2026-10-11T10:00:00.000Z');
    expect(events[1].conversation).toBe('bot:b1:private:1');
  });

  it('clips heads and caps added/removed/detail lists', () => {
    appendSoulEvent(dir, {
      file: 'MEMORY.md',
      op: 'consolidate',
      actor: 'system',
      summary: 's'.repeat(400),
      added: Array.from({ length: 20 }, (_, i) => `fact ${i} ${'y'.repeat(300)}`),
      removed: ['gone'],
      detail: Array.from({ length: 20 }, (_, i) => `d${i}`),
    });
    const [e] = readSoulEvents(dir);
    expect(e.added).toHaveLength(SOUL_EVENT_MAX_HEADS);
    expect(e.added?.every((h) => h.length <= SOUL_EVENT_HEAD_CHARS)).toBe(true);
    expect(e.removed).toEqual(['gone']);
    expect(e.detail).toHaveLength(SOUL_EVENT_MAX_HEADS);
    expect(e.summary.length).toBeLessThanOrEqual(240);
  });

  it('drops empty optional lists rather than storing []', () => {
    appendSoulEvent(dir, {
      file: 'f',
      op: 'hygiene-fix',
      actor: 'hygiene',
      summary: 's',
      added: [],
    });
    const raw = readFileSync(join(dir, SOUL_EVENTS_FILE), 'utf-8');
    expect(raw).not.toContain('"added"');
  });

  it('never throws when the write fails; reports through onError', () => {
    const errors: unknown[] = [];
    const missing = join(dir, 'nope', 'deeper');
    writeFileSync(join(dir, 'nope'), 'a file, not a dir');
    expect(() =>
      appendSoulEvent(missing, {
        file: 'f',
        op: 'consolidate',
        actor: 'system',
        summary: 's',
        onError: (err) => errors.push(err),
      })
    ).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it('rotates past the size cap, keeping the newest rows', () => {
    for (let i = 0; i < 40; i++) {
      appendSoulEvent(dir, {
        file: 'f',
        op: 'facts-saved',
        actor: 'system',
        summary: `event ${i} ${'z'.repeat(150)}`,
        maxBytes: 2_000,
      });
    }
    const events = readSoulEvents(dir);
    expect(events.length).toBeLessThan(40);
    expect(events.at(-1)?.summary).toStartWith('event 39');
    expect(readFileSync(join(dir, SOUL_EVENTS_FILE), 'utf-8').length).toBeLessThanOrEqual(2_000);
  });

  it('reads nothing from a missing file and skips malformed lines', () => {
    expect(readSoulEvents(dir)).toEqual([]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, SOUL_EVENTS_FILE),
      `not json\n${JSON.stringify({ ts: 't', file: 'f', op: 'consolidate', actor: 'system', summary: 's' })}\n`
    );
    expect(readSoulEvents(dir)).toHaveLength(1);
  });

  it('limit returns the newest rows', () => {
    for (let i = 0; i < 5; i++)
      appendSoulEvent(dir, { file: 'f', op: 'consolidate', actor: 'system', summary: `${i}` });
    expect(readSoulEvents(dir, { limit: 2 }).map((e) => e.summary)).toEqual(['3', '4']);
  });
});

describe('diffLines', () => {
  it('lists lines added and dropped, ignoring blanks and the consolidation header', () => {
    const before =
      '<!-- last-consolidated: 2026-10-01 -->\n# Memory\n- likes tea\n- lives in a flat\n';
    const after = '<!-- last-consolidated: 2026-10-11 -->\n# Memory\n\n- likes tea\n- has a bike\n';
    expect(diffLines(before, after)).toEqual({
      added: ['- has a bike'],
      removed: ['- lives in a flat'],
    });
  });

  it('treats a missing previous file as everything added', () => {
    expect(diffLines(null, 'a\nb')).toEqual({ added: ['a', 'b'], removed: [] });
  });
});
