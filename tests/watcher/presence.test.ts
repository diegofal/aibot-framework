import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { WatcherPresence } from '../../src/watcher/presence';

const phase = (botId: string, p: string) => ({
  type: 'agent:phase',
  botId,
  timestamp: 1000,
  phase: p,
});

describe('WatcherPresence', () => {
  test('tracks a bot from the activity stream while attached', () => {
    const stream = new EventEmitter();
    const presence = new WatcherPresence();
    presence.attach(stream);
    stream.emit('activity', phase('b1', 'planner'));
    expect(presence.get('b1')).toMatchObject({ executing: true, phase: 'planner' });
    expect(presence.get('nobody')).toMatchObject({ executing: false, phase: null });
  });

  test('detach stops listening; attaching twice listens once', () => {
    const stream = new EventEmitter();
    const presence = new WatcherPresence();
    presence.attach(stream);
    presence.attach(stream);
    expect(stream.listenerCount('activity')).toBe(1);
    presence.detach();
    expect(stream.listenerCount('activity')).toBe(0);
    stream.emit('activity', phase('b1', 'executor'));
    expect(presence.get('b1').executing).toBe(false);
  });

  test('a malformed event never throws', () => {
    const stream = new EventEmitter();
    const presence = new WatcherPresence();
    presence.attach(stream);
    expect(() => stream.emit('activity', null)).not.toThrow();
    expect(presence.workers('b1')).toEqual([]);
  });
});
