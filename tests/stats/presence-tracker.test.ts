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

describe('PresenceTracker — workers', () => {
  const budget = { steps: 8, toolCalls: 40, wallMs: 3_600_000 };
  const used = (steps: number) => ({ steps, toolCalls: steps * 2, wallMs: 1000 });
  function wev(
    type: ActivityEvent['type'],
    runId: string,
    data: Record<string, unknown> = {},
    timestamp = 1000
  ): ActivityEvent {
    return {
      type,
      botId: 'b1',
      timestamp,
      data: {
        runId,
        taskId: 't-1',
        goalId: 'g-1',
        status: 'running',
        step: 0,
        budget,
        used: used(0),
        ...data,
      },
    };
  }

  it('has no workers for an unknown bot', () => {
    expect(new PresenceTracker().workers('b1')).toEqual([]);
  });

  it('folds worker events into a live run, newest first, and drops ended runs', () => {
    const t = new PresenceTracker();
    t.handle(wev('worker:queued', 'r-1', { status: 'queued' }, 10));
    t.handle(wev('worker:started', 'r-1', {}, 20));
    t.handle(wev('worker:tool', 'r-1', { tool: 'web_fetch' }, 30));
    let [w] = t.workers('b1');
    expect(w).toMatchObject({
      runId: 'r-1',
      taskId: 't-1',
      goalId: 'g-1',
      status: 'running',
      step: 0,
      tool: 'web_fetch',
      since: 10,
      updatedAt: 30,
    });
    t.handle(wev('worker:step', 'r-1', { step: 1, used: used(1) }, 40));
    [w] = t.workers('b1');
    expect(w.step).toBe(1);
    expect(w.used.steps).toBe(1);
    expect(w.tool).toBeNull();
    t.handle(wev('worker:started', 'r-2', {}, 50));
    expect(t.workers('b1').map((x) => x.runId)).toEqual(['r-2', 'r-1']);
    t.handle(wev('worker:ended', 'r-1', { status: 'done' }, 60));
    expect(t.workers('b1').map((x) => x.runId)).toEqual(['r-2']);
  });

  it('keeps the question of a waiting run', () => {
    const t = new PresenceTracker();
    t.handle(
      wev(
        'worker:waiting',
        'r-1',
        {
          status: 'waiting',
          wait: { kind: 'ask', id: 'q1', question: 'Which metric?', since: 'x' },
        },
        10
      )
    );
    expect(t.workers('b1')[0]).toMatchObject({ status: 'waiting', question: 'Which metric?' });
  });

  it('tool events of a run move the run, never the bot phase', () => {
    const t = new PresenceTracker();
    t.handle(ev('agent:phase', 'b1', { phase: 'executor:start', timestamp: 5 }));
    t.handle(wev('worker:started', 'r-1', {}, 6));
    t.handle(
      ev('tool:start', 'b1', { timestamp: 7, data: { toolName: 'web_fetch', runId: 'r-1' } })
    );
    expect(t.get('b1')).toEqual({
      executing: true,
      phase: 'executor:start',
      currentTool: null,
      since: 5,
    });
    expect(t.workers('b1')[0].tool).toBe('web_fetch');
    t.handle(ev('tool:end', 'b1', { timestamp: 8, data: { toolName: 'web_fetch', runId: 'r-1' } }));
    expect(t.workers('b1')[0].tool).toBeNull();
    expect(t.get('b1').since).toBe(5);
  });

  it('a run tool event for an idle bot does not make the bot executing', () => {
    const t = new PresenceTracker();
    t.handle(ev('tool:start', 'b1', { data: { toolName: 'exec', runId: 'r-9' } }));
    expect(t.get('b1').executing).toBe(false);
    expect(t.workers('b1')).toEqual([]);
  });

  it('ignores worker events without a run id and agent results never clear workers', () => {
    const t = new PresenceTracker();
    t.handle({ type: 'worker:started', botId: 'b1', timestamp: 1, data: {} });
    expect(t.workers('b1')).toEqual([]);
    t.handle(wev('worker:started', 'r-1'));
    t.handle(ev('agent:result', 'b1'));
    expect(t.workers('b1')).toHaveLength(1);
    t.clear('b1');
    expect(t.workers('b1')).toEqual([]);
  });
});
