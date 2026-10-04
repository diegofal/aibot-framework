/**
 * Global keyboard shortcuts — the pure half (UX overhaul wave 2).
 *
 *   g then a letter   jump to an area (h Home, a Agents, n Needs You, w Work,
 *                     u aUtomations, i Insights, s Settings)
 *   /                 focus the page's `[data-page-filter]`
 *   n                 click the page's `[data-page-new]`
 *   ?                 help sheet: these keys plus the current page's keys
 *
 * `web/ui/shortcuts.js` owns the DOM. Not re-exported from `web/ui/index.js`
 * (this module imports nav-routes, which imports that barrel).
 * Tests: tests/web/shortcuts-helpers.test.ts.
 */
import { AREAS, areaHref, visibleAreas } from '../nav-routes.js';
import { esc } from './escape.js';

export const G_TIMEOUT_MS = 1500;

export const GO_KEYS = {
  h: 'home',
  a: 'agents',
  n: 'needs',
  w: 'work',
  u: 'automations',
  i: 'insights',
  s: 'settings',
};

export const GLOBAL_SHORTCUTS = [
  ['g then h', 'Home'],
  ['g then a', 'Agents'],
  ['g then n', 'Needs You'],
  ['g then w', 'Work'],
  ['g then u', 'Automations'],
  ['g then i', 'Insights'],
  ['g then s', 'Settings'],
  ['/', 'Focus the search / filter on this page'],
  ['n', 'New item on this page (where there is one)'],
  ['Ctrl/⌘ + K', 'Command palette: jump to an agent, a page or an action'],
  ['?', 'Show these shortcuts'],
];

/**
 * The current page's keys for the help sheet: whatever it passed to
 * `registerPageShortcuts` (shortcuts.js) on render, or none. Each page keeps
 * its list next to its own key handling, e.g. `WORK_SHORTCUTS` in work-helpers.js.
 */
export function pageShortcutsFor(registered = null) {
  return Array.isArray(registered) ? registered : [];
}

export function initialShortcutState() {
  return { pendingG: false, gAt: 0 };
}

function isTyping(el) {
  if (!el) return false;
  const tag = String(el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * true when a global shortcut must not act on this keydown: typing in a
 * field, a Ctrl/Cmd/Alt chord (the palette owns Ctrl/Cmd+K), a page already
 * handled it, or a dialog / sheet / the palette is open.
 */
export function shouldIgnoreKey(e, { overlayOpen = false } = {}) {
  if (!e) return true;
  if (e.defaultPrevented) return true;
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  if (overlayOpen) return true;
  return isTyping(e.target);
}

/** `{ state, action }` for a keydown that passed `shouldIgnoreKey`. */
export function resolveShortcut(state, e, nowMs = Date.now()) {
  const s = state ?? initialShortcutState();
  const k = String(e?.key ?? '');
  const armed = s.pendingG && nowMs - s.gAt <= G_TIMEOUT_MS;
  const idle = initialShortcutState();
  if (armed) {
    const area = GO_KEYS[k];
    return { state: idle, action: area ? { type: 'go', area } : { type: 'cancel-g' } };
  }
  if (k === 'g') return { state: { pendingG: true, gAt: nowMs }, action: { type: 'arm-g' } };
  if (k === '/') return { state: idle, action: { type: 'focus-filter' } };
  if (k === 'n') return { state: idle, action: { type: 'new' } };
  if (k === '?') return { state: idle, action: { type: 'help' } };
  return { state: idle, action: null };
}

/** Where `g <letter>` goes: the sidebar link of the area, or null when the viewer can't see it. */
export function goTarget(areaId, ctx = {}) {
  const area = visibleAreas(ctx).find((a) => a.id === areaId);
  if (!area || !AREAS.includes(area)) return null;
  return areaHref(area, ctx);
}

function rows(list) {
  return list
    .map(([keys, what]) => `<tr><td><kbd>${esc(keys)}</kbd></td><td>${esc(what)}</td></tr>`)
    .join('');
}

/** Body of the help sheet. */
export function helpSheetMarkup(globalKeys = GLOBAL_SHORTCUTS, pageKeys = []) {
  const page =
    Array.isArray(pageKeys) && pageKeys.length > 0
      ? `<div class="shortcuts-group">This page</div><table class="shortcuts-table">${rows(pageKeys)}</table>`
      : '';
  return `<div class="shortcuts-help"><div class="shortcuts-group">Global</div><table class="shortcuts-table">${rows(
    globalKeys
  )}</table>${page}</div>`;
}
