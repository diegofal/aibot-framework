import { describe, expect, it } from 'bun:test';
import {
  EDGE_MIN_WEIGHT,
  KIND_HUES,
  LOG_LIMIT,
  NEURON_KINDS,
  applyWatcherEvent,
  birthDate,
  canStartReplay,
  createWatcherModel,
  drainCount,
  edgeVisible,
  filterLogRows,
  formatDuration,
  formatTokens,
  isWatcherMade,
  isWatcherOff,
  kindLabel,
  legendHtml,
  logListHtml,
  logRowHtml,
  mergeLogRows,
  needsGraphRefetch,
  neuronBrightness,
  neuronColour,
  neuronPosition,
  neuronRadius,
  neuronSheetBody,
  readWatcherMessage,
  reconcileGraph,
  replayQueue,
  shellPosition,
  stateHtml,
  watcherDisabledHtml,
  watcherErrorHtml,
} from '../../web/pages/watcher-helpers.js';

const NOW = Date.parse('2026-10-23T10:00:00Z');
const HOUR = 3_600_000;

function neuron(over: Record<string, unknown> = {}) {
  return {
    id: 'n-00000001',
    kind: 'fact',
    text: 'Invoices from Acme arrive on the 3rd',
    support: { bots: ['jarvis'] },
    createdBy: 'bot:jarvis',
    createdAt: '2026-10-23T09:00:00Z',
    lastActivatedAt: '2026-10-23T09:00:00Z',
    activations: 0,
    pos: [0.1, 0.2, 0.3],
    ...over,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    ts: '2026-10-23T09:59:00Z',
    seq: 1,
    phase: 'birth',
    op: 'birth:fleet',
    text: 'Met jarvis.',
    ...over,
  };
}

function runningState(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    running: true,
    bornAt: '2026-10-22T08:00:00Z',
    phase: 'sense',
    lastTickAt: '2026-10-23T09:59:30Z',
    counts: { entity: 8, person: 3, fact: 640, goal: 0 },
    edges: 3800,
    linkStatus: 'ok',
    ...over,
  };
}

