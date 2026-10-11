import { describe, expect, it } from 'bun:test';
import {
  formatElapsed,
  formatEnvelope,
  formatLocalStamp,
  stripEnvelope,
  withEnvelope,
} from '../src/bot/message-envelope';

// Local-time constructor so the expectations hold in any process TZ.
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s);

describe('formatElapsed', () => {
  it('uses seconds under a minute', () => {
    expect(formatElapsed(30_000)).toBe('+30s');
  });
  it('uses minutes under an hour', () => {
    expect(formatElapsed(5 * 60_000)).toBe('+5m');
  });
  it('uses hours under two days', () => {
    expect(formatElapsed(47 * 3_600_000)).toBe('+47h');
  });
  it('uses days from two days on', () => {
    expect(formatElapsed(3 * 86_400_000 + 5 * 3_600_000)).toBe('+3d');
  });
  it('clamps negative gaps (clock skew) to zero', () => {
    expect(formatElapsed(-5_000)).toBe('+0s');
  });
});

describe('formatEnvelope', () => {
  it('stamps weekday, local date and time', () => {
    expect(formatEnvelope(at(2026, 10, 11, 12, 50))).toBe('[Sun 2026-10-11 12:50]');
  });

  it('adds the gap since the previous message in the chat', () => {
    const now = at(2026, 10, 11, 12, 50);
    const previous = at(2026, 10, 3, 21, 10).toISOString();
    expect(formatEnvelope(now, previous)).toBe('[Sun 2026-10-11 12:50 · +7d]');
  });

  it('ignores an unparseable previous timestamp', () => {
    expect(formatEnvelope(at(2026, 10, 11, 12, 50), 'garbage')).toBe('[Sun 2026-10-11 12:50]');
  });
});

describe('stripEnvelope', () => {
  it('removes a leading envelope from a stored message', () => {
    expect(stripEnvelope('[Sun 2026-10-11 12:50 · +7d] Hola Finny')).toBe('Hola Finny');
  });
  it('keeps a group sender prefix after the envelope', () => {
    expect(stripEnvelope('[Sun 2026-10-11 12:50] [Ana]: hola')).toBe('[Ana]: hola');
  });
  it('leaves text without an envelope untouched', () => {
    expect(stripEnvelope('[Ana]: hola')).toBe('[Ana]: hola');
  });
});

describe('stripEnvelope on replies', () => {
  it('drops an envelope the model copied into its reply', () => {
    expect(stripEnvelope('[Sun 2026-10-11 12:51] ¡Hola!')).toBe('¡Hola!');
  });
  it('does not touch a normal reply', () => {
    expect(stripEnvelope('¡Hola! [nota]')).toBe('¡Hola! [nota]');
  });
});

describe('formatLocalStamp / withEnvelope', () => {
  it('formats a bare local stamp', () => {
    expect(formatLocalStamp(at(2026, 10, 3, 21, 10))).toBe('Sat 2026-10-03 21:10');
  });
  it('prefixes text with the envelope', () => {
    expect(withEnvelope('hola', at(2026, 10, 11, 12, 50))).toBe('[Sun 2026-10-11 12:50] hola');
  });
});
