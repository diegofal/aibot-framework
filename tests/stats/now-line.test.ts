import { describe, expect, it } from 'bun:test';
import { type NowInput, describeNow, phaseLabel, relativeIn } from '../../src/stats/now-line';

const NOW = 1_700_000_000_000;
const M = 60_000;
const H = 3_600_000;

function input(over: Partial<NowInput> = {}): NowInput {
  return {
    enabled: true,
    running: true,
    posture: 'active',
    isExecuting: false,
    phase: null,
    currentTool: null,
    lastRunAt: NOW - 2 * H,
    nextRunAt: NOW + 4 * H,
    skippedReason: null,
    lastError: null,
    pendingAsks: 0,
    nowMs: NOW,
    ...over,
  };
}

describe('relativeIn', () => {
  it('rounds to minutes, hours and days', () => {
    expect(relativeIn(NOW, NOW + 10_000)).toBe('now');
    expect(relativeIn(NOW, NOW - 5 * M)).toBe('now');
    expect(relativeIn(NOW, NOW + 5 * M)).toBe('in 5m');
    expect(relativeIn(NOW, NOW + 3 * H)).toBe('in 3h');
    expect(relativeIn(NOW, NOW + 72 * H)).toBe('in 3d');
  });
  it('says "soon" when there is no timestamp', () => {
    expect(relativeIn(NOW, null)).toBe('soon');
    expect(relativeIn(NOW, Number.NaN)).toBe('soon');
  });
});

describe('phaseLabel', () => {
  it('names the running tool first', () => {
    expect(phaseLabel('executor:start', 'web_search')).toBe("I'm working: running web_search.");
  });
  it('maps each phase to a sentence', () => {
    expect(phaseLabel('strategist:start', null)).toContain('reflecting');
    expect(phaseLabel('planner:start', null)).toContain('deciding');
    expect(phaseLabel('executor:start', null)).toContain('executing my plan');
    expect(phaseLabel('start', null)).toContain('starting');
    expect(phaseLabel(null, null)).toContain('middle of a cycle');
  });
});

describe('describeNow', () => {
  it('disabled beats everything', () => {
    const r = describeNow(input({ enabled: false, isExecuting: true, pendingAsks: 3 }));
    expect(r.tone).toBe('muted');
    expect(r.text).toContain('disabled');
  });
  it('not running', () => {
    const r = describeNow(input({ running: false, posture: 'blocked' }));
    expect(r).toEqual({ text: "I'm not running right now.", tone: 'muted' });
  });
  it('executing uses the phase label with info tone', () => {
    const r = describeNow(
      input({ isExecuting: true, phase: 'executor:start', currentTool: 'exec' })
    );
    expect(r).toEqual({ text: "I'm working: running exec.", tone: 'info' });
  });
  it('pending asks come before posture', () => {
    expect(describeNow(input({ pendingAsks: 1, posture: 'blocked' })).text).toBe(
      "I'm waiting on you — 1 question in your inbox."
    );
    expect(describeNow(input({ pendingAsks: 2 })).text).toContain('2 questions');
  });
  it('blocked quotes the last error or the goals', () => {
    expect(describeNow(input({ posture: 'blocked', lastError: 'quota  exceeded\n' }))).toEqual({
      text: "I'm blocked: quota exceeded.",
      tone: 'danger',
    });
    expect(describeNow(input({ posture: 'blocked' })).text).toBe(
      "I'm blocked: all my goals are blocked."
    );
  });
  it('skipped cycle names the reason and the retry', () => {
    const r = describeNow(input({ skippedReason: 'circuit-open:ollama', nextRunAt: NOW + 30 * M }));
    expect(r.tone).toBe('warn');
    expect(r.text).toBe("My last cycle was skipped (circuit-open:ollama); I'll try again in 30m.");
  });
  it('never ran yet', () => {
    const r = describeNow(input({ lastRunAt: null, posture: 'unknown', nextRunAt: NOW + 10 * M }));
    expect(r).toEqual({ text: "I haven't run yet; my first cycle is in 10m.", tone: 'muted' });
  });
  it('idle asks for a goal', () => {
    expect(describeNow(input({ posture: 'idle' })).text).toContain('no active goals');
  });
  it('standby mentions the next check-in', () => {
    const r = describeNow(input({ posture: 'standby', nextRunAt: NOW + 2 * H }));
    expect(r.tone).toBe('warn');
    expect(r.text).toContain('in 2h');
  });
  it('default is between cycles with ok tone', () => {
    expect(describeNow(input())).toEqual({
      text: "I'm between cycles; next run in 4h.",
      tone: 'ok',
    });
  });
  it('truncates long error text', () => {
    const r = describeNow(input({ posture: 'blocked', lastError: 'x'.repeat(200) }));
    expect(r.text.length).toBeLessThan(110);
    expect(r.text.endsWith('….')).toBe(true);
  });
});
