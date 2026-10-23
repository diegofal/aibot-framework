import { describe, expect, test } from 'bun:test';
import {
  broadcastRowsHtml,
  formatMetricValue,
  insightRowsHtml,
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

describe('insightRowsHtml', () => {
  const n = (id: string, kind: string, createdAt: string, meta?: Record<string, string>) => ({
    id,
    kind,
    text: `text ${id}`,
    support: { bots: ['b1', 'b2'] },
    createdBy: 'watcher',
    createdAt,
    lastActivatedAt: createdAt,
    activations: 1,
    ...(meta ? { meta } : {}),
  });

  test('insights, contradictions and predictions newest first, with signals', () => {
    const html = insightRowsHtml(
      [
        n('n-1', 'insight', '2026-10-23T10:00:00Z'),
        n('n-2', 'contradiction', '2026-10-23T11:00:00Z', { signal: 'down' }),
        n('n-3', 'fact', '2026-10-23T11:30:00Z'),
        n('n-4', 'prediction', '2026-10-23T09:00:00Z', {
          probability: '0.7',
          dueAt: '2026-10-24T09:00:00Z',
        }),
      ],
      NOW
    );
    expect(html.indexOf('text n-2')).toBeLessThan(html.indexOf('text n-1'));
    expect(html).not.toContain('text n-3');
    expect(html).toContain('data-signal-id="n-1"');
    expect(html).toContain('data-watcher-neuron="n-1"');
    expect(html).toContain('70 %');
    expect(html).toContain('b1, b2');
  });

  test('empty list says so', () => {
    expect(insightRowsHtml([], NOW)).toContain('No insights yet');
  });
});

describe('broadcastRowsHtml', () => {
  const b = (over: Record<string, unknown> = {}) => ({
    id: 'b-1',
    botId: 'b1',
    kind: 'directive',
    text: 'Coordinate with Scout',
    insightId: 'n-1',
    createdAt: '2026-10-23T10:00:00Z',
    deliveredAt: '2026-10-23T10:00:00Z',
    why: { what: 'Directive to Jarvis: "Coordinate with Scout"', by: 'watcher' },
    ...over,
  });

  test('a served broadcast shows "served by cycle" and an Open cycle button', () => {
    const html = broadcastRowsHtml(
      [b({ servedByCycle: 'c-9', servedAt: '2026-10-23T11:00:00Z' })],
      NOW
    );
    expect(html).toContain('served by cycle');
    expect(html).toContain('data-open-cycle="c-9"');
    expect(html).toContain('data-bot-id="b1"');
    expect(html).toContain('data-signal-id="b-1"');
    expect(html).toContain('Coordinate with Scout');
  });

  test('the Why goes through the shared panel', () => {
    const html = broadcastRowsHtml([b()], NOW);
    expect(html).toContain('why-');
  });

  test('not served, failed, and empty', () => {
    expect(broadcastRowsHtml([b()], NOW)).toContain('not served yet');
    expect(
      broadcastRowsHtml([b({ deliveredAt: undefined, deliveryError: 'throttled' })], NOW)
    ).toContain('not delivered');
    expect(broadcastRowsHtml([], NOW)).toContain('No broadcasts yet');
  });
});
