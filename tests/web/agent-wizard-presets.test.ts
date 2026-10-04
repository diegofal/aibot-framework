/**
 * Preset prefill in the wizard (session S7 of docs/plans/jarvis-fleet-plan.md).
 * Pure helpers only: `applyPresetToState`, the preset strip markup, and the
 * advanced skills / tools / loop fields that a preset fills and the payload
 * carries. The catalogue itself is served by GET /api/agents/presets; here a
 * fixture mirrors its shape.
 */
import { describe, expect, it } from 'bun:test';
import {
  CUSTOM_PRESET,
  applyField,
  applyPresetToState,
  buildCreatePayload,
  canCreate,
  initialState,
  parseList,
  presetStrip,
  stepWho,
  validateStep,
} from '../../web/pages/agent-wizard-helpers.js';

const RESEARCHER = {
  id: 'researcher',
  name: 'Scout',
  emoji: '🔬',
  description: 'Researcher: digs into a question and comes back with a cited brief.',
  purpose: 'Digs into any question I hand it and comes back with a short cited brief.',
  personality: { warmth: 0.4, boldness: 0.4, rigor: 0.9, playfulness: 0.3 },
  quirks: 'Cites every claim.',
  skills: ['intel-gatherer', 'quick-notes'],
  disabledTools: ['twitter_post', 'exec'],
  agentLoop: { every: '6h', mode: 'periodic' },
  goals: [{ text: 'Keep a list of open questions', priority: 'high' }],
};

describe('applyPresetToState', () => {
  it('prefills purpose, sliders, quirks, emoji and the advanced skills/tools/loop fields', () => {
    const s = applyPresetToState(initialState(), RESEARCHER);
    expect(s.preset).toBe('researcher');
    expect(s.purpose).toBe(RESEARCHER.purpose);
    expect(s.personality).toEqual(RESEARCHER.personality);
    expect(s.quirks).toBe(RESEARCHER.quirks);
    expect(s.advanced.emoji).toBe('🔬');
    expect(s.advanced.skills).toBe('intel-gatherer, quick-notes');
    expect(s.advanced.disabledTools).toBe('twitter_post, exec');
    expect(s.advanced.loopEvery).toBe('6h');
    expect(s.advanced.loopMode).toBe('periodic');
  });

  it('suggests the name (and derives the id) only when the name box is empty', () => {
    const fresh = applyPresetToState(initialState(), RESEARCHER);
    expect(fresh.name).toBe('Scout');
    expect(fresh.id).toBe('scout');
    const named = applyPresetToState(applyField(initialState(), 'name', 'Ada'), RESEARCHER);
    expect(named.name).toBe('Ada');
    expect(named.id).toBe('ada');
  });

  it("a second preset replaces the first preset's values but never what the user typed after", () => {
    let s = applyPresetToState(initialState(), RESEARCHER);
    s = applyField(s, 'quirks', 'My own quirks');
    s = applyField(s, 'personality.warmth', 0.95);
    const other = {
      ...RESEARCHER,
      id: 'coder',
      name: 'Forge',
      quirks: 'Tests first.',
      purpose: 'Builds software.',
    };
    const t = applyPresetToState(s, other);
    expect(t.preset).toBe('coder');
    expect(t.purpose).toBe('Builds software.');
    expect(t.quirks).toBe('My own quirks');
    expect(t.personality.warmth).toBe(0.95);
    expect(t.personality.rigor).toBe(0.9);
    // The name came from the first preset (untouched by the user), so the second one may replace it.
    expect(t.name).toBe('Forge');
    expect(t.id).toBe('forge');
  });

  it('CUSTOM_PRESET (or null) clears the preset id and the fields the preset filled, keeping user text', () => {
    let s = applyPresetToState(initialState(), RESEARCHER);
    s = applyField(s, 'purpose', 'Mine.');
    const c = applyPresetToState(s, CUSTOM_PRESET);
    expect(c.preset).toBe('');
    expect(c.purpose).toBe('Mine.');
    expect(c.quirks).toBe('');
    expect(c.personality).toEqual({ warmth: 0.5, boldness: 0.5, rigor: 0.5, playfulness: 0.5 });
    expect(c.advanced.skills).toBe('');
    expect(c.advanced.loopEvery).toBe('');
    expect(c.name).toBe('');
    expect(applyPresetToState(s, null).preset).toBe('');
  });

  it('is immutable and leaves the wizard valid on every step for a preset with no channels', () => {
    const before = initialState();
    const snapshot = JSON.stringify(before);
    const s = applyPresetToState(before, RESEARCHER);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(s).not.toBe(before);
    expect(canCreate(s)).toBe(true);
    expect(validateStep(s, 0).ok).toBe(true);
  });
});

