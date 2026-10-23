import { describe, expect, it } from 'bun:test';
import {
  EDGE_FLASH_MS,
  PULSE_ROTATE_PAUSE_MS,
  autoRotates,
  ballPlanFor,
  createWatcherModel,
  edgeFlashLevel,
  ownerEdgeOf,
  wheelZooms,
} from '../../web/pages/watcher-helpers.js';

function model() {
  const m = createWatcherModel({
    graph: {
      neurons: [
        { id: 'n-bot', kind: 'entity', text: 'Jarvis' },
        { id: 'n-goal', kind: 'goal', text: 'Research' },
        { id: 'n-fact', kind: 'fact', text: 'x' },
      ],
      edges: [
        { id: 'e-1', from: 'n-goal', to: 'n-bot', rel: 'owned_by', weight: 1 },
        { id: 'e-2', from: 'n-fact', to: 'n-goal', rel: 'about', weight: 1 },
      ],
    },
  });
  return m;
}

describe('ownerEdgeOf', () => {
  it('finds the owned_by edge from a neuron to its bot', () => {
    expect(ownerEdgeOf(model(), 'n-goal')?.id).toBe('e-1');
  });
  it('null for a bot, an unknown id, or a neuron with no owner edge', () => {
    const m = model();
    expect(ownerEdgeOf(m, 'n-bot')).toBeNull();
    expect(ownerEdgeOf(m, 'n-missing')).toBeNull();
    expect(ownerEdgeOf(m, 'n-fact')).toBeNull();
    expect(ownerEdgeOf(null, 'n-goal')).toBeNull();
  });
  it('ignores an owned_by edge pointing to something that is not a bot', () => {
    const m = model();
    m.edges.set('e-3', { id: 'e-3', from: 'n-fact', to: 'n-goal', rel: 'owned_by', weight: 1 });
    expect(ownerEdgeOf(m, 'n-fact')).toBeNull();
  });
});

describe('ballPlanFor (what an effect does to the ball)', () => {
  it('a pulse: pulse the point, flash the edge to the bot, pause rotation', () => {
    expect(ballPlanFor(model(), { kind: 'pulse', id: 'n-goal' })).toEqual({
      pulse: 'n-goal',
      flashEdge: { from: 'n-goal', to: 'n-bot' },
      pauseRotateMs: PULSE_ROTATE_PAUSE_MS,
    });
  });
  it('a pulse on a neuron without owner: no edge flash', () => {
    expect(ballPlanFor(model(), { kind: 'pulse', id: 'n-bot' })).toEqual({
      pulse: 'n-bot',
      flashEdge: null,
      pauseRotateMs: PULSE_ROTATE_PAUSE_MS,
    });
  });
  it('effects that touch no neuron (log rows such as sense summaries, state) have no visual', () => {
    const m = model();
    expect(ballPlanFor(m, { kind: 'log', row: { op: 'summary' } })).toBeNull();
    expect(ballPlanFor(m, { kind: 'state' })).toBeNull();
    expect(ballPlanFor(m, { kind: 'none' })).toBeNull();
    expect(ballPlanFor(m, null)).toBeNull();
  });
  it('a pulse for an id the page does not have: nothing', () => {
    expect(ballPlanFor(model(), { kind: 'pulse', id: 'n-missing' })).toBeNull();
  });
});

describe('autoRotates', () => {
  const idle = 4000;
  it('rotates when idle and not paused', () => {
    expect(
      autoRotates(10_000, { lastInputMs: 0, pausedUntilMs: 0, dragging: false, idleMs: idle })
    ).toBe(true);
  });
  it('not while dragging, after recent input, or during a pulse pause', () => {
    expect(
      autoRotates(10_000, { lastInputMs: 0, pausedUntilMs: 0, dragging: true, idleMs: idle })
    ).toBe(false);
    expect(
      autoRotates(10_000, { lastInputMs: 9000, pausedUntilMs: 0, dragging: false, idleMs: idle })
    ).toBe(false);
    expect(
      autoRotates(10_000, { lastInputMs: 0, pausedUntilMs: 11_000, dragging: false, idleMs: idle })
    ).toBe(false);
    expect(
      autoRotates(11_000, { lastInputMs: 0, pausedUntilMs: 11_000, dragging: false, idleMs: idle })
    ).toBe(true);
  });
});

describe('edgeFlashLevel', () => {
  it('1 at the flash, fades to 0 by EDGE_FLASH_MS, 0 after or before', () => {
    expect(edgeFlashLevel(0)).toBe(1);
    expect(edgeFlashLevel(EDGE_FLASH_MS / 2)).toBeCloseTo(0.5);
    expect(edgeFlashLevel(EDGE_FLASH_MS)).toBe(0);
    expect(edgeFlashLevel(EDGE_FLASH_MS * 2)).toBe(0);
    expect(edgeFlashLevel(-5)).toBe(0);
  });
});

describe('wheelZooms', () => {
  it('only when the ball is engaged (clicked) or with ctrl/meta held', () => {
    expect(wheelZooms({ engaged: false, ctrlKey: false, metaKey: false })).toBe(false);
    expect(wheelZooms({ engaged: true, ctrlKey: false, metaKey: false })).toBe(true);
    expect(wheelZooms({ engaged: false, ctrlKey: true, metaKey: false })).toBe(true);
    expect(wheelZooms({ engaged: false, ctrlKey: false, metaKey: true })).toBe(true);
    expect(wheelZooms(null)).toBe(false);
  });
});
