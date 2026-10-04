import { describe, expect, it } from 'bun:test';
import {
  SAVE_SECTIONS,
  dirtySections,
  jumpLinksMarkup,
  saveBarMarkup,
  saveSummary,
  stableStringify,
} from '../../web/pages/settings-helpers.js';

describe('stableStringify', () => {
  it('ignores key order, keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 })
    );
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe('dirtySections', () => {
  const base = { session: { a: 1 }, claudeCli: { model: '' }, skillFolders: { paths: ['x'] } };
  it('lists only the sections whose value changed, in SAVE_SECTIONS order', () => {
    const cur = {
      session: { a: 1 },
      claudeCli: { model: 'opus' },
      skillFolders: { paths: ['x', 'y'] },
    };
    expect(dirtySections(base, cur)).toEqual(['skillFolders', 'claudeCli']);
  });
  it('is empty when nothing changed', () => {
    expect(dirtySections(base, structuredClone(base))).toEqual([]);
  });
  it('every save section has an id, label and anchor', () => {
    for (const s of SAVE_SECTIONS) {
      expect(s.id).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.anchor).toMatch(/^settings-/);
    }
  });
});

describe('saveBarMarkup', () => {
  it('is empty with nothing dirty', () => {
    expect(saveBarMarkup([])).toBe('');
  });
  it('names the dirty sections and offers Discard and Save', () => {
    const html = saveBarMarkup(['claudeCli', 'session']);
    expect(html).toContain('Claude CLI');
    expect(html).toContain('Group activation');
    expect(html).toContain('data-savebar="save"');
    expect(html).toContain('data-savebar="discard"');
    expect(html).toContain('2 sections');
  });
  it('shows per-section errors, escaped', () => {
    const html = saveBarMarkup(['claudeCli'], { errors: { claudeCli: 'bad <x>' } });
    expect(html).toContain('bad &lt;x&gt;');
    expect(html).toContain('settings-savebar-error');
  });
  it('disables the buttons while saving', () => {
    expect(saveBarMarkup(['claudeCli'], { saving: true })).toContain('disabled');
  });
});

describe('saveSummary', () => {
  it('reports success with restart hints', () => {
    expect(saveSummary([{ id: 'skillFolders' }, { id: 'claudeCli' }])).toEqual({
      tone: 'ok',
      text: 'Saved Skill folders, Claude CLI (skill folders apply on restart)',
    });
  });
  it('reports partial failure', () => {
    const r = saveSummary([{ id: 'claudeCli' }, { id: 'session', error: 'nope' }]);
    expect(r.tone).toBe('danger');
    expect(r.text).toContain('1 of 2');
    expect(r.text).toContain('Group activation');
  });
});

describe('jumpLinksMarkup', () => {
  it('links to every section anchor without changing the hash route', () => {
    const html = jumpLinksMarkup([{ anchor: 'settings-a', label: 'A <b>' }]);
    expect(html).toContain('data-jump="settings-a"');
    expect(html).toContain('A &lt;b&gt;');
    expect(html).not.toContain('href="#settings-a"');
  });
});
