import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUMAN_INBOUND_HOOK } from '../../src/bot/agent-loop-utils';
import { WorkingBuffer } from '../../src/watcher/buffer';
import { Graph, type GraphChange } from '../../src/watcher/graph';
import { WatcherLog } from '../../src/watcher/log';
import { Sense } from '../../src/watcher/sense';
import { WATCHER_DEFAULTS, type WatcherLogRow } from '../../src/watcher/types';

let dir: string;
let t: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watcher-sense-'));
  t = Date.parse('2026-10-23T10:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(opts: { isOperator?: boolean } = {}) {
  const now = () => t;
  const changes: GraphChange[] = [];
  const graph = new Graph(join(dir, 'g'), { now, onChange: (c) => changes.push(c) });
  graph.load();
  const rows: WatcherLogRow[] = [];
  const log = new WatcherLog(join(dir, 'log'), { now, onRow: (r) => rows.push(r) });
  const buffer = new WorkingBuffer();
  const sense = new Sense({
    graph,
    buffer,
    log,
    now,
    config: () => WATCHER_DEFAULTS,
    botName: (id) => (id === 'b1' ? 'jarvis' : id),
    sender: () => ({ name: 'Ana', isOperator: opts.isOperator ?? false }),
  });
  const stream = new EventEmitter();
  const hooks = new EventEmitter();
  sense.attach(stream, hooks);
  return { graph, rows, buffer, sense, stream, hooks, changes };
}

describe('Sense', () => {
  test('a salient event logs a row and lands in the buffer', () => {
    const { stream, rows, buffer } = setup();
    stream.emit('activity', {
      type: 'worker:waiting',
      botId: 'b1',
      timestamp: t - 500,
      data: { question: 'which supplier should I pick' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe('sense');
    expect(rows[0].op).toBe('noticed');
    expect(rows[0].text).toBe(
      'Noticed: a worker of jarvis is waiting for an answer. Salience 0.6 (worker waiting, novel).'
    );
    expect(rows[0].salience).toBeCloseTo(0.6);
    expect(buffer.size()).toBe(1);
    expect(buffer.items()[0].noticedAt).toBe('2026-10-23T10:00:00.000Z');
  });

  test('a dull event does not log and does not enter the buffer', () => {
    const { stream, rows, buffer } = setup();
    stream.emit('activity', { type: 'llm:start', botId: 'b1', timestamp: t });
    stream.emit('activity', { type: 'memory:flush', botId: 'b1', timestamp: t });
    expect(rows).toHaveLength(0);
    expect(buffer.size()).toBe(1);
  });

  test('an event that touches a neuron activates it and logs', () => {
    const { graph, stream, rows, changes } = setup();
    const n = graph.addNeuron({
      kind: 'goal',
      text: 'Research',
      support: { bots: ['b1'] },
      createdBy: 'bot:b1',
      meta: { key: 'goal:b1:g-1' },
    });
    stream.emit('activity', {
      type: 'task:changed',
      botId: 'b1',
      timestamp: t,
      data: { taskId: 't-1', goalId: 'g-1' },
    });
    expect(graph.get(n.id)?.activations).toBe(1);
    expect(changes.some((c) => c.type === 'activate')).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].neuronIds).toEqual([n.id]);
  });

  test('the summary row appears once per window', () => {
    const { stream, sense, rows } = setup();
    stream.emit('activity', { type: 'llm:start', botId: 'b1', timestamp: t });
    stream.emit('activity', { type: 'tool:start', botId: 'b1', timestamp: t });
    t += 30_000;
    expect(sense.tick()).toBeNull();
    t += 31_000;
    const row = sense.tick();
    expect(row?.op).toBe('summary');
    expect(row?.text).toBe('Sensed 2 events in the last 1 min.');
    expect(sense.tick()).toBeNull();
    t += 120_000;
    expect(sense.tick()).toBeNull();
    expect(rows.filter((r) => r.op === 'summary')).toHaveLength(1);
  });

  test('an event after the window closes it first', () => {
    const { stream, rows } = setup();
    stream.emit('activity', { type: 'llm:start', botId: 'b1', timestamp: t });
    t += 61_000;
    stream.emit('activity', { type: 'llm:start', botId: 'b1', timestamp: t });
    expect(rows.filter((r) => r.op === 'summary')).toHaveLength(1);
  });

  test('a non-operator message is stored as topic words only', () => {
    const { hooks, buffer, rows } = setup();
    hooks.emit(HUMAN_INBOUND_HOOK, {
      botId: 'b1',
      channelKind: 'web',
      chatId: 'c1',
      timestamp: t,
      text: 'My card number is 4111 and I live on Elm Street',
    });
    const stored = buffer.items()[0].event as { text?: string };
    expect(stored.text).toBe('card number live street');
    expect(JSON.stringify(rows)).not.toContain('4111');
    expect(rows[0].text).toContain('Ana wrote to jarvis about card number live street');
  });

  test('the operator message keeps its text in the buffer', () => {
    const { hooks, buffer } = setup({ isOperator: true });
    hooks.emit(HUMAN_INBOUND_HOOK, {
      botId: 'b1',
      channelKind: 'telegram',
      chatId: '1',
      timestamp: t,
      text: 'Pay the Acme invoice',
    });
    expect((buffer.items()[0].event as { text?: string }).text).toBe('Pay the Acme invoice');
  });

  test('detach stops listening', () => {
    const { stream, sense, buffer } = setup();
    sense.detach();
    stream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    expect(buffer.size()).toBe(0);
  });

  test('a broken event never throws into the publisher', () => {
    const { stream } = setup();
    expect(() => stream.emit('activity', null)).not.toThrow();
  });

  test('lastTickAt follows the last event', () => {
    const { stream, sense } = setup();
    expect(sense.lastTickAt).toBeUndefined();
    stream.emit('activity', { type: 'llm:start', botId: 'b1', timestamp: t });
    expect(sense.lastTickAt).toBe('2026-10-23T10:00:00.000Z');
  });
});
