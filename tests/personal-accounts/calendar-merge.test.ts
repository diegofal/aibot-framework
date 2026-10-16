import { describe, expect, test } from 'bun:test';
import { freeSlots, mergeAgenda } from '../../src/personal-accounts/calendar-merge';
import type { CalendarEvent } from '../../src/personal-accounts/types';

const ev = (
  id: string,
  account: string,
  start: string,
  end: string,
  extra: Partial<CalendarEvent> = {}
): CalendarEvent => ({
  id,
  account,
  accountLabel: account,
  provider: 'google',
  title: id,
  start,
  end,
  allDay: false,
  ...extra,
});

describe('mergeAgenda', () => {
  test('sorts events from every account by start', () => {
    const rows = mergeAgenda([
      ev('b', 'work', '2026-10-16T11:00:00Z', '2026-10-16T12:00:00Z'),
      ev('a', 'home', '2026-10-16T09:00:00Z', '2026-10-16T09:30:00Z'),
    ]);
    expect(rows.map((r) => r.event.id)).toEqual(['a', 'b']);
  });

  test('flags overlapping events on both sides, across accounts', () => {
    const rows = mergeAgenda([
      ev('a', 'home', '2026-10-16T09:00:00Z', '2026-10-16T10:00:00Z'),
      ev('b', 'work', '2026-10-16T09:30:00Z', '2026-10-16T11:00:00Z'),
      ev('c', 'work', '2026-10-16T11:00:00Z', '2026-10-16T12:00:00Z'),
    ]);
    expect(rows[0].overlapsWith).toEqual(['b']);
    expect(rows[1].overlapsWith).toEqual(['a']);
    // Back to back is not an overlap.
    expect(rows[2].overlapsWith).toEqual([]);
  });

  test('all-day events never count as overlaps', () => {
    const rows = mergeAgenda([
      ev('holiday', 'home', '2026-10-16T00:00:00Z', '2026-10-17T00:00:00Z', { allDay: true }),
      ev('a', 'work', '2026-10-16T09:00:00Z', '2026-10-16T10:00:00Z'),
    ]);
    expect(rows.every((r) => r.overlapsWith.length === 0)).toBe(true);
  });
});

describe('freeSlots', () => {
  const from = new Date('2026-10-16T09:00:00Z');
  const to = new Date('2026-10-16T13:00:00Z');

  test('returns the gaps between busy blocks that are long enough', () => {
    const slots = freeSlots(
      [
        ev('a', 'home', '2026-10-16T09:30:00Z', '2026-10-16T10:00:00Z'),
        ev('b', 'work', '2026-10-16T09:45:00Z', '2026-10-16T10:30:00Z'),
        ev('c', 'work', '2026-10-16T10:40:00Z', '2026-10-16T12:00:00Z'),
      ],
      from,
      to,
      30
    );
    expect(slots).toEqual([
      { start: '2026-10-16T09:00:00.000Z', end: '2026-10-16T09:30:00.000Z', minutes: 30 },
      { start: '2026-10-16T12:00:00.000Z', end: '2026-10-16T13:00:00.000Z', minutes: 60 },
    ]);
  });

  test('ignores all-day events and clips events outside the window', () => {
    const slots = freeSlots(
      [
        ev('d', 'home', '2026-10-16T00:00:00Z', '2026-10-17T00:00:00Z', { allDay: true }),
        ev('e', 'home', '2026-10-16T08:00:00Z', '2026-10-16T09:15:00Z'),
      ],
      from,
      to,
      60
    );
    expect(slots).toEqual([
      { start: '2026-10-16T09:15:00.000Z', end: '2026-10-16T13:00:00.000Z', minutes: 225 },
    ]);
  });

  test('a fully busy window has no slots', () => {
    expect(
      freeSlots([ev('x', 'w', '2026-10-16T08:00:00Z', '2026-10-16T14:00:00Z')], from, to, 15)
    ).toEqual([]);
  });
});
