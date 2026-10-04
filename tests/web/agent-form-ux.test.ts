import { describe, expect, it } from 'bun:test';
import {
  editReturnHash,
  editSectionNav,
  isSaveShortcut,
  snapshotForm,
  tokenCell,
} from '../../web/pages/agent-form-helpers.js';
import { homeKeyAction, isTypingTarget } from '../../web/pages/agent-home-helpers.js';

describe('editReturnHash', () => {
  it('returns to config, home or the list when that is where the user came from', () => {
    expect(editReturnHash('b1', '#/agents/b1/config')).toBe('#/agents/b1/config');
    expect(editReturnHash('b1', '#/agents/b1')).toBe('#/agents/b1');
    expect(editReturnHash('b1', '#/agents')).toBe('#/agents');
  });
  it('falls back to the agent home for anything else', () => {
    expect(editReturnHash('b1', '#/needs')).toBe('#/agents/b1');
    expect(editReturnHash('b1', '#/agents/other/config')).toBe('#/agents/b1');
    expect(editReturnHash('b1', null)).toBe('#/agents/b1');
    expect(editReturnHash('b 1', '')).toBe('#/agents/b%201');
  });
  it('matches an encoded id', () => {
    expect(editReturnHash('b 1', '#/agents/b%201/config')).toBe('#/agents/b%201/config');
  });
});

describe('snapshotForm', () => {
  it('is stable for the same values and changes when a value changes', () => {
    const fields = [
      { name: 'name', type: 'text', value: 'Ada' },
      { name: 'enabled', type: 'checkbox', value: 'on', checked: true },
      { name: 'skills', type: 'checkbox', value: 'a', checked: false },
      { name: '', type: 'button', value: 'x' },
    ];
    const a = snapshotForm(fields);
    expect(snapshotForm(fields.map((f) => ({ ...f })))).toBe(a);
    expect(snapshotForm([{ ...fields[0], value: 'Bea' }, ...fields.slice(1)])).not.toBe(a);
    expect(snapshotForm([fields[0], { ...fields[1], checked: false }, ...fields.slice(2)])).not.toBe(
      a
    );
  });
  it('ignores unnamed fields', () => {
    expect(snapshotForm([{ name: '', value: 'x' }])).toBe(snapshotForm([]));
  });
});

describe('isSaveShortcut', () => {
  it('accepts Ctrl+S and Cmd+S, rejects plain s and Alt combos', () => {
    expect(isSaveShortcut({ key: 's', ctrlKey: true })).toBe(true);
    expect(isSaveShortcut({ key: 'S', metaKey: true })).toBe(true);
    expect(isSaveShortcut({ key: 's' })).toBe(false);
    expect(isSaveShortcut({ key: 's', ctrlKey: true, altKey: true })).toBe(false);
    expect(isSaveShortcut({ key: 'k', ctrlKey: true })).toBe(false);
  });
});

describe('editSectionNav', () => {
  it('renders one jump button per section, escaped, without hash hrefs', () => {
    const html = editSectionNav([
      { id: 'sec-general', label: 'General' },
      { id: 'sec-loop', label: 'Agent <Loop>' },
    ]);
    expect(html).toContain('data-jump="sec-general"');
    expect(html).toContain('Agent &lt;Loop&gt;');
    expect(html).not.toContain('href="#');
  });
});

describe('tokenCell', () => {
  it('hides the token behind Show and Copy buttons', () => {
    const html = tokenCell('1234****abcd');
    expect(html).toContain('data-token-toggle');
    expect(html).toContain('data-token-copy');
    expect(html).toContain('data-token-value="1234****abcd"');
    expect(html).not.toContain('>1234****abcd<');
  });
  it('says headless for an empty token', () => {
    expect(tokenCell('')).toContain('None');
    expect(tokenCell('')).not.toContain('data-token-copy');
  });
  it('escapes', () => {
    expect(tokenCell('"><x>')).toContain('&quot;&gt;&lt;x&gt;');
  });
});

describe('agent home keys', () => {
  const el = (tagName, extra = {}) => ({ tagName, ...extra });
  it('detects typing targets', () => {
    expect(isTypingTarget(el('INPUT'))).toBe(true);
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('SELECT'))).toBe(true);
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true);
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
  it('maps r / e / c outside inputs', () => {
    expect(homeKeyAction({ key: 'r', target: el('BODY') })).toBe('run');
    expect(homeKeyAction({ key: 'e', target: el('BODY') })).toBe('edit');
    expect(homeKeyAction({ key: 'c', target: el('A') })).toBe('chat');
    expect(homeKeyAction({ key: 'x', target: el('BODY') })).toBe(null);
  });
  it('ignores keys while typing or with modifiers', () => {
    expect(homeKeyAction({ key: 'r', target: el('TEXTAREA') })).toBe(null);
    expect(homeKeyAction({ key: 'r', ctrlKey: true, target: el('BODY') })).toBe(null);
    expect(homeKeyAction({ key: 'e', metaKey: true, target: el('BODY') })).toBe(null);
    expect(homeKeyAction({ key: 'c', altKey: true, target: el('BODY') })).toBe(null);
    expect(homeKeyAction({ key: 'r', defaultPrevented: true, target: el('BODY') })).toBe(null);
  });
});
