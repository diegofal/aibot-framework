import { describe, expect, it } from 'bun:test';
import {
  applyWatcherEvent,
  createWatcherModel,
  mergeWatcherState,
  shouldRedrawTiers,
  stateHtml,
  stateParts,
  tierControlsHtml,
  tierPatchFromInput,
} from '../../web/pages/watcher-helpers.js';

const CONFIG = {
  notice: { enabled: true, maxPerDay: 288 },
  integrate: { enabled: false, maxPerDay: 24 },
};

describe('tierControlsHtml', () => {
  it('one switch and one daily cap per tier, reflecting the config', () => {
    const html = tierControlsHtml(CONFIG);
    expect(html).toContain('data-tier="notice"');
    expect(html).toContain('data-tier="integrate"');
    expect(html).toMatch(/data-tier="notice" data-field="enabled"[^>]*checked/);
    expect(html).not.toMatch(/data-tier="integrate" data-field="enabled"[^>]*checked/);
    expect(html).toContain('value="288"');
    expect(html).toContain('value="24"');
    expect(html).toContain('Notice');
    expect(html).toContain('Integrate');
  });
  it('disabled while busy; empty without a config', () => {
    expect(tierControlsHtml(CONFIG, { busy: true })).toContain('disabled');
    expect(tierControlsHtml(null)).toBe('');
  });
});

describe('stateHtml shows the tier controls when the state carries config', () => {
  it('with config', () => {
    expect(stateHtml({ running: true, config: CONFIG })).toContain('data-tier="notice"');
  });
  it('without config', () => {
    expect(stateHtml({ running: true })).not.toContain('data-tier=');
  });
});

describe('tierPatchFromInput', () => {
  it('a switch', () => {
    expect(tierPatchFromInput('notice', 'enabled', true)).toEqual({ notice: { enabled: true } });
  });
  it('a daily cap as text', () => {
    expect(tierPatchFromInput('integrate', 'maxPerDay', '12')).toEqual({
      integrate: { maxPerDay: 12 },
    });
  });
  it('null for a bad cap, an unknown tier or field', () => {
    expect(tierPatchFromInput('integrate', 'maxPerDay', '-1')).toBeNull();
    expect(tierPatchFromInput('integrate', 'maxPerDay', '1.5')).toBeNull();
    expect(tierPatchFromInput('integrate', 'maxPerDay', '')).toBeNull();
    expect(tierPatchFromInput('graph', 'enabled', true)).toBeNull();
    expect(tierPatchFromInput('notice', 'model', 'x')).toBeNull();
  });
});

describe('mergeWatcherState keeps the tier config a state event does not carry', () => {
  it('keeps it', () => {
    expect(mergeWatcherState({ config: CONFIG, phase: 'sense' }, { phase: 'notice' })).toEqual({
      config: CONFIG,
      phase: 'notice',
      enabled: true,
    });
  });
  it('a newer config wins', () => {
    const next = { ...CONFIG, notice: { enabled: false, maxPerDay: 1 } };
    expect(mergeWatcherState({ config: CONFIG }, { config: next }).config).toEqual(next);
  });
  it('watcher:state events go through it', () => {
    const model = createWatcherModel({ state: { config: CONFIG, phase: 'sense' } });
    applyWatcherEvent(model, { type: 'watcher:state', data: { phase: 'notice' } });
    expect(model.state.config).toEqual(CONFIG);
    expect(model.state.phase).toBe('notice');
  });
});

describe('a watcher:state with tiers (another tab changed them) reaches the tier controls', () => {
  const changed = {
    notice: { enabled: false, maxPerDay: 288 },
    integrate: { enabled: true, maxPerDay: 6 },
  };
  it('the server tiers become the config the controls draw from', () => {
    expect(mergeWatcherState({ config: CONFIG }, { tiers: changed }).config).toEqual(changed);
  });
  it('an unfocused control redraws with the new values; a focused one is left alone', () => {
    const model = createWatcherModel({ state: { config: CONFIG, phase: 'sense' } });
    const prev = { config: model.state.config, busy: false };
    applyWatcherEvent(model, { type: 'watcher:state', data: { phase: 'sense', tiers: changed } });
    const next = { config: model.state.config, busy: false };
    expect(shouldRedrawTiers(prev, next, false)).toBe(true);
    expect(shouldRedrawTiers(prev, next, true)).toBe(false);
    expect(tierControlsHtml(next.config)).toContain('value="6"');
  });
  it('a state without tiers keeps the known config', () => {
    expect(mergeWatcherState({ config: CONFIG }, { phase: 'notice' }).config).toEqual(CONFIG);
  });
});

describe('shouldRedrawTiers (the 5 s state republish never wipes what the operator types)', () => {
  const view = (config: unknown, busy = false) => ({ config, busy });
  it('first draw', () => {
    expect(shouldRedrawTiers(null, view(CONFIG), false)).toBe(true);
  });
  it('same server values: no redraw', () => {
    expect(shouldRedrawTiers(view(CONFIG), view({ ...CONFIG }), false)).toBe(false);
  });
  it('a server value changed and nothing is focused: redraw', () => {
    const next = { ...CONFIG, notice: { enabled: true, maxPerDay: 100 } };
    expect(shouldRedrawTiers(view(CONFIG), view(next), false)).toBe(true);
  });
  it('a control is focused: never redraw, even when a value changed', () => {
    const next = { ...CONFIG, integrate: { enabled: true, maxPerDay: 24 } };
    expect(shouldRedrawTiers(view(CONFIG), view(next), true)).toBe(false);
  });
  it('busy changed (controls disable/enable): redraw', () => {
    expect(shouldRedrawTiers(view(CONFIG), view(CONFIG, true), false)).toBe(true);
  });
  it('forced (a change the page did not send): redraw even when focused', () => {
    expect(shouldRedrawTiers(view(CONFIG), view(CONFIG), true, { force: true })).toBe(true);
  });
});

describe('stateParts: the pieces drawState updates in place', () => {
  it('stateHtml is made of them; the tier controls are their own part', () => {
    const parts = stateParts({ running: true, phase: 'sense', config: CONFIG, edges: 3 }, 0);
    expect(parts.main).toContain('sense');
    expect(parts.counts).toContain('3');
    expect(parts.tiers).toContain('data-tier="notice"');
    expect(parts.main).not.toContain('data-tier');
    expect(parts.counts).not.toContain('data-tier');
    expect(parts.button).toContain('watcher-stop');
    const html = stateHtml({ running: true, phase: 'sense', config: CONFIG, edges: 3 }, 0);
    for (const part of [parts.main, parts.counts, parts.tiers, parts.button])
      expect(html).toContain(part);
  });
});
