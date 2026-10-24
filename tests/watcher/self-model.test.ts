import { describe, expect, test } from 'bun:test';
import {
  ATTENTION_MAX_ITEMS,
  attention,
  fleetFocusTexts,
  interoception,
  lastOperatorMs,
} from '../../src/watcher/self-model';
import type { BufferItem, Neuron, SensedEvent } from '../../src/watcher/types';

const NOW = Date.parse('2026-10-23T10:00:00Z');
const HOUR = 3_600_000;
const usage = (calls: number, tokens = 0, costUsd = 0) => ({ calls, tokens, costUsd });

let seq = 0;
function item(salience: number, extra: Partial<BufferItem> = {}): BufferItem {
  seq++;
  const event: SensedEvent = {
    type: 'agent:result',
    botId: 'b1',
    timestamp: NOW,
    data: {},
  } as SensedEvent;
  return {
    id: `b-${String(seq).padStart(8, '0')}`,
    event,
    salience,
    reasons: ['novel'],
    noticedAt: new Date(NOW - HOUR).toISOString(),
    touched: [],
    ...extra,
  };
}

function neuron(id: string, text: string, meta?: Record<string, string>): Neuron {
  return {
    id,
    kind: 'insight',
    text,
    support: { bots: ['b1'] },
    createdBy: 'watcher',
    createdAt: new Date(NOW).toISOString(),
    lastActivatedAt: new Date(NOW).toISOString(),
    activations: 1,
    ...(meta ? { meta } : {}),
  };
}

