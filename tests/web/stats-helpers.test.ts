import { describe, expect, it } from 'bun:test';
import {
  SEVERITY_ORDER,
  STATS_WINDOWS,
  answerRate,
  barHeights,
  channelStateClass,
  compareBy,
  driftVectorData,
  failRateClass,
  formatBytes,
  formatDuration,
  formatNumber,
  formatPct,
  formatTokens,
  groupFindings,
  isStaleContact,
  normalizeWindow,
  optionsFromChecked,
  postureClass,
  relativeTime,
  routineOptions,
  severityRank,
  sortFindings,
  sparklinePoints,
  traitDeltas,
  windowQuery,
} from '../../web/pages/stats-helpers.js';

describe('formatNumber', () => {
  it('renders integers with thousands separators', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
  it('renders a dash for nullish / NaN values', () => {
    expect(formatNumber(null)).toBe('--');
    expect(formatNumber(undefined)).toBe('--');
    expect(formatNumber(Number.NaN)).toBe('--');
  });
  it('rounds non-integers', () => {
    expect(formatNumber(12.6)).toBe('13');
  });
});

describe('formatTokens', () => {
  it('abbreviates thousands with k and millions with M', () => {
    expect(formatTokens(340_000)).toBe('340k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(12_500)).toBe('12.5k');
    expect(formatTokens(999)).toBe('999');
  });
  it('drops a trailing .0', () => {
    expect(formatTokens(2_000_000)).toBe('2M');
    expect(formatTokens(5_000)).toBe('5k');
  });
  it('handles zero and nullish', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(undefined)).toBe('--');
  });
});

describe('formatPct', () => {
  it('formats ratios as whole percentages', () => {
    expect(formatPct(0.1234)).toBe('12%');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(1)).toBe('100%');
    expect(formatPct(0.005)).toBe('1%');
  });
  it('returns a dash for nullish / NaN', () => {
    expect(formatPct(null)).toBe('--');
    expect(formatPct(Number.NaN)).toBe('--');
  });
});

describe('formatDuration / formatBytes', () => {
  it('formats durations at sensible units', () => {
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(null)).toBe('--');
  });
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(2048)).toBe('2.0KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0MB');
    expect(formatBytes(undefined)).toBe('--');
  });
});

