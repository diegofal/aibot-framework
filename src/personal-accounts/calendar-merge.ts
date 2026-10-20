/**
 * Pure calendar arithmetic over events from every account: the merged agenda
 * with overlaps flagged, and the free gaps of a window.
 */
import type { CalendarEvent } from './types';

export interface AgendaRow {
  event: CalendarEvent;
  /** Ids of the timed events this one overlaps (any account). */
  overlapsWith: string[];
}

export interface FreeSlot {
  start: string;
  end: string;
  minutes: number;
}

const ms = (iso: string) => Date.parse(iso);

/** Every event sorted by start (then end); timed events that overlap flag each other. */
export function mergeAgenda(events: CalendarEvent[]): AgendaRow[] {
  const sorted = [...events].sort((a, b) => ms(a.start) - ms(b.start) || ms(a.end) - ms(b.end));
  return sorted.map((event) => ({
    event,
    overlapsWith: event.allDay
      ? []
      : sorted
          .filter(
            (o) =>
              o !== event && !o.allDay && ms(o.start) < ms(event.end) && ms(event.start) < ms(o.end)
          )
          .map((o) => o.id),
  }));
}

/**
 * Gaps of at least `minMinutes` inside `[from, to]` not covered by a timed
 * event. All-day events (holidays, out-of-office markers) do not block time.
 */
export function freeSlots(
  events: CalendarEvent[],
  from: Date,
  to: Date,
  minMinutes: number
): FreeSlot[] {
  const lo = from.getTime();
  const hi = to.getTime();
  const busy = events
    .filter((e) => !e.allDay)
    .map((e) => [Math.max(lo, ms(e.start)), Math.min(hi, ms(e.end))] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const slots: FreeSlot[] = [];
  let cursor = lo;
  const push = (s: number, e: number) => {
    const minutes = Math.floor((e - s) / 60_000);
    if (minutes >= minMinutes)
      slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), minutes });
  };
  for (const [s, e] of busy) {
    if (s > cursor) push(cursor, s);
    cursor = Math.max(cursor, e);
  }
  if (hi > cursor) push(cursor, hi);
  return slots;
}
