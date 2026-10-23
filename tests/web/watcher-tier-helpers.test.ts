import { describe, expect, it } from 'bun:test';
import {
  applyWatcherEvent,
  createWatcherModel,
  mergeWatcherState,
  stateHtml,
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