describe('window handling', () => {
  it('exposes the three supported windows', () => {
    expect(STATS_WINDOWS).toEqual(['24h', '7d', '30d']);
  });
  it('normalizes unknown values to the 7d default', () => {
    expect(normalizeWindow('24h')).toBe('24h');
    expect(normalizeWindow('30d')).toBe('30d');
    expect(normalizeWindow('1y')).toBe('7d');
    expect(normalizeWindow(undefined)).toBe('7d');
    expect(normalizeWindow('')).toBe('7d');
  });
  it('builds the query string', () => {
    expect(windowQuery('24h')).toBe('?window=24h');
    expect(windowQuery('bogus')).toBe('?window=7d');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-08-21T12:00:00Z');
  it('renders past timestamps', () => {
    expect(relativeTime('2026-08-21T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-08-21T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-08-14T12:00:00Z', now)).toBe('7d ago');
    expect(relativeTime('2026-08-21T11:45:00Z', now)).toBe('15m ago');
  });
  it('renders future timestamps', () => {
    expect(relativeTime('2026-08-21T12:20:00Z', now)).toBe('in 20m');
    expect(relativeTime('2026-08-22T14:00:00Z', now)).toBe('in 1d');
  });
  it('renders never for nullish / invalid', () => {
    expect(relativeTime(null, now)).toBe('never');
    expect(relativeTime('not-a-date', now)).toBe('never');
  });
});

describe('isStaleContact', () => {
  const now = Date.parse('2026-08-21T12:00:00Z');
  it('flags contacts older than 7 days and missing contacts', () => {
    expect(isStaleContact('2026-08-13T12:00:00Z', now)).toBe(true);
    expect(isStaleContact(null, now)).toBe(true);
  });
  it('accepts recent contacts', () => {
    expect(isStaleContact('2026-08-20T12:00:00Z', now)).toBe(false);
    expect(isStaleContact('2026-08-14T12:00:01Z', now)).toBe(false);
  });
});

describe('posture / channel / fail-rate classes', () => {
  it('maps postures to badge classes', () => {
    expect(postureClass('active')).toBe('badge-ok');
    expect(postureClass('standby')).toBe('stats-badge-amber');
    expect(postureClass('idle')).toBe('stats-badge-amber');
    expect(postureClass('dormant')).toBe('badge-disabled');
    expect(postureClass('blocked')).toBe('badge-error');
    expect(postureClass('unknown')).toBe('badge-disabled');
    expect(postureClass(undefined)).toBe('badge-disabled');
  });
  it('maps channel states to pill classes', () => {
    expect(channelStateClass('ok')).toBe('badge-ok');
    expect(channelStateClass('revoked')).toBe('badge-error');
    expect(channelStateClass('missing')).toBe('badge-error');
    expect(channelStateClass('placeholder')).toBe('stats-badge-amber');
    expect(channelStateClass('configured')).toBe('badge-disabled');
    expect(channelStateClass('unknown')).toBe('badge-disabled');
  });
  it('classifies fail rates', () => {
    expect(failRateClass(0)).toBe('ok');
    expect(failRateClass(0.05)).toBe('ok');
    expect(failRateClass(0.15)).toBe('warn');
    expect(failRateClass(0.5)).toBe('bad');
    expect(failRateClass(null)).toBe('ok');
  });
});

describe('barHeights', () => {
  it('scales values to the max as percentages', () => {
    expect(barHeights([10, 5, 0])).toEqual([100, 50, 0]);
  });
  it('returns zeros when there is no positive value', () => {
    expect(barHeights([0, 0])).toEqual([0, 0]);
    expect(barHeights([])).toEqual([]);
  });
  it('gives a visible minimum to tiny non-zero values', () => {
    const [big, tiny] = barHeights([1000, 1]);
    expect(big).toBe(100);
    expect(tiny).toBeGreaterThanOrEqual(2);
  });
  it('honours an explicit max', () => {
    expect(barHeights([5], 10)).toEqual([50]);
  });
});

describe('sparklinePoints', () => {
  it('maps a series to SVG polyline coordinates', () => {
    const pts = sparklinePoints([0, 5, 10], 100, 20);
    expect(pts).toBe('0,20 50,10 100,0');
  });
  it('handles flat series by drawing a mid-line', () => {
    expect(sparklinePoints([3, 3], 100, 20)).toBe('0,10 100,10');
  });
  it('returns an empty string for fewer than two points', () => {
    expect(sparklinePoints([], 100, 20)).toBe('');
    expect(sparklinePoints([1], 100, 20)).toBe('');
  });
});

describe('driftVectorData', () => {
  it('sorts traits by absolute drift and scales to the largest', () => {
    const data = driftVectorData({ curiosity: 0.2, patience: -0.4, humor: 0.1 });
    expect(data.map((d) => d.trait)).toEqual(['patience', 'curiosity', 'humor']);
    expect(data[0]).toEqual({ trait: 'patience', value: -0.4, pct: 100, sign: 'neg' });
    expect(data[1].pct).toBe(50);
    expect(data[1].sign).toBe('pos');
    expect(data[2].pct).toBe(25);
  });
  it('handles an empty / nullish vector', () => {
    expect(driftVectorData({})).toEqual([]);
    expect(driftVectorData(undefined)).toEqual([]);
  });
  it('treats zero drift as neutral', () => {
    expect(driftVectorData({ calm: 0 })[0]).toEqual({
      trait: 'calm',
      value: 0,
      pct: 0,
      sign: 'zero',
    });
  });
});

describe('traitDeltas', () => {
  it('pairs current and baseline per trait with delta', () => {
    const rows = traitDeltas({ a: 0.7, b: 0.4 }, { a: 0.5, b: 0.4 });
    expect(rows).toEqual([
      { trait: 'a', current: 0.7, baseline: 0.5, delta: 0.2 },
      { trait: 'b', current: 0.4, baseline: 0.4, delta: 0 },
    ]);
  });
  it('includes traits only present on one side', () => {
    const rows = traitDeltas({ a: 0.3 }, { b: 0.6 });
    expect(rows.find((r) => r.trait === 'a')).toEqual({
      trait: 'a',
      current: 0.3,
      baseline: null,
      delta: null,
    });
    expect(rows.find((r) => r.trait === 'b')).toEqual({
      trait: 'b',
      current: null,
      baseline: 0.6,
      delta: null,
    });
  });
  it('avoids float noise in deltas', () => {
    expect(traitDeltas({ a: 0.3 }, { a: 0.1 })[0].delta).toBe(0.2);
  });
});

describe('severity ordering', () => {
  it('orders critical before warn before info', () => {
    expect(SEVERITY_ORDER).toEqual(['critical', 'warn', 'info']);
    expect(severityRank('critical')).toBe(0);
    expect(severityRank('warn')).toBe(1);
    expect(severityRank('info')).toBe(2);
    expect(severityRank('bogus')).toBe(3);
  });
  it('sortFindings sorts by severity, then kind, then file:line', () => {
    const sorted = sortFindings([
      { id: '1', severity: 'info', kind: 'b', file: 'x', line: 2 },
      { id: '2', severity: 'critical', kind: 'z', file: 'x', line: 1 },
      { id: '3', severity: 'warn', kind: 'a', file: 'y', line: 9 },
      { id: '4', severity: 'warn', kind: 'a', file: 'x', line: 9 },
      { id: '5', severity: 'critical', kind: 'a', file: 'x', line: 1 },
    ]);
    expect(sorted.map((f) => f.id)).toEqual(['5', '2', '4', '3', '1']);
  });
  it('groupFindings groups by severity then kind preserving order', () => {
    const groups = groupFindings([
      { id: '1', severity: 'info', kind: 'b' },
      { id: '2', severity: 'critical', kind: 'z' },
      { id: '3', severity: 'critical', kind: 'a' },
      { id: '4', severity: 'critical', kind: 'a' },
    ]);
    expect(groups.map((g) => g.severity)).toEqual(['critical', 'info']);
    expect(groups[0].kinds.map((k) => k.kind)).toEqual(['a', 'z']);
    expect(groups[0].kinds[0].findings.map((f) => f.id)).toEqual(['3', '4']);
    expect(groups[0].count).toBe(3);
  });
  it('groupFindings handles empty input', () => {
    expect(groupFindings([])).toEqual([]);
    expect(groupFindings(undefined)).toEqual([]);
  });
});

describe('compareBy', () => {
  const rows = [
    { name: 'b', n: 2, t: '2026-01-02T00:00:00Z' },
    { name: 'a', n: 10, t: null },
    { name: 'c', n: 1, t: '2026-01-01T00:00:00Z' },
  ];
  it('sorts numbers descending by default and strings ascending', () => {
    expect([...rows].sort(compareBy((r) => r.n)).map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect([...rows].sort(compareBy((r) => r.name)).map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });
  it('reverses when dir is -1', () => {
    expect([...rows].sort(compareBy((r) => r.n, -1)).map((r) => r.name)).toEqual(['c', 'b', 'a']);
  });
  it('pushes nullish values last regardless of direction', () => {
    expect([...rows].sort(compareBy((r) => r.t)).map((r) => r.name)).toEqual(['c', 'b', 'a']);
    expect([...rows].sort(compareBy((r) => r.t, -1)).map((r) => r.name)).toEqual(['b', 'c', 'a']);
  });
});

describe('answerRate', () => {
  it('computes answered / sent', () => {
    expect(answerRate(4, 8)).toBe(0.5);
  });
  it('returns null when nothing was sent', () => {
    expect(answerRate(0, 0)).toBeNull();
    expect(answerRate(undefined, undefined)).toBeNull();
  });
});

describe('routine options', () => {
  it('routineOptions returns the opt-in list for a routine, empty for others', () => {
    expect(routineOptions('productions-triage').map((o) => o.key)).toEqual([
      'archiveStale',
      'pruneOrphans',
    ]);
    expect(routineOptions('goal-lint')).toEqual([]);
    expect(routineOptions('nope')).toEqual([]);
  });

  it('optionsFromChecked is undefined when nothing is ticked', () => {
    expect(optionsFromChecked('productions-triage', [])).toBeUndefined();
    expect(optionsFromChecked('productions-triage', undefined)).toBeUndefined();
  });

  it('optionsFromChecked maps ticked keys to booleans', () => {
    expect(optionsFromChecked('productions-triage', ['pruneOrphans'])).toEqual({
      pruneOrphans: true,
    });
    expect(optionsFromChecked('productions-triage', ['archiveStale', 'pruneOrphans'])).toEqual({
      archiveStale: true,
      pruneOrphans: true,
    });
  });

  it('ignores keys the routine does not accept', () => {
    expect(optionsFromChecked('productions-triage', ['redactCustody'])).toBeUndefined();
    expect(optionsFromChecked('goal-lint', ['pruneOrphans'])).toBeUndefined();
  });

  it('redactCustody expands to the safe kinds plus custody', () => {
    expect(optionsFromChecked('memory-hygiene', ['redactCustody'])).toEqual({
      redactKinds: ['email', 'phone', 'chat-id', 'custody'],
    });
  });
});