describe('interoception', () => {
  test('reads every variable from the injected readers', () => {
    const i = interoception({
      nowMs: NOW,
      karmaScores: () => [40, 60],
      backends: ['claude-cli', 'ollama'],
      isCircuitOpen: (b) => b === 'ollama',
      semaphore: () => ({
        limit: 3,
        active: 2,
        queued: 1,
        queuedByPriority: { interactive: 1, loop: 0, worker: 0, watcher: 0 },
        activeByPriority: { interactive: 1, loop: 0, worker: 0, watcher: 1 },
      }),
      budget: { notice: usage(4, 1000, 0.01), integrate: usage(2, 5000, 0.2) },
      lastOperatorAt: NOW - 5 * HOUR,
      bufferItems: [item(0.5), item(1.25)],
      lastIntegrateAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(i).toEqual({
      fleetKarmaAvg: 50,
      breakerOpen: ['ollama'],
      semaphore: { limit: 3, active: 2, queued: 1, queuedInteractive: 1, activeWatcher: 1 },
      budgetUsedToday: { notice: 4, integrate: 2, tokens: 6000, usd: 0.21 },
      operatorSilenceHours: 5,
      bufferSalience: 1.75,
      lastIntegrateAgoMs: 60_000,
    });
  });

  test('readers that are absent or throw give nulls, never an exception', () => {
    const i = interoception({
      nowMs: NOW,
      karmaScores: () => {
        throw new Error('karma down');
      },
      backends: ['claude-cli'],
      isCircuitOpen: () => {
        throw new Error('breaker down');
      },
      semaphore: () => {
        throw new Error('no semaphore');
      },
      budget: { notice: usage(0), integrate: usage(0) },
      bufferItems: [],
    });
    expect(i).toEqual({
      fleetKarmaAvg: null,
      breakerOpen: [],
      semaphore: null,
      budgetUsedToday: { notice: 0, integrate: 0, tokens: 0, usd: 0 },
      operatorSilenceHours: null,
      bufferSalience: 0,
      lastIntegrateAgoMs: null,
    });
  });

  test('an empty karma list is null, not NaN', () => {
    const i = interoception({
      nowMs: NOW,
      karmaScores: () => [],
      budget: { notice: usage(0), integrate: usage(0) },
      bufferItems: [],
    });
    expect(i.fleetKarmaAvg).toBeNull();
  });
});

describe('lastOperatorMs', () => {
  test('the newest operator item, ignoring everyone else', () => {
    const items = [
      item(1, { noticedAt: new Date(NOW - 9 * HOUR).toISOString(), fromOperator: true }),
      item(1, { noticedAt: new Date(NOW - 1 * HOUR).toISOString() }),
      item(1, { noticedAt: new Date(NOW - 3 * HOUR).toISOString(), fromOperator: true }),
    ];
    expect(lastOperatorMs(items)).toBe(NOW - 3 * HOUR);
  });

  test('null when the operator wrote nothing, and a previous value wins when newer', () => {
    expect(lastOperatorMs([item(1)])).toBeNull();
    const old = item(1, { noticedAt: new Date(NOW - 9 * HOUR).toISOString(), fromOperator: true });
    expect(lastOperatorMs([old], NOW - HOUR)).toBe(NOW - HOUR);
  });
});

describe('attention', () => {
  const graph = (ns: Neuron[]) => ({ get: (id: string) => ns.find((n) => n.id === id) });

  test('picks the top items by salience with the neurons they touched', () => {
    const a = neuron('n-aaaaaaaa', 'Acme matters to two bots');
    const items = [1, 5, 3, 2, 4, 0.5, 6].map((s) => item(s, { touched: ['n-aaaaaaaa'] }));
    const att = attention({
      phase: 'sense',
      items,
      graph: graph([a]),
      attending: [],
      botName: () => 'Jarvis',
    });
    expect(att.phase).toBe('sense');
    expect(att.items).toHaveLength(ATTENTION_MAX_ITEMS);
    expect(att.items.map((i) => i.salience)).toEqual([6, 5, 4, 3, 2]);
    expect(att.items[0]?.touched).toEqual([
      { id: 'n-aaaaaaaa', kind: 'insight', text: 'Acme matters to two bots' },
    ]);
    expect(att.items[0]?.what).toBe('Jarvis finished a cycle');
  });

  // Review 2026-10-24 (privacy): pass records clip per line; a multi-line
  // operator message must be one line wherever a prompt shows it.
  test('a multi-line operator message is one line', () => {
    const op = item(9, {
      fromOperator: true,
      event: {
        botId: 'b1',
        channelKind: 'dashboard',
        chatId: 'operator',
        userId: 'operator',
        timestamp: 0,
        text: 'first line\nsecond line\n\nthird line',
      },
    } as never);
    const att = attention({ phase: 'sense', items: [op], graph: graph([]), attending: [] });
    expect(att.items[0]?.what).toContain('first line second line third line');
  });

  test('dedupes items by id and drops touched ids the graph does not know', () => {
    const one = item(2, { touched: ['n-missing'] });
    const att = attention({ phase: 'sense', items: [one, one], graph: graph([]), attending: [] });
    expect(att.items).toHaveLength(1);
    expect(att.items[0]?.touched).toEqual([]);
  });

  test('focus comes from the last integrate pass, archived and unknown ids left out', () => {
    const a = neuron('n-aaaaaaaa', 'one');
    const b = { ...neuron('n-bbbbbbbb', 'two'), archivedAt: new Date(NOW).toISOString() };
    const att = attention({
      phase: 'integrate',
      items: [],
      graph: graph([a, b]),
      attending: ['n-aaaaaaaa', 'n-bbbbbbbb', 'n-cccccccc'],
      attendingAt: '2026-10-23T09:00:00.000Z',
    });
    expect(att.focusNeuronIds).toEqual(['n-aaaaaaaa']);
    expect(att.focus).toEqual([{ id: 'n-aaaaaaaa', kind: 'insight', text: 'one' }]);
    expect(att.attendingAt).toBe('2026-10-23T09:00:00.000Z');
  });
});

describe('fleetFocusTexts', () => {
  test('never shows what an operator message supports, clips and caps', () => {
    const a = neuron('n-aaaaaaaa', 'x'.repeat(300));
    const b = neuron('n-bbbbbbbb', 'private', { operatorSourced: 'true' });
    const att = attention({
      phase: 'sense',
      items: [],
      graph: { get: (id) => [a, b].find((n) => n.id === id) },
      attending: ['n-aaaaaaaa', 'n-bbbbbbbb'],
    });
    const texts = fleetFocusTexts(att);
    expect(texts).toHaveLength(1);
    expect(texts[0]?.length).toBeLessThanOrEqual(120);
  });
});