describe('parseList', () => {
  it('splits on commas, whitespace and newlines, trims, drops empties and duplicates', () => {
    expect(parseList('a, b,,c\n d a')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseList('')).toEqual([]);
    expect(parseList(null)).toEqual([]);
    expect(parseList(['x', ' y '])).toEqual(['x', 'y']);
  });
});

describe('buildCreatePayload with a preset', () => {
  it('carries preset, skills, disabledTools and agentLoop; omits them when empty', () => {
    const s = applyPresetToState(initialState(), RESEARCHER);
    const body = buildCreatePayload(s);
    expect(body.preset).toBe('researcher');
    expect(body.skills).toEqual(['intel-gatherer', 'quick-notes']);
    expect(body.disabledTools).toEqual(['twitter_post', 'exec']);
    expect(body.agentLoop).toEqual({ every: '6h', mode: 'periodic' });
    expect(body.emoji).toBe('🔬');
    expect(body.purpose).toBe(RESEARCHER.purpose);

    const plain = buildCreatePayload(
      applyField(applyField(initialState(), 'name', 'Ada'), 'purpose', 'Keeps my list alive.')
    );
    expect(plain.preset).toBeUndefined();
    expect(plain.skills).toBeUndefined();
    expect(plain.disabledTools).toBeUndefined();
    expect(plain.agentLoop).toBeUndefined();
  });

  it('a user-edited loop cadence or mode overrides the preset in the payload', () => {
    let s = applyPresetToState(initialState(), RESEARCHER);
    s = applyField(s, 'advanced.loopEvery', '30m');
    s = applyField(s, 'advanced.loopMode', 'continuous');
    expect(buildCreatePayload(s).agentLoop).toEqual({ every: '30m', mode: 'continuous' });
    s = applyField(s, 'advanced.loopEvery', '');
    expect(buildCreatePayload(s).agentLoop).toEqual({ mode: 'continuous' });
  });

  it('rejects a malformed loop cadence on the channels step', () => {
    let s = applyPresetToState(initialState(), RESEARCHER);
    s = applyField(s, 'advanced.loopEvery', 'soon');
    const { ok, errors } = validateStep(s, 2);
    expect(ok).toBe(false);
    expect(errors['advanced.loopEvery']).toContain('like');
    expect(validateStep(applyField(s, 'advanced.loopEvery', '2h'), 2).ok).toBe(true);
    expect(validateStep(applyField(s, 'advanced.loopEvery', '45m'), 2).ok).toBe(true);
    expect(validateStep(applyField(s, 'advanced.loopEvery', '1d'), 2).ok).toBe(true);
  });
});

describe('presetStrip / stepWho', () => {
  it('renders a Custom card first, then one card per preset, marking the selected one', () => {
    const html = presetStrip([RESEARCHER], 'researcher');
    const cards = html.match(/data-preset="[^"]*"/g) ?? [];
    expect(cards).toEqual(['data-preset=""', 'data-preset="researcher"']);
    expect(html).toContain('wizard-preset-selected');
    expect(html.indexOf('wizard-preset-selected')).toBeGreaterThan(html.indexOf('data-preset=""'));
    expect(html).toContain('🔬');
    expect(html).toContain('Scout');
    expect(html).toContain('cited brief');
    expect(html).toContain('aria-pressed="true"');
  });

  it('escapes preset text and marks Custom when nothing is selected', () => {
    const evil = { ...RESEARCHER, id: 'x', name: '<b>Bad</b>', description: 'a & b' };
    const html = presetStrip([evil], '');
    expect(html).not.toContain('<b>Bad</b>');
    expect(html).toContain('&lt;b&gt;Bad&lt;/b&gt;');
    expect(html).toContain('a &amp; b');
    const custom = html.slice(0, html.indexOf('data-preset="x"'));
    expect(custom).toContain('wizard-preset-selected');
  });

  it('shows a loading note while the catalogue is null and nothing when it is empty', () => {
    expect(presetStrip(null, '')).toContain('wizard-presets-loading');
    expect(presetStrip([], '')).toBe('');
  });

  it('stepWho places the strip above the name field and still renders without presets', () => {
    const s = applyPresetToState(initialState(), RESEARCHER);
    const html = stepWho(s, {}, { presets: [RESEARCHER] });
    expect(html.indexOf('wizard-presets')).toBeLessThan(html.indexOf('id="wiz-name"'));
    expect(html).toContain('value="Scout"');
    expect(stepWho(initialState())).toContain('id="wiz-name"');
    expect(stepWho(initialState())).not.toContain('wizard-presets-loading');
  });
});
