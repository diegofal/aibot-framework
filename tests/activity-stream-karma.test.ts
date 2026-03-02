import { describe, expect, mock, test } from 'bun:test';
import { type ActivityEvent, ActivityStream } from '../src/bot/activity-stream';

describe('ActivityStream karma:change events', () => {
  test('publishes and stores karma:change events', () => {
    const stream = new ActivityStream();
    const listener = mock(() => {});
    stream.on('activity', listener);

    const event: ActivityEvent = {
      type: 'karma:change',
      botId: 'bot1',
      timestamp: Date.now(),
      data: { delta: -2, reason: 'Repeated action: check weather', source: 'agent-loop' },
    };
    stream.publish(event);

    expect(stream.size).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);

    const stored = stream.getRecent(1)[0];
    expect(stored.type).toBe('karma:change');
    expect(stored.data?.delta).toBe(-2);
    expect(stored.data?.source).toBe('agent-loop');
  });

  test('karma:change events with production source', () => {
    const stream = new ActivityStream();

    stream.publish({
      type: 'karma:change',
      botId: 'tsc',
      timestamp: Date.now(),
      data: {
        delta: 10,
        reason: 'Production approved: "report.md" (rating: 5/5)',
        source: 'production',
        path: 'report.md',
      },
    });

    const stored = stream.getRecent(1)[0];
    expect(stored.type).toBe('karma:change');
    expect(stored.data?.delta).toBe(10);
    expect(stored.data?.source).toBe('production');
    expect(stored.data?.path).toBe('report.md');
  });

  test('karma:change events coexist with other event types', () => {
    const stream = new ActivityStream();

    stream.publish({
      type: 'tool:start',
      botId: 'bot1',
      timestamp: 1000,
      data: { toolName: 'web_search' },
    });
    stream.publish({
      type: 'karma:change',
      botId: 'bot1',
      timestamp: 2000,
      data: { delta: 1, reason: 'Novel action', source: 'agent-loop' },
    });
    stream.publish({
      type: 'tool:end',
      botId: 'bot1',
      timestamp: 3000,
      data: { toolName: 'web_search', success: true },
    });

    expect(stream.size).toBe(3);
    const types = stream.getRecent().map((e) => e.type);
    expect(types).toEqual(['tool:start', 'karma:change', 'tool:end']);
  });
});
