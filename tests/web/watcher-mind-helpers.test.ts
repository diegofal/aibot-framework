import { describe, expect, test } from 'bun:test';
import {
  MIND_PAGE_SIZE,
  MIND_TABS,
  broadcastStatus,
  contradictionSides,
  highlightDims,
  highlightFor,
  highlightState,
  kindFilterIds,
  mindCounts,
  mindListHtml,
  mindMoreFocusIndex,
  mindRows,
  mindTabBlurb,
  mindTabState,
  mindTabsHtml,
  predictionOutcome,
  refocusOnEffect,
} from '../../web/pages/watcher-mind-helpers.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');

const n = (id: string, kind: string, createdAt: string, over: Record<string, unknown> = {}) => ({
  id,
  kind,
  text: `text ${id}`,
  support: { bots: ['b1', 'b2'] },
  createdBy: 'watcher',
  createdAt,
  lastActivatedAt: createdAt,
  activations: 3,
  ...over,
});

const bc = (over: Record<string, unknown> = {}) => ({
  id: 'b-1',
  botId: 'scout',
  kind: 'directive',
  text: 'Coordinate with Jarvis',
  insightId: 'n-1',
  createdAt: '2026-10-24T10:00:00Z',
  deliveredAt: '2026-10-24T10:00:00Z',
  why: { what: 'Directive to Scout', by: 'watcher' },
  ...over,
});

describe('MIND_TABS', () => {
  test('one tab per kind the operator reads, in the agreed order, each with a blurb', () => {
    expect(MIND_TABS.map((t) => t.label)).toEqual([
      'Insights',
      'Predictions',
      'Patterns',
      'Broadcasts',
      'Contradictions',
      'Surprises',
      'Questions',
      'Topics',
      'Facts',
      'Summaries',
      'People',
      'Goals',
    ]);
    for (const t of MIND_TABS) expect(t.blurb.length).toBeGreaterThan(20);
    expect(mindTabBlurb('prediction')).toContain('0.25 is a coin flip');
    expect(mindTabBlurb('nope')).toBe('');
  });
});

describe('mindCounts', () => {
  test('live neurons per kind, broadcasts from the list; archived do not count', () => {
    const counts = mindCounts(
      [
        n('n-1', 'insight', '2026-10-24T10:00:00Z'),
        n('n-2', 'insight', '2026-10-24T10:00:00Z', { archivedAt: '2026-10-24T11:00:00Z' }),
        n('n-3', 'fact', '2026-10-24T10:00:00Z'),
      ],
      [bc(), bc({ id: 'b-2' })]
    );
    expect(counts.insight).toBe(1);
    expect(counts.fact).toBe(1);
    expect(counts.broadcast).toBe(2);
    expect(counts.person).toBe(0);
  });
});

describe('mindRows', () => {
  const neurons = [
    n('n-1', 'fact', '2026-10-24T09:00:00Z', { text: 'Invoices go out on Monday' }),
    n('n-2', 'fact', '2026-10-24T11:00:00Z', { text: 'The client pays late' }),
    n('n-3', 'fact', '2026-10-24T10:00:00Z', { archivedAt: '2026-10-24T11:00:00Z' }),
    n('n-4', 'topic', '2026-10-24T11:30:00Z'),
  ];

  test('one kind, live only, newest first', () => {
    expect(mindRows('fact', { neurons }).map((r) => r.id)).toEqual(['n-2', 'n-1']);
  });

  test('search matches text and supporting bots, case-insensitive', () => {
    expect(mindRows('fact', { neurons, query: 'INVOICE' }).map((r) => r.id)).toEqual(['n-1']);
    expect(mindRows('fact', { neurons, query: 'b2' })).toHaveLength(2);
    expect(mindRows('fact', { neurons, query: 'zzz' })).toHaveLength(0);
  });

  test('broadcasts come from the list, searchable by bot and kind', () => {
    const broadcasts = [
      bc({ id: 'b-1', createdAt: '2026-10-24T08:00:00Z' }),
      bc({ id: 'b-2', botId: 'jarvis', kind: 'wake', createdAt: '2026-10-24T09:00:00Z' }),
    ];
    expect(mindRows('broadcast', { broadcasts }).map((r) => r.id)).toEqual(['b-2', 'b-1']);
    expect(mindRows('broadcast', { broadcasts, query: 'wake' }).map((r) => r.id)).toEqual(['b-2']);
  });
});

