import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  briefPath,
  parseBriefInput,
  readBrief,
  renderBriefForPrompt,
  writeBrief,
} from '../../../src/watcher/roster/brief';
import type { OperatorBrief } from '../../../src/watcher/roster/types';

let dir: string;
let n = 0;
const newId = () => `w-00000${n++}`;
const empty: OperatorBrief = { wants: [], notes: '' };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brief-'));
  n = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const want = (what: string, extra: Record<string, unknown> = {}) => ({
  what,
  cadence: 'every Monday',
  delivery: 'Telegram',
  success: 'I apply to one of them',
  ...extra,
});

describe('readBrief', () => {
  test('a missing file reads as an empty brief', () => {
    expect(readBrief(dir)).toEqual(empty);
  });
});

describe('parseBriefInput', () => {
  test('assigns ids to new wants, keeps known ones, trims and drops empty wants', () => {
    const r = parseBriefInput(
      {
        wants: [want('  Five AI roles a week  ', { id: 'w-abcdef' }), want(''), want('A digest')],
        notes: ' I read Telegram in the morning ',
      },
      newId
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.brief.wants.map((w) => [w.id, w.what])).toEqual([
      ['w-abcdef', 'Five AI roles a week'],
      ['w-000000', 'A digest'],
    ]);
    expect(r.brief.notes).toBe('I read Telegram in the morning');
  });

  test('an id that is malformed or repeated gets a fresh one', () => {
    const r = parseBriefInput(
      {
        wants: [
          want('a', { id: 'x' }),
          want('b', { id: 'w-abcdef' }),
          want('c', { id: 'w-abcdef' }),
        ],
      },
      newId
    );
    expect(r.ok && r.brief.wants.map((w) => w.id)).toEqual(['w-000000', 'w-abcdef', 'w-000001']);
  });

  test('rejects more than five wants, over-long fields and a malformed body', () => {
    const six = Array.from({ length: 6 }, (_, i) => want(`w${i}`));
    expect(parseBriefInput({ wants: six }, newId)).toEqual({
      ok: false,
      error: 'At most 5 wants',
    });
    const long = parseBriefInput({ wants: [want('x'.repeat(301))] }, newId);
    expect(long.ok).toBe(false);
    expect(!long.ok && long.error).toContain('what');
    expect(parseBriefInput({ wants: [], notes: 'x'.repeat(2001) }, newId).ok).toBe(false);
    expect(parseBriefInput(null, newId).ok).toBe(false);
    expect(parseBriefInput({ wants: 'no' }, newId).ok).toBe(false);
  });
});

describe('writeBrief', () => {
  test('writes under self/ with updatedAt and reads back', () => {
    const r = parseBriefInput({ wants: [want('Roles')] }, newId);
    if (!r.ok) throw new Error(r.error);
    const saved = writeBrief(dir, r.brief, Date.parse('2026-10-28T03:00:00Z'));
    expect(saved.updatedAt).toBe('2026-10-28T03:00:00.000Z');
    expect(briefPath(dir)).toBe(join(dir, 'self', 'brief.json'));
    expect(JSON.parse(readFileSync(briefPath(dir), 'utf-8')).wants[0].what).toBe('Roles');
    expect(readBrief(dir)).toEqual(saved);
  });
});

describe('renderBriefForPrompt', () => {
  test('one block per want with its id, then the notes', () => {
    const text = renderBriefForPrompt({
      wants: [
        { id: 'w-aaaaaa', what: 'Roles', cadence: 'weekly', delivery: '', success: 'I apply' },
      ],
      notes: 'Mornings only',
    });
    expect(text).toContain('[w-aaaaaa] Roles');
    expect(text).toContain('How often: weekly');
    expect(text).toContain('Good looks like: I apply');
    expect(text).not.toContain('Delivered by:');
    expect(text).toContain('Mornings only');
  });

  test('an empty brief says so', () => {
    expect(renderBriefForPrompt(empty)).toBe('(The operator has not written a brief.)');
  });
});
