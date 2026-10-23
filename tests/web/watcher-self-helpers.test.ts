import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attendingHtml,
  focusHighlightIds,
  howIAmHtml,
  introspectionHtml,
} from '../../web/pages/watcher-self-helpers.js';

const NOW = Date.parse('2026-10-23T12:00:00Z');

const intero = {
  fleetKarmaAvg: 61.5,
  breakerOpen: ['claude-cli'],
  semaphore: { limit: 3, active: 2, queued: 1, queuedInteractive: 1, activeWatcher: 1 },
  budgetUsedToday: { notice: 4, integrate: 2, tokens: 12000, usd: 0.34 },
  operatorSilenceHours: 5.2,
  bufferSalience: 1.75,
  lastIntegrateAgoMs: 120_000,
};

describe('howIAmHtml', () => {
  test('every variable in words, the open breaker marked', () => {
    const html = howIAmHtml(intero);
    expect(html).toContain('61.5');
    expect(html).toContain('open: claude-cli');
    expect(html).toContain('is-warn');
    expect(html).toContain('2/3 busy, 1 waiting (1 mine)');
    expect(html).toContain('12,000 tokens');
    expect(html).toContain('$0.34');
    expect(html).toContain('silent for 5 h');
    expect(html).toContain('2 min ago');
  });

  test('missing readings are dashes and words, never NaN', () => {
    const html = howIAmHtml({
      fleetKarmaAvg: null,
      breakerOpen: [],
      semaphore: null,
      budgetUsedToday: {},
      operatorSilenceHours: null,
      bufferSalience: 0,
      lastIntegrateAgoMs: null,
    });
    expect(html).toContain('closed');
    expect(html).toContain('not heard from yet');
    expect(html).toContain('never');
    expect(html).not.toContain('NaN');
    expect(howIAmHtml(null)).toContain('No reading yet');
  });
});

describe('attendingHtml', () => {
  test('phase, clickable focus neurons and the top events, escaped', () => {
    const html = attendingHtml(
      {
        phase: 'sense',
        attendingAt: '2026-10-23T11:00:00Z',
        focus: [{ id: 'n-aaaaaaaa', kind: 'insight', text: 'Two <bots> on Acme' }],
        items: [{ id: 'b-1', what: 'web_fetch failed in Jarvis', salience: 1.234 }],
      },
      NOW
    );
    expect(html).toContain('<strong>sense</strong>');
    expect(html).toContain('1 h ago');
    expect(html).toContain('data-watcher-neuron="n-aaaaaaaa"');
    expect(html).toContain('Two &lt;bots&gt; on Acme');
    expect(html).toContain('salience 1.23');
  });

  test('says so when nothing is named yet', () => {
    expect(attendingHtml({ phase: 'sense', focus: [], items: [] })).toContain('No focus named yet');
    expect(attendingHtml(undefined)).toContain('Nothing yet');
  });
});

describe('introspectionHtml', () => {
  const rows = [
    {
      ts: '2026-10-23T11:59:30Z',
      subject: 'watcher',
      trigger: 'manual',
      parsed: true,
      score: 0.75,
      fields: { phase: 'match', tool: 'match', goal: 'match', cause: 'miss' },
    },
    { ts: '2026-10-23T10:00:00Z', subject: 'bot:b1', parsed: false, score: 0, fields: {} },
  ];
  const subjects = [
    { subject: 'watcher', n: 1, score: 0.75, fields: { phase: 1, tool: 1, goal: 1, cause: 0 } },
    {
      subject: 'bot:b1',
      n: 1,
      score: 0,
      fields: { phase: null, tool: null, goal: null, cause: null },
    },
  ];

  test('summary per subject, then answers with field verdicts, and the ask button', () => {
    const html = introspectionHtml(rows, subjects, NOW);
    expect(html).toContain('data-action="watcher-introspect"');
    expect(html).toContain('Ask me now');
    expect(html).toContain('75 % over 1');
    expect(html).toContain('cause 0 %');
    expect(html).toContain('goal —');
    expect(html).toContain('watcher-field is-match');
    expect(html).toContain('watcher-field is-miss');
    expect(html).toContain('unreadable');
    expect(html).toContain('just now · manual');
  });

  test('empty history invites the first question; busy disables the button', () => {
    const html = introspectionHtml([], [], NOW, { busy: true });
    expect(html).toContain('Not asked yet');
    expect(html).toContain('disabled');
    expect(html).toContain('Asking…');
  });
});

describe('focusHighlightIds', () => {
  const att = { focusNeuronIds: ['n-1', 'n-2'] };
  test('the focus when nothing is selected', () => {
    expect(focusHighlightIds(att)).toEqual(['n-1', 'n-2']);
    expect(focusHighlightIds(undefined)).toEqual([]);
  });
  test('a selected row or a filter wins', () => {
    expect(focusHighlightIds(att, { selectedSeq: 3 })).toBeNull();
    expect(focusHighlightIds(att, { filterId: 'n-9' })).toBeNull();
  });
});

describe('purity', () => {
  test('the helper never imports Three.js nor touches the DOM', () => {
    const src = readFileSync(
      join(import.meta.dir, '../../web/pages/watcher-self-helpers.js'),
      'utf-8'
    );
    expect(src).not.toMatch(/(from|import\()\s*['"][^'"]*three/i);
    expect(src).not.toContain('document.');
  });
});