describe('predictionOutcome / broadcastStatus', () => {
  test('pending, happened, did not happen', () => {
    expect(predictionOutcome(n('n-1', 'prediction', 'x', { meta: {} }))).toBe('pending');
    expect(
      predictionOutcome(
        n('n-1', 'prediction', 'x', { meta: { resolvedAt: 'y', happened: 'true' } })
      )
    ).toBe('happened');
    expect(
      predictionOutcome(
        n('n-1', 'prediction', 'x', { meta: { resolvedAt: 'y', happened: 'false' } })
      )
    ).toBe('missed');
    expect(
      predictionOutcome(
        n('n-1', 'prediction', 'x', { meta: { resolvedAt: 'y', outcome: 'unknown' } })
      )
    ).toBe('unknown');
  });

  test('delivered, deferred, failed', () => {
    expect(broadcastStatus(bc())).toBe('delivered');
    expect(broadcastStatus(bc({ deliveredAt: undefined, deferred: true }))).toBe('deferred');
    expect(broadcastStatus(bc({ deliveredAt: undefined }))).toBe('failed');
  });
});

describe('contradictionSides', () => {
  test('the two neurons its contradicts edges point at, with their text', () => {
    const edges = [
      { id: 'e-1', from: 'n-c', to: 'n-a', rel: 'contradicts', weight: 1 },
      { id: 'e-2', from: 'n-c', to: 'n-b', rel: 'contradicts', weight: 1 },
      { id: 'e-3', from: 'n-c', to: 'n-z', rel: 'owned_by', weight: 1 },
    ];
    const text = { 'n-a': 'Jarvis says yes', 'n-b': 'Scout says no' } as Record<string, string>;
    expect(contradictionSides('n-c', edges, (id: string) => text[id] ?? null)).toEqual([
      { id: 'n-a', text: 'Jarvis says yes' },
      { id: 'n-b', text: 'Scout says no' },
    ]);
    expect(contradictionSides('n-x', edges, () => null)).toEqual([]);
  });
});

describe('kindFilterIds', () => {
  test('live ids of one kind; no kind → empty', () => {
    const neurons = [
      n('n-1', 'goal', 'x'),
      n('n-2', 'goal', 'x', { archivedAt: 'y' }),
      n('n-3', 'fact', 'x'),
    ];
    expect(kindFilterIds(neurons, 'goal')).toEqual(['n-1']);
    expect(kindFilterIds(neurons, null)).toEqual([]);
  });
});

describe('mindTabsHtml', () => {
  test('a tab button per kind with its count; the active one pressed', () => {
    const html = mindTabsHtml({ insight: 4, prediction: 2 }, 'prediction');
    expect(html).toContain('data-mind-tab="insight"');
    expect(html).toMatch(/data-mind-tab="prediction"[^>]*aria-selected="true"/);
    expect(html).toMatch(/Insights<\/span><b[^>]*>4<\/b>/);
    expect(html).toMatch(/Facts<\/span><b[^>]*>0<\/b>/);
  });
});

