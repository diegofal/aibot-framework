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

function setup(opts: { isOperator?: boolean; deferred?: boolean } = {}) {
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
    // The behaviour tests sense in the publish call; `deferred` keeps the real batching.
    ...(opts.deferred ? {} : { defer: (fn: () => void) => fn() }),
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

  test('an event that touches a neuron below the bar activates it without a row', () => {
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
    // Deliberate change (watcher cleanup): a touch below `notice.salienceBar`
    // used to log a "salience 0" row; it now activates silently.
    expect(rows.filter((r) => r.op === 'noticed')).toHaveLength(0);
  });

  test('a touched neuron above the bar logs a noticed row with its ids', () => {
    const { graph, stream, rows } = setup();
    const n = graph.addNeuron({
      kind: 'goal',
      text: 'Research',
      support: { bots: ['b1'] },
      createdBy: 'bot:b1',
      meta: { key: 'goal:b1:g-1' },
    });
    stream.emit('activity', {
      type: 'worker:waiting',
      botId: 'b1',
      timestamp: t,
      data: { goalId: 'g-1', question: 'which supplier should I pick' },
    });
    const noticed = rows.filter((r) => r.op === 'noticed');
    expect(noticed).toHaveLength(1);
    expect(noticed[0].neuronIds).toContain(n.id);
  });

  test('below the bar: no noticed row, the summary still counts the event', () => {
    const { stream, sense, rows } = setup();
    for (let i = 0; i < 5; i++)
      stream.emit('activity', { type: 'llm:start', botId: 'b1', timestamp: t });
    expect(rows.filter((r) => r.op === 'noticed')).toHaveLength(0);
    t += 61_000;
    expect(sense.tick()?.text).toBe('Sensed 5 events in the last 1 min.');
  });

  test('a touched goal also lights up the bot that owns it (owned_by), both activations emitted', () => {
    const { graph, stream, changes } = setup();
    const bot = graph.addNeuron({
      kind: 'entity',
      text: 'Jarvis',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
      meta: { key: 'bot:b1' },
    });
    const goal = graph.addNeuron({
      kind: 'goal',
      text: 'Research',
      support: { bots: ['b1'] },
      createdBy: 'bot:b1',
      meta: { key: 'goal:b1:g-1' },
    });
    graph.addEdge({ from: goal.id, to: bot.id, rel: 'owned_by', weight: 1, createdBy: 'bot:b1' });
    stream.emit('activity', {
      type: 'task:changed',
      botId: 'b1',
      timestamp: t,
      data: { taskId: 't-1', goalId: 'g-1' },
    });
    expect(graph.get(goal.id)?.activations).toBe(1);
    expect(graph.get(bot.id)?.activations).toBe(1);
    const activated = changes.flatMap((c) => (c.type === 'activate' ? [c.activation.id] : []));
    expect(activated).toEqual([goal.id, bot.id]);
  });

  test('an owner is activated once even when it is touched too or owns two touched neurons', () => {
    const { graph, sense } = setup();
    const bot = graph.addNeuron({
      kind: 'entity',
      text: 'Jarvis',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
      meta: { key: 'bot:b1' },
    });
    const owners = sense.ownersOf([bot.id, 'n-missing']);
    expect(owners).toEqual([]);
    const a = graph.addNeuron({
      kind: 'topic',
      text: 'suppliers',
      support: { bots: ['b1'] },
      createdBy: 'bot:b1',
    });
    const b = graph.addNeuron({
      kind: 'goal',
      text: 'Ship',
      support: { bots: ['b1'] },
      createdBy: 'bot:b1',
    });
    const f = graph.addNeuron({
      kind: 'fact',
      text: 'x',
      support: { bots: ['b1'] },
      createdBy: 'watcher',
    });
    for (const n of [a, b, f])
      graph.addEdge({ from: n.id, to: bot.id, rel: 'owned_by', weight: 1, createdBy: 'watcher' });
    expect(sense.ownersOf([a.id, b.id])).toEqual([bot.id]);
    expect(sense.ownersOf([a.id, bot.id])).toEqual([]);
    // only goal/topic neurons light their owner
    expect(sense.ownersOf([f.id])).toEqual([]);
  });

  test('onBatch is called once per sensed batch (the watcher republishes its state)', async () => {
    const calls: number[] = [];
    const now = () => t;
    const graph = new Graph(join(dir, 'g2'), { now });
    graph.load();
    const sense = new Sense({
      graph,
      buffer: new WorkingBuffer(),
      log: new WatcherLog(join(dir, 'log2'), { now }),
      now,
      config: () => WATCHER_DEFAULTS,
      onBatch: (n) => calls.push(n),
    });
    const stream = new EventEmitter();
    sense.attach(stream, new EventEmitter());
    stream.emit('activity', { type: 'llm:start', botId: 'b1', timestamp: t });
    stream.emit('activity', { type: 'llm:end', botId: 'b1', timestamp: t });
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([2]);
    sense.flush();
    expect(calls).toEqual([2]);
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

  // Telegram never emits a `human_inbound` (handleConversation skips the hook;
  // the operator's private chat arrives on `operator_message`), and on every
  // other channel the sender id is client-supplied: a `human_inbound` is never
  // the operator, whatever its chat or the contact's role.
  for (const kind of ['telegram', 'rest', 'web', 'whatsapp', 'discord', 'dashboard']) {
    test(`a human_inbound on ${kind} is never the operator, even from a contact with that role`, () => {
      const who = inboundSender(ev({ channelKind: kind }), { contact: operatorContact });
      expect(who.isOperator).toBe(false);
      expect(who.name).toBe('Diego');
    });
  }

  test('a known contact keeps its display name', () => {
    expect(
      inboundSender(ev({ chatId: '7', userId: '7' }), { contact: { displayName: 'Ana' } as never })
    ).toEqual({ isOperator: false, name: 'Ana' });
  });

  test('an unknown sender has no name and is not the operator', () => {
    expect(inboundSender(ev(), {})).toEqual({ isOperator: false });
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

describe('Sense: off the publisher call (hot path)', () => {
  test('publishing only queues the event; it is scored in a batch after the publish returns', async () => {
    const { stream, hooks, buffer, rows } = setup({ deferred: true });
    stream.emit('activity', { type: 'worker:waiting', botId: 'b1', timestamp: t });
    hooks.emit(HUMAN_INBOUND_HOOK, {
      botId: 'b1',
      channelKind: 'web',
      chatId: 'c1',
      timestamp: t,
      text: 'Where is the invoice',
    });
    stream.emit('activity', { type: 'llm:error', botId: 'b1', timestamp: t });
    expect(buffer.size()).toBe(0);
    expect(rows).toHaveLength(0);
    await new Promise((r) => setImmediate(r));
    expect(buffer.items().map((i) => (i.event as { type?: string }).type ?? 'human')).toEqual([
      'worker:waiting',
      'human',
      'llm:error',
    ]);
  });

  test('flush() senses what is queued at once (stop and the read APIs use it)', () => {
    const { stream, buffer, sense } = setup({ deferred: true });
    stream.emit('activity', { type: 'worker:waiting', botId: 'b1', timestamp: t });
    expect(buffer.size()).toBe(0);
    sense.flush();
    expect(buffer.size()).toBe(1);
    sense.flush();
    expect(buffer.size()).toBe(1);
  });

  test('a detached sense still senses what was queued before detaching, once', async () => {
    const { stream, buffer, sense } = setup({ deferred: true });
    stream.emit('activity', { type: 'worker:waiting', botId: 'b1', timestamp: t });
    sense.detach();
    stream.emit('activity', { type: 'worker:waiting', botId: 'b1', timestamp: t });
    await new Promise((r) => setImmediate(r));
    expect(buffer.size()).toBe(1);
  });
});

describe('Sense novelty dedupe', () => {
  const fetchFailed = (botId = 'b1') => ({
    type: 'tool:error',
    botId,
    timestamp: t,
    data: { toolName: 'web_fetch', error: 'HTTP 403 Forbidden: thelancet.com blocks bots' },
  });

  test('4 identical tool:error events in one second: one noticed row, the summary counts 4', () => {
    const { stream, sense, rows, buffer } = setup();
    for (let i = 0; i < 4; i++) {
      stream.emit('activity', fetchFailed());
      t += 250;
    }
    const noticed = rows.filter((r) => r.op === 'noticed');
    expect(noticed).toHaveLength(1);
    expect(noticed[0].text).toContain('novel');
    expect(buffer.size()).toBe(1);
    t += 61_000;
    expect(sense.tick()?.text).toBe(
      'Sensed 4 events in the last 1 min (3 repeats), top: web_fetch failed in jarvis (salience 0.5).'
    );
  });

  test('3 identical errors touching a goal within a minute activate it once', () => {
    const { graph, stream } = setup();
    const goal = graph.addNeuron({
      kind: 'goal',
      text: 'Research',
      support: { bots: ['b1'] },
      createdBy: 'bot:b1',
      meta: { key: 'goal:b1:g-1' },
    });
    for (let i = 0; i < 3; i++) {
      stream.emit('activity', {
        ...fetchFailed(),
        data: { ...fetchFailed().data, goalId: 'g-1' },
      });
      t += 10_000;
    }
    expect(graph.get(goal.id)?.activations).toBe(1);
  });

  test('errors every 30 s for 3 min activate the goal once per window: 3 times', () => {
    const { graph, stream } = setup();
    const goal = graph.addNeuron({
      kind: 'goal',
      text: 'Research',
      support: { bots: ['b1'] },
      createdBy: 'bot:b1',
      meta: { key: 'goal:b1:g-1' },
    });
    for (let i = 0; i < 6; i++) {
      stream.emit('activity', {
        ...fetchFailed(),
        data: { ...fetchFailed().data, goalId: 'g-1' },
      });
      t += 30_000;
    }
    // The window does not slide on each sighting: novel at 0 s, 60 s and 120 s.
    expect(graph.get(goal.id)?.activations).toBe(3);
  });

  test('a repeat differing only in numbers and spacing is still a repeat', () => {
    const { stream, rows } = setup();
    stream.emit('activity', {
      ...fetchFailed(),
      data: { toolName: 'web_fetch', error: 'timeout after 3001 ms' },
    });
    stream.emit('activity', {
      ...fetchFailed(),
      data: { toolName: 'web_fetch', error: 'timeout  after 2999 ms' },
    });
    expect(rows.filter((r) => r.op === 'noticed')).toHaveLength(1);
  });

  test('after 60 s the same event is novel again', () => {
    const { stream, rows } = setup();
    stream.emit('activity', fetchFailed());
    t += 61_000;
    stream.emit('activity', fetchFailed());
    expect(rows.filter((r) => r.op === 'noticed')).toHaveLength(2);
  });

  test('the same event from another bot is not a repeat', () => {
    const { stream, rows } = setup();
    stream.emit('activity', fetchFailed('b1'));
    stream.emit('activity', fetchFailed('b2'));
    expect(rows.filter((r) => r.op === 'noticed')).toHaveLength(2);
  });

  test('a failed tool:end of the same tool and error is a repeat of the tool:error', () => {
    const { stream, rows, buffer } = setup();
    stream.emit('activity', fetchFailed());
    stream.emit('activity', {
      type: 'tool:end',
      botId: 'b1',
      timestamp: t,
      data: {
        toolName: 'web_fetch',
        success: false,
        failureKind: 'blocked',
        target: 'thelancet.com/x',
        result: 'HTTP 403 Forbidden: thelancet.com blocks bots',
        error: 'HTTP 403 Forbidden: thelancet.com blocks bots',
      },
    });
    expect(rows.filter((r) => r.op === 'noticed')).toHaveLength(1);
    expect(buffer.size()).toBe(1);
  });
});
