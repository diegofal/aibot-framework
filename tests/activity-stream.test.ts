import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { ActivityStream, type ActivityEvent } from '../src/bot/activity-stream';

describe('ActivityStream', () => {
  let stream: ActivityStream;

  beforeEach(() => {
    stream = new ActivityStream();
  });

  test('starts empty', () => {
    expect(stream.size).toBe(0);
    expect(stream.getRecent()).toEqual([]);
  });

  test('publish() stores events and emits', () => {
    const listener = mock(() => {});
    stream.on('activity', listener);

    const event: ActivityEvent = {
      type: 'tool:start',
      botId: 'bot1',
      timestamp: Date.now(),
      data: { toolName: 'web_search' },
    };
    stream.publish(event);

    expect(stream.size).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  test('getRecent() returns latest N events', () => {
    for (let i = 0; i < 10; i++) {
      stream.publish({
        type: 'agent:phase',
        botId: 'bot1',
        timestamp: Date.now(),
        data: { index: i },
      });
    }

    expect(stream.getRecent(3)).toHaveLength(3);
    expect(stream.getRecent(3)[0].data?.index).toBe(7);
    expect(stream.getRecent(3)[2].data?.index).toBe(9);
  });

  test('getRecent() default count is 50', () => {
    for (let i = 0; i < 100; i++) {
      stream.publish({
        type: 'agent:phase',
        botId: 'bot1',
        timestamp: i,
      });
    }

    expect(stream.getRecent()).toHaveLength(50);
  });

  test('buffer respects max size', () => {
    const small = new ActivityStream(5);

    for (let i = 0; i < 10; i++) {
      small.publish({
        type: 'tool:end',
        botId: 'bot1',
        timestamp: i,
        data: { index: i },
      });
    }

    expect(small.size).toBe(5);
    // Oldest events should be evicted
    const recent = small.getRecent(10);
    expect(recent).toHaveLength(5);
    expect(recent[0].data?.index).toBe(5);
    expect(recent[4].data?.index).toBe(9);
  });

  test('clear() empties the buffer', () => {
    stream.publish({ type: 'agent:idle', botId: 'bot1', timestamp: Date.now() });
    stream.publish({ type: 'agent:idle', botId: 'bot1', timestamp: Date.now() });
    expect(stream.size).toBe(2);

    stream.clear();
    expect(stream.size).toBe(0);
    expect(stream.getRecent()).toEqual([]);
  });

  test('multiple listeners receive events', () => {
    const l1 = mock(() => {});
    const l2 = mock(() => {});
    stream.on('activity', l1);
    stream.on('activity', l2);

    stream.publish({ type: 'llm:start', botId: 'bot1', timestamp: Date.now() });

    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  test('events preserve all fields', () => {
    const event: ActivityEvent = {
      type: 'memory:flush',
      botId: 'finny',
      timestamp: 1234567890,
      phase: 'start',
      data: { messageCount: 42 },
    };
    stream.publish(event);

    const stored = stream.getRecent(1)[0];
    expect(stored.type).toBe('memory:flush');
    expect(stored.botId).toBe('finny');
    expect(stored.timestamp).toBe(1234567890);
    expect(stored.phase).toBe('start');
    expect(stored.data).toEqual({ messageCount: 42 });
  });
});