describe('mindListHtml', () => {
  test('a prediction: probability, due, pending badge, open button', () => {
    const p = n('n-p', 'prediction', '2026-10-24T10:00:00Z', {
      meta: { probability: '0.7', horizonHours: '24', dueAt: '2026-10-24T17:00:00Z' },
    });
    const html = mindListHtml('prediction', [p], { nowMs: NOW });
    expect(html).toContain('70 %');
    expect(html).toContain('due in 5 h');
    expect(html).toContain('pending');
    expect(html).toContain('data-mind-open="n-p"');
  });

  test('a resolved prediction: outcome, Brier, evidence in a fold', () => {
    const p = n('n-p', 'prediction', '2026-10-23T10:00:00Z', {
      meta: {
        probability: '0.2',
        dueAt: '2026-10-24T10:00:00Z',
        resolvedAt: '2026-10-24T10:05:00Z',
        happened: 'false',
        brier: '0.04',
        evidence: 'No cycle served the goal',
      },
    });
    const html = mindListHtml('prediction', [p], { nowMs: NOW });
    expect(html).toContain('did not happen');
    expect(html).toContain('Brier 0.04');
    expect(html).toContain('No cycle served the goal');
    expect(html).toContain('data-open-key="n-p:evidence"');
    const open = mindListHtml('prediction', [p], { nowMs: NOW, open: new Set(['n-p:evidence']) });
    expect(open).toContain('<details class="watcher-mind-fold" open>');
  });

  test('a prediction the judge could not settle: unknown, no Brier, evidence kept', () => {
    const p = n('n-p', 'prediction', '2026-10-23T10:00:00Z', {
      meta: {
        probability: '0.7',
        dueAt: '2026-10-24T10:00:00Z',
        resolvedAt: '2026-10-24T10:05:00Z',
        outcome: 'unknown',
        evidence: 'No tool calls, cycles or watcher records about Job Seeker',
      },
    });
    const html = mindListHtml('prediction', [p], { nowMs: NOW });
    expect(html).toContain('unknown');
    expect(html).not.toContain('did not happen');
    expect(html).not.toContain('Brier');
    expect(html).toContain('No tool calls, cycles or watcher records about Job Seeker');
  });

  test('an insight: bots, confidence, broadcast status or why not, signals', () => {
    const i = n('n-1', 'insight', '2026-10-24T10:00:00Z', { confidence: 'high' });
    const sent = mindListHtml('insight', [i], { nowMs: NOW, broadcasts: [bc()] });
    expect(sent).toContain('b1, b2');
    expect(sent).toContain('high');
    expect(sent).toContain('broadcast to scout');
    expect(sent).toContain('data-watcher-signal="up"');
    expect(sent).toContain('data-signal-id="n-1"');
    const held = mindListHtml(
      'insight',
      [n('n-2', 'insight', '2026-10-24T10:00:00Z', { meta: { whyNoBroadcast: 'Only one bot' } })],
      { nowMs: NOW, broadcasts: [] }
    );
    expect(held).toContain('not broadcast: Only one bot');
  });

  test('an insight older than the oldest fetched broadcast, with the list capped: status unknown', () => {
    const capped = [
      bc({ id: 'b-2', insightId: 'n-8', createdAt: '2026-10-24T12:00:00Z' }),
      bc({ id: 'b-3', insightId: 'n-9', createdAt: '2026-10-24T11:00:00Z' }),
    ];
    const old = n('n-1', 'insight', '2026-10-24T09:00:00Z');
    const html = mindListHtml('insight', [old], {
      nowMs: NOW,
      broadcasts: capped,
      broadcastLimit: 2,
    });
    expect(html).toContain('broadcast status unknown (older than the last 2 broadcasts)');
    expect(html).not.toContain('>not broadcast<');
    // Newer than the oldest fetched broadcast: any broadcast of it would be in the list.
    const fresh = n('n-1', 'insight', '2026-10-24T11:30:00Z');
    expect(
      mindListHtml('insight', [fresh], { nowMs: NOW, broadcasts: capped, broadcastLimit: 2 })
    ).toContain('>not broadcast<');
    // Under the cap the list is complete: an old insight is still "not broadcast".
    expect(
      mindListHtml('insight', [old], { nowMs: NOW, broadcasts: capped, broadcastLimit: 200 })
    ).toContain('>not broadcast<');
    // A recorded reason wins over the guess.
    const why = n('n-1', 'insight', '2026-10-24T09:00:00Z', {
      meta: { whyNoBroadcast: 'Only one bot' },
    });
    expect(
      mindListHtml('insight', [why], { nowMs: NOW, broadcasts: capped, broadcastLimit: 2 })
    ).toContain('not broadcast: Only one bot');
  });

  test('a broadcast: target bot, kind, status, Open cycle, Why through the shared panel', () => {
    const html = mindListHtml(
      'broadcast',
      [bc({ servedByCycle: 'c-9', servedAt: '2026-10-24T11:00:00Z' })],
      { nowMs: NOW }
    );
    expect(html).toContain('scout');
    expect(html).toContain('directive');
    expect(html).toContain('delivered');
    expect(html).toContain('data-open-cycle="c-9"');
    expect(html).toContain('data-bot-id="scout"');
    expect(html).toContain('class="why');
    expect(html).toContain('data-open-key="b-1:why"');
    expect(html).not.toMatch(/<details class="why"[^>]*open/);
    expect(html).toContain('data-mind-open="n-1"');
    expect(html).toContain('data-signal-id="b-1"');
    const failed = mindListHtml(
      'broadcast',
      [bc({ deliveredAt: undefined, deliveryError: 'chat not found' })],
      { nowMs: NOW }
    );
    expect(failed).toContain('failed');
    expect(failed).toContain('chat not found');
    const held = mindListHtml('broadcast', [bc({ deliveredAt: undefined, deferred: true })], {
      nowMs: NOW,
    });
    expect(held).toContain('deferred');
  });

  test('a broadcast Why fold stays open when its key is in the open set', () => {
    const open = mindListHtml('broadcast', [bc()], { nowMs: NOW, open: new Set(['b-1:why']) });
    expect(open).toMatch(/data-open-key="b-1:why"><details class="why" open>/);
    const other = mindListHtml('broadcast', [bc()], { nowMs: NOW, open: new Set(['b-2:why']) });
    expect(other).not.toMatch(/<details class="why"[^>]*open/);
  });

  test('a contradiction: both sides and Confirm / Dismiss', () => {
    const c = n('n-c', 'contradiction', '2026-10-24T10:00:00Z');
    const html = mindListHtml('contradiction', [c], {
      nowMs: NOW,
      sidesOf: () => [
        { id: 'n-a', text: 'Jarvis says yes' },
        { id: 'n-b', text: 'Scout says no' },
      ],
    });
    expect(html).toContain('Jarvis says yes');
    expect(html).toContain('Scout says no');
    expect(html).toContain('data-mind-open="n-a"');
    expect(html).toContain('Confirm');
    expect(html).toContain('Dismiss');
  });

  test('other kinds: text, supporting bots, created, activations; no signals', () => {
    const html = mindListHtml('fact', [n('n-f', 'fact', '2026-10-24T10:00:00Z')], { nowMs: NOW });
    expect(html).toContain('text n-f');
    expect(html).toContain('b1, b2');
    expect(html).toContain('2 h ago');
    expect(html).toContain('3 activations');
    expect(html).not.toContain('data-watcher-signal');
  });

  test('pages 50 at a time with a "Show more" button; empty and no-match say so', () => {
    const many = Array.from({ length: 120 }, (_, i) => n(`n-${i}`, 'fact', '2026-10-24T10:00:00Z'));
    expect(MIND_PAGE_SIZE).toBe(50);
    const first = mindListHtml('fact', many, { nowMs: NOW });
    expect(first.match(/class="watcher-mind-row/g)).toHaveLength(50);
    expect(first).toContain('Showing 50 of 120');
    expect(first).toContain('data-action="watcher-mind-more"');
    const all = mindListHtml('fact', many, { nowMs: NOW, shown: 150 });
    expect(all.match(/class="watcher-mind-row/g)).toHaveLength(120);
    expect(all).not.toContain('watcher-mind-more');
    expect(mindListHtml('fact', [], { nowMs: NOW })).toContain('No facts yet');
    expect(mindListHtml('fact', [], { nowMs: NOW, query: 'x' })).toContain('Nothing matches');
  });

  test('escapes neuron text', () => {
    const html = mindListHtml(
      'fact',
      [n('n-f', 'fact', '2026-10-24T10:00:00Z', { text: '<script>x</script>' })],
      { nowMs: NOW }
    );
    expect(html).not.toContain('<script>');
  });

  test('escapes model- and bot-written strings in every row kind', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const safe = (html: string) => {
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    };
    safe(
      mindListHtml('fact', [n('n-f', 'fact', '2026-10-24T10:00:00Z', { text: evil })], {
        nowMs: NOW,
      })
    );
    safe(
      mindListHtml(
        'prediction',
        [
          n('n-p', 'prediction', '2026-10-24T10:00:00Z', {
            text: evil,
            meta: { resolvedAt: '2026-10-24T11:00:00Z', happened: 'true', evidence: evil },
          }),
        ],
        { nowMs: NOW }
      )
    );
    safe(
      mindListHtml(
        'insight',
        [
          n('n-i', 'insight', '2026-10-24T10:00:00Z', {
            text: evil,
            confidence: evil,
            support: { bots: [evil] },
            meta: { whyNoBroadcast: evil },
          }),
        ],
        { nowMs: NOW, broadcasts: [] }
      )
    );
    safe(
      mindListHtml('insight', [n('n-1', 'insight', '2026-10-24T10:00:00Z', { text: evil })], {
        nowMs: NOW,
        broadcasts: [bc({ botId: evil })],
      })
    );
    safe(
      mindListHtml(
        'broadcast',
        [bc({ text: evil, botId: evil, kind: evil, deliveredAt: undefined, deliveryError: evil })],
        { nowMs: NOW }
      )
    );
    safe(
      mindListHtml('broadcast', [bc({ text: evil, insightId: undefined, why: { what: evil } })], {
        nowMs: NOW,
      })
    );
    safe(
      mindListHtml(
        'contradiction',
        [n('n-c', 'contradiction', '2026-10-24T10:00:00Z', { text: evil })],
        {
          nowMs: NOW,
          sidesOf: () => [{ id: 'n-a', text: evil }],
        }
      )
    );
  });
});

describe('highlightState', () => {
  const none = { kindFilter: null, selectedSeq: null, selectedIds: [], filterId: null };

  test('picking a legend kind clears the neuron and row selection', () => {
    const selected = { ...none, selectedSeq: 4, selectedIds: ['n-1'], filterId: 'n-2' };
    expect(highlightState(selected, { type: 'kind', kind: 'goal' })).toEqual({
      ...none,
      kindFilter: 'goal',
    });
  });

  test('the same kind again clears it', () => {
    expect(highlightState({ ...none, kindFilter: 'goal' }, { type: 'kind', kind: 'goal' })).toEqual(
      none
    );
  });

  test('selecting a neuron or a log row clears the kind filter', () => {
    const kind = { ...none, kindFilter: 'goal' };
    expect(highlightState(kind, { type: 'neuron', id: 'n-1' })).toEqual({
      ...none,
      filterId: 'n-1',
    });
    expect(highlightState(kind, { type: 'row', seq: 7, ids: ['n-1', 'n-2'] })).toEqual({
      ...none,
      selectedSeq: 7,
      selectedIds: ['n-1', 'n-2'],
    });
  });

  test('a row inside a neuron filter keeps the filter; the same row again deselects it', () => {
    const filtered = { ...none, filterId: 'n-1' };
    const row = highlightState(filtered, { type: 'row', seq: 7, ids: ['n-1', 'n-3'] });
    expect(row).toEqual({ ...none, filterId: 'n-1', selectedSeq: 7, selectedIds: ['n-1', 'n-3'] });
    expect(highlightState(row, { type: 'row', seq: 7, ids: ['n-1', 'n-3'] })).toEqual(filtered);
  });

  test('clear drops the selection and keeps the kind', () => {
    expect(
      highlightState(
        { ...none, filterId: 'n-1', selectedSeq: 2, selectedIds: ['x'] },
        { type: 'clear' }
      )
    ).toEqual(none);
    expect(highlightState({ ...none, kindFilter: 'goal' }, { type: 'clear' })).toEqual({
      ...none,
      kindFilter: 'goal',
    });
  });

  test('a replay start drops the legend kind (the replayed ball starts empty) and keeps the selection', () => {
    expect(
      highlightState({ ...none, kindFilter: 'goal', filterId: 'n-1' }, { type: 'replay' })
    ).toEqual({ ...none, filterId: 'n-1' });
    expect(highlightState(none, { type: 'replay' })).toEqual(none);
  });
});

describe('refocusOnEffect', () => {
  test('a spawn or archive re-lights the ball only while a legend kind is selected', () => {
    expect(refocusOnEffect('spawn', 'insight')).toBe(true);
    expect(refocusOnEffect('archive', 'insight')).toBe(true);
    expect(refocusOnEffect('spawn', null)).toBe(false);
    expect(refocusOnEffect('update', 'insight')).toBe(false);
    expect(refocusOnEffect('edge', 'insight')).toBe(false);
  });

  test('an archived neuron that comes back to life re-lights the legend kind', () => {
    expect(refocusOnEffect('revive', 'insight')).toBe(true);
    expect(refocusOnEffect('revive', null)).toBe(false);
  });
});

describe('highlightFor', () => {
  const neurons = [n('n-1', 'goal', 'x'), n('n-2', 'goal', 'x'), n('n-3', 'fact', 'x')];
  const attention = { focusNeuronIds: ['n-3'] };

  test('a selected row lights its neurons; else a neuron filter lights that neuron', () => {
    const sel = { selectedSeq: 1, selectedIds: ['n-2'], filterId: 'n-1' };
    expect(highlightFor({ ...sel, neurons, attention })).toEqual(['n-2']);
    expect(highlightFor({ filterId: 'n-1', neurons, attention })).toEqual(['n-1']);
  });

  test('a legend kind lights that kind', () => {
    expect(highlightFor({ kindFilter: 'goal', neurons, attention })).toEqual(['n-1', 'n-2']);
  });

  test('nothing picked: what the watcher attends to', () => {
    expect(highlightFor({ neurons, attention })).toEqual(['n-3']);
    expect(highlightFor({ neurons })).toEqual([]);
  });
});

describe('highlightDims', () => {
  test('a legend kind dims the ball even when none of its neurons is live', () => {
    const neurons = [n('n-1', 'fact', 'x')];
    expect(highlightFor({ kindFilter: 'goal', neurons })).toEqual([]);
    expect(highlightDims({ kindFilter: 'goal' })).toBe(true);
  });

  test('no kind, or a selection over the kind, keeps the old behaviour', () => {
    expect(highlightDims({})).toBe(false);
    expect(highlightDims({ kindFilter: null })).toBe(false);
    expect(highlightDims({ kindFilter: 'goal', selectedSeq: 3 })).toBe(false);
    expect(highlightDims({ kindFilter: 'goal', filterId: 'n-1' })).toBe(false);
    expect(highlightDims({ kindFilter: 'goal', selectedSeq: 0 })).toBe(false);
  });
});

describe('mindTabState', () => {
  test('one entry per tab, in tab order, with the formatted count and the active flag', () => {
    const st = mindTabState({ insight: 1234, prediction: 2 }, 'prediction');
    expect(st.map((t) => t.kind)).toEqual(MIND_TABS.map((t) => t.kind));
    expect(st[0]).toEqual({ kind: 'insight', count: '1,234', active: false });
    expect(st[1]).toEqual({ kind: 'prediction', count: '2', active: true });
    expect(st.filter((t) => t.active)).toHaveLength(1);
  });

  test('missing counts are zero; an unknown active tab marks none', () => {
    const st = mindTabState(null, 'nope');
    expect(st.every((t) => t.count === '0' && !t.active)).toBe(true);
  });

  test('mindTabsHtml renders the same state', () => {
    const html = mindTabsHtml({ insight: 1234 }, 'insight');
    expect(html).toContain('<b class="watcher-mind-count">1,234</b>');
    expect(html).toMatch(/data-mind-tab="insight" aria-selected="true"/);
  });
});

describe('Summaries tab', () => {
  const member = n('n-m1', 'fact', '2026-10-24T03:00:00Z', {
    text: 'deploy 2 <failed>',
    archivedAt: '2026-10-24T04:00:00Z',
  });
  const summary = n('n-s', 'summary', '2026-10-24T04:00:00Z', {
    text: 'Deploys failed on a stale cache',
    meta: { consolidated: 'true', members: 'n-m1,n-gone' },
  });
  const archived = n('n-s0', 'summary', '2026-10-23T04:00:00Z', {
    archivedAt: '2026-10-24T05:00:00Z',
  });

  test('lists live summaries only, counted like any kind', () => {
    const neurons = [member, summary, archived];
    expect(mindRows('summary', { neurons }).map((r) => r.id)).toEqual(['n-s']);
    expect(mindCounts(neurons, []).summary).toBe(1);
    expect(mindTabBlurb('summary')).toContain('Consolidated');
  });

  test('a row opens the summary and keeps the facts it replaced in a fold', () => {
    const byId = new Map([member, summary].map((x) => [x.id, x]));
    const html = mindListHtml('summary', [summary], {
      nowMs: NOW,
      neuronOf: (id: string) => byId.get(id) ?? null,
      open: new Set(['n-s:members']),
    });
    expect(html).toContain('data-mind-open="n-s"');
    expect(html).toContain('data-open-key="n-s:members"');
    expect(html).toContain('<summary>2 facts</summary>');
    expect(html).toMatch(/<details class="watcher-mind-fold" open>/);
    expect(html).toContain('data-mind-open="n-m1"');
    expect(html).toContain('deploy 2 &lt;failed&gt;');
    // a member the page does not hold is named by id
    expect(html).toContain('n-gone');
    expect(html).toContain('b1, b2');
  });

  test('no summaries yet says so', () => {
    expect(mindListHtml('summary', [], { nowMs: NOW })).toContain('No summaries yet.');
  });
});

describe('mindMoreFocusIndex', () => {
  test('after Show more, focus goes to the first newly shown row', () => {
    expect(mindMoreFocusIndex(MIND_PAGE_SIZE, 120)).toBe(MIND_PAGE_SIZE);
    expect(mindMoreFocusIndex(MIND_PAGE_SIZE * 2, 120)).toBe(MIND_PAGE_SIZE * 2);
  });

  test('nothing new shown (the list shrank) leaves focus alone', () => {
    expect(mindMoreFocusIndex(MIND_PAGE_SIZE, MIND_PAGE_SIZE)).toBeNull();
    expect(mindMoreFocusIndex(MIND_PAGE_SIZE, 10)).toBeNull();
    expect(mindMoreFocusIndex(Number.NaN, 120)).toBeNull();
  });
});
