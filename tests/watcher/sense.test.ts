import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUMAN_INBOUND_HOOK, OPERATOR_MESSAGE_HOOK } from '../../src/bot/agent-loop-utils';
import { WorkingBuffer } from '../../src/watcher/buffer';
import { Graph, type GraphChange } from '../../src/watcher/graph';
import { WatcherLog } from '../../src/watcher/log';
import { Sense, inboundSender } from '../../src/watcher/sense';
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

  test('buffer items say whether the operator wrote them', () => {
    const op = setup({ isOperator: true });
    op.hooks.emit(HUMAN_INBOUND_HOOK, {
      botId: 'b1',
      channelKind: 'web',
      chatId: '1',
      timestamp: t,
      text: 'Pay the Acme invoice',
    });
    expect(op.buffer.items()[0].fromOperator).toBe(true);
    const other = setup();
    other.hooks.emit(HUMAN_INBOUND_HOOK, {
      botId: 'b1',
      channelKind: 'web',
      chatId: '1',
      timestamp: t,
      text: 'Pay the Acme invoice',
    });
    expect(other.buffer.items()[0].fromOperator).toBeUndefined();
  });

  test('an operator message (Telegram chat or dashboard thread) is sensed as the operator, verbatim', () => {
    // sender() says "not the operator": the operator hook must not depend on it.
    const { hooks, buffer, rows } = setup({ isOperator: false });
    hooks.emit(OPERATOR_MESSAGE_HOOK, {
      botId: 'b1',
      channelKind: 'dashboard',
      timestamp: t,
      text: 'The Acme invoice is due on Friday',
    });
    const item = buffer.items()[0];
    expect(item.fromOperator).toBe(true);
    expect((item.event as { text?: string }).text).toBe('The Acme invoice is due on Friday');
    expect((item.event as { channelKind?: string }).channelKind).toBe('dashboard');
    expect(rows[0].text).toContain('the operator wrote to jarvis about The Acme invoice');
  });

  test('an operator message without text is ignored', () => {
    const { hooks, buffer } = setup();
    hooks.emit(OPERATOR_MESSAGE_HOOK, { botId: 'b1', channelKind: 'telegram', timestamp: t });
    expect(buffer.size()).toBe(0);
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

describe('inboundSender (who counts as the operator)', () => {
  const ev = (over: Record<string, unknown> = {}) =>
    ({
      botId: 'b1',
      channelKind: 'telegram',
      chatId: '42',
      userId: '42',
      timestamp: 0,
      text: 'hi',
      ...over,
    }) as never;
  const operatorContact = {
    displayName: 'Diego',
    metadata: { role: 'operator' },
  } as never;

  test('the operator Telegram private chat is the operator', () => {
    expect(inboundSender(ev(), { operatorChatId: 42 })).toEqual({
      isOperator: true,
      name: 'the operator',
    });
  });

  test('a Telegram group message from the operator user id is not', () => {
    expect(inboundSender(ev({ chatId: '-1001' }), { operatorChatId: 42 }).isOperator).toBe(false);
  });

  test('another Telegram chat is not the operator', () => {
    expect(inboundSender(ev({ chatId: '7', userId: '7' }), { operatorChatId: 42 }).isOperator).toBe(
      false
    );
  });

  test('without a configured operator chat nobody on Telegram is the operator', () => {
    expect(inboundSender(ev(), {}).isOperator).toBe(false);
  });

  for (const kind of ['rest', 'web', 'whatsapp', 'discord', 'dashboard']) {
    test(`a contact with the operator role on ${kind} is not trusted`, () => {
      const who = inboundSender(ev({ channelKind: kind, chatId: 'a@b.c', userId: 'a@b.c' }), {
        operatorChatId: 42,
        contact: operatorContact,
      });
      expect(who.isOperator).toBe(false);
      expect(who.name).toBe('Diego');
    });
  }

  test('a known contact keeps its display name', () => {
    expect(
      inboundSender(ev({ chatId: '7', userId: '7' }), {
        operatorChatId: 42,
        contact: { displayName: 'Ana' } as never,
      })
    ).toEqual({ isOperator: false, name: 'Ana' });
  });
});

describe('Sense.onItem (phase 3: integrate accumulates what notice drains)', () => {
  test('every item pushed into the buffer is also handed to onItem', () => {
    const now = () => t;
    const graph = new Graph(join(dir, 'g2'), { now });
    graph.load();
    const seen: string[] = [];
    const buffer = new WorkingBuffer();
    const sense = new Sense({
      graph,
      buffer,
      log: new WatcherLog(join(dir, 'log2'), { now }),
      now,
      config: () => WATCHER_DEFAULTS,
      onItem: (item) => seen.push(item.id),
    });
    const item = sense.handle({ type: 'worker:waiting', botId: 'b1', timestamp: t } as never);
    expect(item).not.toBeNull();
    expect(seen).toEqual([item?.id]);
    expect(sense.handle({ type: 'llm:start', botId: 'b1', timestamp: t } as never)).toBeNull();
    expect(seen).toHaveLength(1);
  });

  test('an onItem that throws does not lose the buffer item', () => {
    const now = () => t;
    const graph = new Graph(join(dir, 'g3'), { now });
    graph.load();
    const buffer = new WorkingBuffer();
    const sense = new Sense({
      graph,
      buffer,
      log: new WatcherLog(join(dir, 'log3'), { now }),
      now,
      config: () => WATCHER_DEFAULTS,
      onItem: () => {
        throw new Error('boom');
      },
    });
    expect(
      sense.handle({ type: 'worker:waiting', botId: 'b1', timestamp: t } as never)
    ).not.toBeNull();
    expect(buffer.size()).toBe(1);
  });
});
