import { describe, expect, it } from 'bun:test';
import {
  GLOBAL_SHORTCUTS,
  GO_KEYS,
  G_TIMEOUT_MS,
  PAGE_SHORTCUTS,
  goTarget,
  helpSheetMarkup,
  initialShortcutState,
  pageShortcutsFor,
  resolveShortcut,
  shouldIgnoreKey,
} from '../../web/ui/shortcuts-helpers.js';

const key = (k: string, extra: Record<string, unknown> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  target: { tagName: 'BODY' },
  ...extra,
});

describe('shouldIgnoreKey', () => {
  it('ignores typing targets', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(shouldIgnoreKey(key('g', { target: { tagName } }))).toBe(true);
    }
    expect(shouldIgnoreKey(key('g', { target: { tagName: 'DIV', isContentEditable: true } }))).toBe(
      true
    );
  });

  it('ignores Ctrl / Cmd / Alt chords and already-handled events', () => {
    expect(shouldIgnoreKey(key('k', { ctrlKey: true }))).toBe(true);
    expect(shouldIgnoreKey(key('k', { metaKey: true }))).toBe(true);
    expect(shouldIgnoreKey(key('g', { altKey: true }))).toBe(true);
    expect(shouldIgnoreKey(key('?', { defaultPrevented: true }))).toBe(true);
  });

  it('ignores keys while a dialog, sheet or the palette is open', () => {
    expect(shouldIgnoreKey(key('g'), { overlayOpen: true })).toBe(true);
  });

  it('lets plain keys and Shift (for "?") through', () => {
    expect(shouldIgnoreKey(key('g'))).toBe(false);
    expect(shouldIgnoreKey(key('?', { shiftKey: true }))).toBe(false);
    expect(shouldIgnoreKey(null)).toBe(true);
  });
});

describe('resolveShortcut', () => {
  const T0 = 1_000_000;

  it('g arms the jump, then a letter goes to the area', () => {
    const a = resolveShortcut(initialShortcutState(), key('g'), T0);
    expect(a.action).toEqual({ type: 'arm-g' });
    expect(a.state.pendingG).toBe(true);
    const b = resolveShortcut(a.state, key('n'), T0 + 300);
    expect(b.action).toEqual({ type: 'go', area: 'needs' });
    expect(b.state.pendingG).toBe(false);
  });

  it('maps every documented area letter', () => {
    expect(GO_KEYS).toEqual({
      h: 'home',
      a: 'agents',
      n: 'needs',
      w: 'work',
      u: 'automations',
      i: 'insights',
      s: 'settings',
    });
  });

  it('an unknown letter after g cancels without acting', () => {
    const a = resolveShortcut(initialShortcutState(), key('g'), T0);
    const b = resolveShortcut(a.state, key('z'), T0 + 10);
    expect(b.action).toEqual({ type: 'cancel-g' });
    expect(b.state.pendingG).toBe(false);
  });

  it('a pending g expires after G_TIMEOUT_MS', () => {
    const a = resolveShortcut(initialShortcutState(), key('g'), T0);
    const b = resolveShortcut(a.state, key('n'), T0 + G_TIMEOUT_MS + 1);
    // Expired: "n" is read on its own (new).
    expect(b.action).toEqual({ type: 'new' });
  });

  it('/ focuses the page filter, n clicks new, ? opens help', () => {
    const s = initialShortcutState();
    expect(resolveShortcut(s, key('/'), T0).action).toEqual({ type: 'focus-filter' });
    expect(resolveShortcut(s, key('n'), T0).action).toEqual({ type: 'new' });
    expect(resolveShortcut(s, key('?', { shiftKey: true }), T0).action).toEqual({ type: 'help' });
  });

  it('other keys do nothing', () => {
    expect(resolveShortcut(initialShortcutState(), key('q'), T0).action).toBeNull();
    expect(resolveShortcut(initialShortcutState(), key('N', { shiftKey: true }), T0).action).toBe(
      null
    );
  });
});

describe('goTarget', () => {
  it('uses the area link the sidebar uses (first visible tab)', () => {
    expect(goTarget('home', {})).toBe('#/');
    expect(goTarget('needs', {})).toBe('#/needs');
    expect(goTarget('automations', {})).toBe('#/automations/cron');
    expect(goTarget('insights', {})).toBe('#/insights/stats');
    expect(goTarget('nope', {})).toBeNull();
  });

  it('returns null for an area the viewer cannot see', () => {
    // A tenant sees no Settings tab (every one is admin or BaaS-only without multi-tenant).
    expect(goTarget('settings', { multiTenant: false, role: 'tenant' })).toBeNull();
  });
});

describe('page shortcuts and the help sheet', () => {
  it('collects the keys each page documented', () => {
    expect(pageShortcutsFor('needsYou').map((r) => r[0])).toContain('x');
    expect(pageShortcutsFor('work').map((r) => r[0])).toContain('a');
    expect(pageShortcutsFor('dispatches').map((r) => r[0])).toContain('+ / =');
    expect(pageShortcutsFor('agentHome').map((r) => r[0])).toEqual(['r', 'e', 'c']);
    expect(pageShortcutsFor('agentEdit').map((r) => r[0])).toContain('Ctrl/⌘ + S');
    expect(pageShortcutsFor('settings').map((r) => r[0])).toContain('Ctrl/⌘ + S');
    expect(pageShortcutsFor('nope')).toEqual([]);
    expect(Object.keys(PAGE_SHORTCUTS).length).toBeGreaterThan(4);
  });

  it('registered keys win over the defaults', () => {
    expect(pageShortcutsFor('work', [['z', 'Zap']])).toEqual([['z', 'Zap']]);
  });

  it('renders global keys and the page keys, escaped', () => {
    const html = helpSheetMarkup(GLOBAL_SHORTCUTS, [['<x>', 'Do <b>']]);
    expect(html).toContain('Global');
    expect(html).toContain('g then h');
    expect(html).toContain('Ctrl/⌘ + K');
    expect(html).toContain('This page');
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<b>');
  });

  it('omits the page section when the page has no keys', () => {
    expect(helpSheetMarkup(GLOBAL_SHORTCUTS, [])).not.toContain('This page');
  });
});
