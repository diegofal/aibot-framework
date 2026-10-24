import { describe, expect, test } from 'bun:test';
import {
  formatMetricValue,
  metricsStripHtml,
  signalButtonsHtml,
} from '../../web/pages/watcher-metrics-helpers.js';

const NOW = Date.parse('2026-10-23T12:00:00Z');

const metrics = {
  window: '7d',
  from: '2026-10-16T12:00:00.000Z',
  to: '2026-10-23T12:00:00.000Z',
  metrics: [
    {
      id: 'crossSource',
      label: 'Cross-source insight share',
      value: 0.42,
      baseline: 0,
      target: '≥ 30 %',
      unit: 'share',
      n: 12,
    },
    {
      id: 'latency',
      label: 'Latency to notice (median)',
      value: 150000,
      baseline: 7200000,
      target: 'tier 1 < 5 min',
      unit: 'ms',
      n: 4,
    },
    {
      id: 'calibration',
      label: 'Prediction calibration (Brier)',
      value: 0.25,
      baseline: 0.25,
      target: 'below baseline',
      unit: 'brier',
      n: 0,
    },
    {
      id: 'surprises',
      label: 'Novel fleet surprises per week',
      value: 3,
      baseline: 0,
      target: '≥ 3 / week',
      unit: 'perWeek',
      n: 3,
    },
  ],
  guards: [
    { id: 'cost', label: 'Watcher LLM cost', value: 2.5, limit: 24, unit: 'usd', over: true },
    { id: 'idle', label: 'Bot idle cycles', value: 0.2, limit: 0.3, unit: 'share', over: false },
  ],
};

describe('formatMetricValue', () => {
  test('by unit', () => {
    expect(formatMetricValue(0.42, 'share')).toBe('42 %');
    expect(formatMetricValue(150000, 'ms')).toBe('2.5 min');
    expect(formatMetricValue(7_200_000, 'ms')).toBe('2.0 h');
    expect(formatMetricValue(800, 'ms')).toBe('0.8 s');
    expect(formatMetricValue(0.123, 'brier')).toBe('0.12');
    expect(formatMetricValue(3, 'perWeek')).toBe('3.0 / wk');
    expect(formatMetricValue(2.5, 'usd')).toBe('$2.50');
    expect(formatMetricValue(4, 'count')).toBe('4');
    expect(formatMetricValue(0.5, 'score')).toBe('50 %');
  });
  test('never prints NaN', () => {
    expect(formatMetricValue(Number.NaN, 'share')).toBe('—');
    expect(formatMetricValue(undefined, 'ms')).toBe('—');
  });
});

describe('metricsStripHtml', () => {
  test('every metric with value, baseline and target; a metric with no data says so', () => {
    const html = metricsStripHtml(metrics);
    expect(html).toContain('Cross-source insight share');
    expect(html).toContain('42 %');
    expect(html).toContain('baseline 0 %');
    expect(html).toContain('target ≥ 30 %');
    expect(html).toContain('2.5 min');
    expect(html).toContain('no data yet');
    expect(html).toContain('each tile: now, baseline before the watcher, target');
  });
  test('guards over their limit are red (watcher-guard-over); others are not', () => {
    const html = metricsStripHtml(metrics);
    expect(html).toMatch(/class="watcher-guard watcher-guard-over"[^>]*>[\s\S]*Watcher LLM cost/);
    expect(html).toMatch(/class="watcher-guard"[^>]*>[\s\S]*Bot idle cycles/);
  });
  test('escapes text and is empty-safe', () => {
    expect(metricsStripHtml(null)).toContain('watcher-metrics');
    const html = metricsStripHtml({
      ...metrics,
      metrics: [{ ...metrics.metrics[0], label: '<b>x</b>' }],
      guards: [],
    });
    expect(html).not.toContain('<b>x</b>');
  });
});

describe('signalButtonsHtml', () => {
  test('two buttons for an id, the current signal pressed', () => {
    const html = signalButtonsHtml('n-1', 'up');
    expect(html).toContain('data-watcher-signal="up"');
    expect(html).toContain('data-watcher-signal="down"');
    expect(html).toContain('data-signal-id="n-1"');
    expect(html).toMatch(
      /aria-pressed="true"[^>]*data-watcher-signal="up"|data-watcher-signal="up"[^>]*aria-pressed="true"/
    );
  });
});

describe('signalButtonsHtml labels', () => {
  test('words replace the thumbs (a contradiction: Confirm / Dismiss)', () => {
    const html = signalButtonsHtml('n-1', 'up', { up: 'Confirm', down: 'Dismiss' });
    expect(html).toContain('>Confirm</button>');
    expect(html).toContain('>Dismiss</button>');
    expect(html).toContain('data-watcher-signal="down"');
    expect(html).not.toContain('👍');
  });
});
