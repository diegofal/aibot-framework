import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ActivityEvent } from '../../src/bot/activity-stream';
import { PresenceTracker } from '../../src/stats/presence-tracker';

function ev(
  type: ActivityEvent['type'],
  botId: string,
  extra: Partial<ActivityEvent> = {}
): ActivityEvent {
  return { type, botId, timestamp: 1000, ...extra };
}

describe('PresenceTracker', () => {
  it('is idle for an unknown bot and returns a copy', () => {
    const t = new PresenceTracker();
    const a = t.get('b1');
    expect(a).toEqual({ executing: false, phase: null, currentTool: null, since: null });
    a.executing = true;
    expect(t.get('b1').executing).toBe(false);
  });

  it('tracks phases through a cycle and resets on result', () => {
    const t = new PresenceTracker();
    t.handle(ev('agent:phase', 'b1', { phase: 'start', timestamp: 5 }));
    expect(t.get('b1')).toEqual({ executing: true, phase: 'start', currentTool: null, since: 5 });
    t.handle(ev('agent:phase', 'b1', { phase: 'planner:start', timestamp: 6 }));
    expect(t.get('b1').phase).toBe('planner:start');
    t.handle(ev('agent:result', 'b1'));
    expect(t.get('b1').executing).toBe(false);
    expect(t.get('b1').phase).toBeNull();
  });

  it('records the running tool and clears it on end or error', () => {
    const t = new PresenceTracker();
    t.handle(ev('agent:phase', 'b1', { phase: 'executor:start' }));
    t.handle(ev('tool:start', 'b1', { data: { toolName: 'web_search' } }));
    expect(t.get('b1').currentTool).toBe('web_search');
    t.handle(ev('tool:end', 'b1', { data: { toolName: 'web_search', success: true } }));
    expect(t.get('b1')).toMatchObject({
      executing: true,
      phase: 'executor:start',
      currentTool: null,
    });
    t.handle(ev('tool:start', 'b1', { data: { toolName: 'exec' } }));
    t.handle(ev('tool:error', 'b1'));
    expect(t.get('b1').currentTool).toBeNull();
  });

  it('a tool outside a cycle (conversation) still marks the bot busy, and idle resets', () => {
    const t = new PresenceTracker();
    t.handle(ev('tool:start', 'b1', { data: { toolName: 'file_read' } }));
    expect(t.get('b1')).toMatchObject({ executing: true, currentTool: 'file_read' });
    t.handle(ev('agent:idle', 'b1'));
    expect(t.get('b1').executing).toBe(false);
  });

  it('a tool:end for an idle bot does not mark it executing', () => {
    const t = new PresenceTracker();
    t.handle(ev('tool:end', 'b1'));
    expect(t.get('b1').executing).toBe(false);
  });

  it('keeps bots independent and ignores unrelated or malformed events', () => {
    const t = new PresenceTracker();
    t.handle(ev('agent:phase', 'b1', { phase: 'start' }));
    t.handle(ev('llm:start', 'b2'));
    t.handle({ type: 'agent:phase' } as unknown as ActivityEvent);
    expect(t.get('b1').executing).toBe(true);
    expect(t.get('b2').executing).toBe(false);
  });

  it('attaches to an emitter and clears state', () => {
    const t = new PresenceTracker();
    const stream = new EventEmitter();
    t.attach(stream as never);
    stream.emit('activity', ev('agent:phase', 'b1', { phase: 'start' }));
    expect(t.get('b1').executing).toBe(true);
    t.clear('b1');
    expect(t.get('b1').executing).toBe(false);
    stream.emit('activity', ev('agent:phase', 'b2', { phase: 'start' }));
    t.clear();
    expect(t.get('b2').executing).toBe(false);
  });
});