describe('neuronColour', () => {
  it('returns a #rrggbb colour', () => {
    expect(neuronColour(neuron())).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('separates watcher-made from bot-made neurons of the same kind', () => {
    const bot = neuronColour(neuron({ createdBy: 'bot:jarvis' }));
    const watcher = neuronColour(neuron({ createdBy: 'watcher' }));
    expect(bot).not.toBe(watcher);
  });

  it('gives every kind its own hue', () => {
    const colours = NEURON_KINDS.map((kind: string) => neuronColour(neuron({ kind })));
    expect(new Set(colours).size).toBe(NEURON_KINDS.length);
    expect(Object.keys(KIND_HUES).sort()).toEqual([...NEURON_KINDS].sort());
  });

  it('falls back to a neutral colour for an unknown kind', () => {
    expect(neuronColour(neuron({ kind: 'mystery' }))).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('neuronRadius', () => {
  it('grows with activations and is capped', () => {
    const r0 = neuronRadius(neuron({ activations: 0 }));
    const r5 = neuronRadius(neuron({ activations: 5 }));
    const rHuge = neuronRadius(neuron({ activations: 1_000_000 }));
    const rMore = neuronRadius(neuron({ activations: 9_000_000 }));
    expect(r5).toBeGreaterThan(r0);
    expect(rHuge).toBeGreaterThan(r5);
    expect(rMore).toBe(rHuge);
  });

  it('treats a missing or bad activation count as zero', () => {
    expect(neuronRadius(neuron({ activations: undefined }))).toBe(
      neuronRadius(neuron({ activations: 0 }))
    );
    expect(neuronRadius(neuron({ activations: -3 }))).toBe(
      neuronRadius(neuron({ activations: 0 }))
    );
  });
});

describe('neuronBrightness', () => {
  it('is full right after an activation and halves over the half-life', () => {
    const fresh = neuronBrightness(neuron({ lastActivatedAt: new Date(NOW).toISOString() }), NOW);
    const old = neuronBrightness(
      neuron({ lastActivatedAt: new Date(NOW - 6 * HOUR).toISOString() }),
      NOW
    );
    const ancient = neuronBrightness(
      neuron({ lastActivatedAt: new Date(NOW - 1000 * HOUR).toISOString() }),
      NOW
    );
    expect(fresh).toBeCloseTo(1, 5);
    expect(old).toBeLessThan(fresh);
    expect(old).toBeGreaterThan(ancient);
    expect(ancient).toBeGreaterThan(0);
  });

  it('dims an archived neuron below any live one', () => {
    const archived = neuronBrightness(
      neuron({ archivedAt: '2026-10-23T09:00:00Z', lastActivatedAt: new Date(NOW).toISOString() }),
      NOW
    );
    const ancient = neuronBrightness(neuron({ lastActivatedAt: '2020-01-01T00:00:00Z' }), NOW);
    expect(archived).toBeLessThan(ancient);
  });

  it('uses the floor when the timestamp is missing', () => {
    const b = neuronBrightness(neuron({ lastActivatedAt: undefined }), NOW);
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(0.5);
  });
});

describe('neuron positions', () => {
  it('uses the server position when it is three finite numbers', () => {
    expect(neuronPosition(neuron({ pos: [0.5, -0.25, 0] }))).toEqual([0.5, -0.25, 0]);
  });

  it('puts a neuron without pos on its kind shell, deterministically', () => {
    const a = neuronPosition(neuron({ pos: undefined }));
    const b = neuronPosition(neuron({ pos: undefined }));
    expect(a).toEqual(b);
    const len = Math.hypot(...a);
    expect(len).toBeCloseTo(Math.hypot(...shellPosition(neuron())), 6);
    expect(len).toBeLessThanOrEqual(1);
  });

  it('rejects a malformed pos and falls back to the shell', () => {
    const p = neuronPosition(neuron({ pos: [1, 'x', 2] }));
    expect(p).toEqual(shellPosition(neuron()));
  });

  it('uses different shells for different kinds and spreads ids on a shell', () => {
    const fact = Math.hypot(...shellPosition(neuron({ kind: 'fact' })));
    const goal = Math.hypot(...shellPosition(neuron({ kind: 'goal' })));
    expect(fact).not.toBeCloseTo(goal, 3);
    const one = shellPosition(neuron({ id: 'n-aaaaaaaa' }));
    const two = shellPosition(neuron({ id: 'n-bbbbbbbb' }));
    expect(one).not.toEqual(two);
  });
});

describe('edgeVisible', () => {
  it('shows edges at or above the weight bar only', () => {
    expect(edgeVisible({ weight: EDGE_MIN_WEIGHT })).toBe(true);
    expect(edgeVisible({ weight: EDGE_MIN_WEIGHT - 0.01 })).toBe(false);
    expect(edgeVisible({})).toBe(false);
  });
});

describe('logRowHtml', () => {
  it('escapes the text', () => {
    const html = logRowHtml(row({ text: 'Met <b>"x"</b> & y' }), NOW);
    expect(html).toContain('Met &lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; y');
    expect(html).not.toContain('<b>');
  });

  it('carries seq, phase and the neuron ids it names', () => {
    const html = logRowHtml(row({ seq: 42, neuronIds: ['n-1', 'n-2'] }), NOW);
    expect(html).toContain('data-seq="42"');
    expect(html).toContain('data-neurons="n-1 n-2"');
    expect(html).toContain('watcher-phase-birth');
    expect(html).toContain('2 neurons');
  });

  it('omits the neuron attribute when the row names none', () => {
    expect(logRowHtml(row(), NOW)).not.toContain('data-neurons');
  });

  it('shows salience, model, tokens, cost and duration when present', () => {
    const html = logRowHtml(
      row({
        phase: 'integrate',
        salience: 0.7,
        model: 'claude-opus-5-5',
        tokens: 18_400,
        costUsd: 0.123,
        durationMs: 41_000,
      }),
      NOW
    );
    expect(html).toContain('salience 0.70');
    expect(html).toContain('claude-opus-5-5');
    expect(html).toContain('18.4k tokens');
    expect(html).toContain('$0.12');
    expect(html).toContain('41 s');
  });

  it('escapes an unknown phase in the class name', () => {
    const html = logRowHtml(row({ phase: '"><script>' }), NOW);
    expect(html).not.toContain('<script>');
  });

  it('marks the selected row', () => {
    expect(logRowHtml(row({ seq: 3 }), NOW, { selectedSeq: 3 })).toContain('is-selected');
    expect(logRowHtml(row({ seq: 3 }), NOW, { selectedSeq: 4 })).not.toContain('is-selected');
  });

  it('prefixes the date for a row from another day', () => {
    const html = logRowHtml(row({ ts: '2026-10-20T09:00:00Z' }), NOW);
    expect(html).toMatch(/2026-10-(19|20|21)/);
  });
});

describe('filterLogRows and logListHtml', () => {
  const rows = [
    row({ seq: 3, neuronIds: ['n-a'] }),
    row({ seq: 2, neuronIds: ['n-b'] }),
    row({ seq: 1 }),
  ];

  it('keeps only rows that touched the neuron', () => {
    expect(filterLogRows(rows, 'n-a').map((r: { seq: number }) => r.seq)).toEqual([3]);
    expect(filterLogRows(rows, null)).toHaveLength(3);
  });

  it('renders an empty hint when nothing matches', () => {
    expect(logListHtml([], NOW)).toContain('watcher-log-empty');
    expect(logListHtml(rows, NOW, { filterId: 'n-zzz' })).toContain('watcher-log-empty');
  });

  it('renders one row per entry', () => {
    const html = logListHtml(rows, NOW);
    expect(html.match(/<li class="watcher-row/g)?.length).toBe(3);
  });
});

describe('mergeLogRows', () => {
  it('dedupes by seq, keeps newest first and caps', () => {
    const merged = mergeLogRows(
      [row({ seq: 2 }), row({ seq: 1 })],
      [row({ seq: 3 }), row({ seq: 2 })]
    );
    expect(merged.map((r: { seq: number }) => r.seq)).toEqual([3, 2, 1]);
    const many = Array.from({ length: LOG_LIMIT + 10 }, (_, i) => row({ seq: i }));
    expect(mergeLogRows([], many)).toHaveLength(LOG_LIMIT);
    expect(mergeLogRows([], many)[0].seq).toBe(LOG_LIMIT + 9);
  });

  it('drops malformed rows', () => {
    expect(mergeLogRows([], [null, { text: 'no seq' }, row({ seq: 1 })])).toHaveLength(1);
  });
});

describe('stateHtml', () => {
  it('shows running, phase, counts and edges', () => {
    const html = stateHtml(runningState(), NOW);
    expect(html).toContain('Awake');
    expect(html).toContain('sense');
    expect(html).toContain('640');
    expect(html).toContain('fact');
    expect(html).toContain('3,800');
    expect(html).toContain('data-action="watcher-stop"');
    expect(html).not.toContain('data-action="watcher-start"');
  });

  it('skips zero counts', () => {
    expect(stateHtml(runningState(), NOW)).not.toContain('goal');
  });

  it('offers Start when asleep', () => {
    const html = stateHtml(runningState({ running: false }), NOW);
    expect(html).toContain('Asleep');
    expect(html).toContain('data-action="watcher-start"');
  });

  it('explains a missing embeddings link', () => {
    expect(stateHtml(runningState({ linkStatus: 'no-embeddings' }), NOW)).toContain(
      'no embeddings'
    );
  });

  it('explains a partial link in the amber note', () => {
    const html = stateHtml(runningState({ linkStatus: 'partial' }), NOW);
    expect(html).toContain('<div class="watcher-note">');
    expect(html).toContain('partly linked');
  });

  it('escapes the last error', () => {
    const html = stateHtml(runningState({ lastError: '<img src=x>' }), NOW);
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img');
  });

  it('says when it was never born', () => {
    expect(stateHtml(runningState({ bornAt: undefined }), NOW)).toContain('not born yet');
  });
});

describe('disabled and error states', () => {
  it('tells how to turn the watcher on', () => {
    const html = watcherDisabledHtml();
    expect(html).toContain('watcher.enabled');
  });

  it('escapes the error and offers a retry', () => {
    const html = watcherErrorHtml('<x>');
    expect(html).toContain('&lt;x&gt;');
    expect(html).toContain('data-action="watcher-retry"');
  });
});

describe('readWatcherMessage', () => {
  it('reads the history frame', () => {
    const m = readWatcherMessage(
      JSON.stringify({ type: 'history', state: runningState(), log: [row()] })
    );
    expect(m?.kind).toBe('history');
    expect(m?.log).toHaveLength(1);
  });

  it('reads a watcher event frame', () => {
    const event = { type: 'watcher:log', ts: 'x', data: row() };
    const m = readWatcherMessage(JSON.stringify({ type: 'watcher', event }));
    expect(m).toEqual({ kind: 'event', event });
  });

  it('returns null for junk', () => {
    expect(readWatcherMessage('not json')).toBeNull();
    expect(readWatcherMessage(JSON.stringify({ type: 'activity' }))).toBeNull();
    expect(readWatcherMessage(JSON.stringify({ type: 'watcher' }))).toBeNull();
  });

  it('defaults a history frame without a log to an empty list', () => {
    const m = readWatcherMessage(JSON.stringify({ type: 'history', state: runningState() }));
    expect(m?.log).toEqual([]);
  });
});

describe('reconcileGraph', () => {
  function model() {
    return createWatcherModel({
      state: runningState(),
      graph: {
        neurons: [neuron(), neuron({ id: 'n-2', text: 'old' }), neuron({ id: 'n-gone' })],
        edges: [
          { id: 'e-1', from: 'n-00000001', to: 'n-2', rel: 'related', weight: 0.9 },
          { id: 'e-gone', from: 'n-00000001', to: 'n-gone', rel: 'related', weight: 0.9 },
        ],
        rev: 3,
      },
    });
  }

  it('adds missing neurons, updates changed ones, archives removed ones, syncs edges', () => {
    const m = model();
    const out = reconcileGraph(
      m,
      {
        neurons: [neuron(), neuron({ id: 'n-2', text: 'new' }), neuron({ id: 'n-new' })],
        edges: [
          { id: 'e-1', from: 'n-00000001', to: 'n-2', rel: 'related', weight: 0.5 },
          { id: 'e-new', from: 'n-new', to: 'n-2', rel: 'related', weight: 0.9 },
        ],
        rev: 9,
        linkStatus: 'ok',
      },
      { nowIso: '2026-10-23T10:00:00.000Z' }
    );
    expect(out).toEqual({
      added: ['n-new'],
      updated: ['n-2'],
      archived: ['n-gone'],
      edgesChanged: true,
    });
    expect(m.neurons.get('n-2')?.text).toBe('new');
    expect(m.neurons.get('n-new')).toBeDefined();
    expect(m.neurons.get('n-gone')?.archivedAt).toBe('2026-10-23T10:00:00.000Z');
    expect([...m.edges.keys()].sort()).toEqual(['e-1', 'e-new']);
    expect(m.edges.get('e-1')?.weight).toBe(0.5);
    expect(m.rev).toBe(9);
    expect(m.linkStatus).toBe('ok');
  });

  it('an archived neuron in the snapshot is reported as archived, once', () => {
    const m = model();
    const snap = {
      neurons: [
        neuron(),
        neuron({ id: 'n-2', text: 'old', archivedAt: '2026-10-23T09:00:00Z' }),
        neuron({ id: 'n-gone' }),
      ],
      edges: [...m.edges.values()],
      rev: 4,
    };
    expect(reconcileGraph(m, snap).archived).toEqual(['n-2']);
    expect(reconcileGraph(m, snap)).toEqual({
      added: [],
      updated: [],
      archived: [],
      edgesChanged: false,
    });
  });

  it('a junk snapshot changes nothing', () => {
    const m = model();
    expect(reconcileGraph(m, null)).toEqual({
      added: [],
      updated: [],
      archived: [],
      edgesChanged: false,
    });
    expect(m.neurons.size).toBe(3);
  });
});

describe('createWatcherModel', () => {
  it('indexes neurons and edges by id and keeps the log newest first', () => {
    const model = createWatcherModel({
      state: runningState(),
      graph: {
        neurons: [neuron(), neuron({ id: 'n-2' })],
        edges: [{ id: 'e-1', from: 'n-00000001', to: 'n-2', rel: 'related', weight: 0.9 }],
        linkStatus: 'ok',
        rev: 7,
      },
      log: [row({ seq: 1 }), row({ seq: 2 })],
    });
    expect(model.neurons.size).toBe(2);
    expect(model.edges.size).toBe(1);
    expect(model.log.map((r: { seq: number }) => r.seq)).toEqual([2, 1]);
    expect(model.rev).toBe(7);
  });

  it('survives missing parts', () => {
    const model = createWatcherModel({});
    expect(model.neurons.size).toBe(0);
    expect(model.log).toEqual([]);
    expect(model.state).toBeNull();
  });
});

describe('applyWatcherEvent', () => {
  function fresh() {
    return createWatcherModel({ state: runningState(), graph: { neurons: [neuron()], edges: [] } });
  }

  it('adds a new neuron and asks the ball to spawn it, bumping the count', () => {
    const model = fresh();
    const effect = applyWatcherEvent(model, {
      type: 'watcher:neuron',
      ts: 't',
      data: neuron({ id: 'n-new', kind: 'goal' }),
    });
    expect(effect).toEqual({ kind: 'spawn', id: 'n-new' });
    expect(model.neurons.get('n-new')?.kind).toBe('goal');
    expect(model.state.counts.goal).toBe(1);
  });

  it('updates a known neuron and reports archive when it gets archivedAt', () => {
    const model = fresh();
    const effect = applyWatcherEvent(model, {
      type: 'watcher:neuron',
      ts: 't',
      data: neuron({ archivedAt: '2026-10-23T09:30:00Z' }),
    });
    expect(effect).toEqual({ kind: 'archive', id: 'n-00000001' });
    const again = applyWatcherEvent(model, {
      type: 'watcher:neuron',
      ts: 't',
      data: neuron({ archivedAt: '2026-10-23T09:30:00Z', text: 'changed' }),
    });
    expect(again).toEqual({ kind: 'update', id: 'n-00000001' });
    expect(model.neurons.get('n-00000001')?.text).toBe('changed');
  });

  it('records an activation and asks for a pulse', () => {
    const model = fresh();
    const effect = applyWatcherEvent(model, {
      type: 'watcher:activate',
      ts: 't',
      data: { id: 'n-00000001', activations: 4, lastActivatedAt: '2026-10-23T09:59:00Z' },
    });
    expect(effect).toEqual({ kind: 'pulse', id: 'n-00000001' });
    expect(model.neurons.get('n-00000001')?.activations).toBe(4);
    expect(model.neurons.get('n-00000001')?.lastActivatedAt).toBe('2026-10-23T09:59:00Z');
  });

  it('moves every known neuron of a layout event and reports which', () => {
    const model = createWatcherModel({
      state: runningState(),
      graph: { neurons: [neuron(), neuron({ id: 'n-2' })], edges: [] },
    });
    const effect = applyWatcherEvent(model, {
      type: 'watcher:layout',
      ts: 't',
      data: {
        positions: {
          'n-00000001': [0.1, 0.2, 0.3],
          'n-2': [0, 0, -0.4],
          'n-ghost': [1, 1, 1],
          'n-bad': ['x', 0, 0],
        },
      },
    });
    expect(effect).toEqual({ kind: 'layout', ids: ['n-00000001', 'n-2'] });
    expect(model.neurons.get('n-00000001')?.pos).toEqual([0.1, 0.2, 0.3]);
    expect(model.neurons.get('n-2')?.pos).toEqual([0, 0, -0.4]);
    expect(model.neurons.has('n-ghost')).toBe(false);
  });

  it('a layout event without positions is ignored', () => {
    const model = fresh();
    expect(applyWatcherEvent(model, { type: 'watcher:layout', ts: 't', data: {} })).toEqual({
      kind: 'none',
    });
  });

  it('needsGraphRefetch: an activation or edge naming a neuron the page does not have', () => {
    const model = fresh();
    const act = (id: string) => ({ type: 'watcher:activate', ts: 't', data: { id } });
    expect(needsGraphRefetch(model, act('n-ghost'))).toBe(true);
    expect(needsGraphRefetch(model, act('n-00000001'))).toBe(false);
    const edge = (from: string, to: string) => ({
      type: 'watcher:edge',
      ts: 't',
      data: { id: 'e-9', from, to, rel: 'related', weight: 1 },
    });
    expect(needsGraphRefetch(model, edge('n-00000001', 'n-ghost'))).toBe(true);
    expect(needsGraphRefetch(model, edge('n-00000001', 'n-00000001'))).toBe(false);
    expect(needsGraphRefetch(model, { type: 'watcher:log', ts: 't', data: row() })).toBe(false);
    expect(needsGraphRefetch(model, null)).toBe(false);
  });

  it('ignores an activation of an unknown neuron', () => {
    const model = fresh();
    const effect = applyWatcherEvent(model, {
      type: 'watcher:activate',
      ts: 't',
      data: { id: 'n-ghost', activations: 1 },
    });
    expect(effect).toEqual({ kind: 'none' });
  });

  it('adds an edge once and counts it', () => {
    const model = fresh();
    const edge = { id: 'e-1', from: 'n-00000001', to: 'n-00000001', rel: 'related', weight: 1 };
    expect(applyWatcherEvent(model, { type: 'watcher:edge', ts: 't', data: edge })).toEqual({
      kind: 'edge',
      id: 'e-1',
    });
    applyWatcherEvent(model, { type: 'watcher:edge', ts: 't', data: edge });
    expect(model.edges.size).toBe(1);
    expect(model.state.edges).toBe(3801);
  });

  it('prepends a log row and dedupes by seq', () => {
    const model = fresh();
    const effect = applyWatcherEvent(model, {
      type: 'watcher:log',
      ts: 't',
      data: row({ seq: 9 }),
    });
    expect(effect.kind).toBe('log');
    applyWatcherEvent(model, { type: 'watcher:log', ts: 't', data: row({ seq: 9 }) });
    expect(model.log).toHaveLength(1);
  });

  it('replaces the state and keeps it enabled', () => {
    const model = fresh();
    const effect = applyWatcherEvent(model, {
      type: 'watcher:state',
      ts: 't',
      data: { running: false, phase: 'sleep', counts: {}, edges: 0, linkStatus: 'ok' },
    });
    expect(effect).toEqual({ kind: 'state' });
    expect(model.state.running).toBe(false);
    expect(model.state.enabled).toBe(true);
  });

  it('ignores unknown and malformed events', () => {
    const model = fresh();
    expect(applyWatcherEvent(model, { type: 'watcher:nope', ts: 't', data: {} })).toEqual({
      kind: 'none',
    });
    expect(applyWatcherEvent(model, null)).toEqual({ kind: 'none' });
    expect(
      applyWatcherEvent(model, { type: 'watcher:neuron', ts: 't', data: { text: 'x' } })
    ).toEqual({
      kind: 'none',
    });
  });
});

describe('replayQueue', () => {
  it('orders oldest first and spaces spawns at the pace', () => {
    const steps = replayQueue(
      [row({ seq: 2, neuronIds: ['n-b', 'n-c'] }), row({ seq: 1, neuronIds: ['n-a'] })],
      10,
      { rowGapMs: 0 }
    );
    expect(steps.map((s: { type: string; id?: string }) => `${s.type}:${s.id ?? ''}`)).toEqual([
      'row:',
      'spawn:n-a',
      'row:',
      'spawn:n-b',
      'spawn:n-c',
    ]);
    const spawns = steps.filter((s: { type: string }) => s.type === 'spawn');
    expect(spawns.map((s: { atMs: number }) => s.atMs)).toEqual([0, 100, 200]);
  });

  it('pulses a neuron named again instead of spawning it twice', () => {
    const steps = replayQueue(
      [row({ seq: 1, neuronIds: ['n-a'] }), row({ seq: 2, neuronIds: ['n-a'] })],
      25
    );
    expect(steps.filter((s: { type: string }) => s.type === 'spawn')).toHaveLength(1);
    expect(steps.filter((s: { type: string }) => s.type === 'pulse')).toHaveLength(1);
  });

  it('gives a row without neurons a readable gap', () => {
    const steps = replayQueue([row({ seq: 1 }), row({ seq: 2 })], 25, { rowGapMs: 300 });
    expect(steps.map((s: { atMs: number }) => s.atMs)).toEqual([0, 300]);
  });

  it('carries edges right after the spawns of their row', () => {
    const steps = replayQueue([row({ seq: 1, neuronIds: ['n-a'], edgeIds: ['e-1'] })], 25);
    expect(steps.map((s: { type: string }) => s.type)).toEqual(['row', 'spawn', 'edge']);
  });

  it('returns nothing for an empty log and clamps a bad pace', () => {
    expect(replayQueue([], 25)).toEqual([]);
    const steps = replayQueue([row({ seq: 1, neuronIds: ['a', 'b'] })], 0, { rowGapMs: 0 });
    const spawns = steps.filter((s: { type: string }) => s.type === 'spawn');
    expect(spawns[1].atMs).toBeGreaterThan(spawns[0].atMs);
    expect(Number.isFinite(spawns[1].atMs)).toBe(true);
  });
});

describe('drainCount', () => {
  it('drains ~pace per second across frames, carrying the remainder', () => {
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 60; i++) {
      const r = drainCount(carry, 1000 / 60, 25);
      carry = r.carry;
      total += r.n;
    }
    expect(total).toBe(25);
  });

  it('never drains a negative count and caps a long pause', () => {
    expect(drainCount(0, -5, 25).n).toBe(0);
    expect(drainCount(0, 60_000, 25).n).toBeLessThanOrEqual(25);
  });
});

describe('birthDate', () => {
  it('is the day the watcher was born, or null', () => {
    expect(birthDate({ bornAt: '2026-10-22T08:00:00Z' })).toMatch(/^2026-10-2[12]$/);
    expect(birthDate({})).toBeNull();
    expect(birthDate(null)).toBeNull();
  });
});

describe('neuronSheetBody', () => {
  const detail = {
    neuron: neuron({ text: 'A <fact>', activations: 3 }),
    edges: [
      {
        id: 'e-1',
        from: 'n-00000001',
        to: 'n-2',
        rel: 'about',
        weight: 1,
        createdAt: 'x',
        createdBy: 'watcher',
      },
    ],
    why: { what: 'Fact: A fact', by: 'agent' },
  };

  it('renders the shared Why panel, escaped text and the neighbours', () => {
    const html = neuronSheetBody(detail, NOW, {
      textOf: (id: string) => (id === 'n-2' ? 'Acme <co>' : null),
    });
    expect(html).toContain('<details class="why">');
    expect(html).toContain('A &lt;fact&gt;');
    expect(html).toContain('Acme &lt;co&gt;');
    expect(html).toContain('data-watcher-neuron="n-2"');
    expect(html).toContain('about');
    expect(html).toContain('jarvis');
  });

  it('survives a detail without why or edges', () => {
    const html = neuronSheetBody({ neuron: neuron() }, NOW);
    expect(html).toContain('Invoices from Acme');
    expect(html).not.toContain('<details class="why">');
  });
});

describe('small formatters', () => {
  it('kindLabel pluralises', () => {
    expect(kindLabel('fact', 1)).toBe('fact');
    expect(kindLabel('fact', 2)).toBe('facts');
    expect(kindLabel('person', 3)).toBe('people');
    expect(kindLabel('entity', 0)).toBe('entities');
  });

  it('formatTokens and formatDuration', () => {
    expect(formatTokens(950)).toBe('950 tokens');
    expect(formatTokens(2000)).toBe('2k tokens');
    expect(formatTokens('x')).toBe('');
    expect(formatDuration(250)).toBe('250 ms');
    expect(formatDuration(130_000)).toBe('2 min 10 s');
    expect(formatDuration(-1)).toBe('');
  });

  it('isWatcherMade reads createdBy', () => {
    expect(isWatcherMade({ createdBy: 'watcher' })).toBe(true);
    expect(isWatcherMade({ createdBy: 'bot:jarvis' })).toBe(false);
    expect(isWatcherMade(null)).toBe(false);
  });

  it('legendHtml lists every kind and both origins', () => {
    const html = legendHtml();
    for (const k of NEURON_KINDS) expect(html).toContain(`</i>${k}</span>`);
    expect(html).toContain('from a bot');
    expect(html).toContain("the watcher's own");
  });
});

describe('isWatcherOff', () => {
  it('is true only for an { enabled: false } answer (GET / or any 404 while off)', () => {
    expect(isWatcherOff({ enabled: false })).toBe(true);
    expect(isWatcherOff({ enabled: false, error: 'The watcher is off' })).toBe(true);
    expect(isWatcherOff({ enabled: true, running: true })).toBe(false);
    expect(isWatcherOff({ error: 'Not found' })).toBe(false);
    expect(isWatcherOff(null)).toBe(false);
    expect(isWatcherOff(undefined)).toBe(false);
    expect(isWatcherOff('nope')).toBe(false);
  });
});

describe('canStartReplay (no double start)', () => {
  it('needs the ball, no replay running and none loading', () => {
    const ball = {};
    expect(canStartReplay({ ball, replay: null, replayLoading: false })).toBe(true);
    expect(canStartReplay({ ball: null, replay: null })).toBe(false);
    expect(canStartReplay({ ball, replay: { steps: [] } })).toBe(false);
    // A second click while the first is still fetching the day's log.
    expect(canStartReplay({ ball, replay: null, replayLoading: true })).toBe(false);
    expect(canStartReplay(null)).toBe(false);
  });
});
