/**
 * Global keyboard shortcuts — the DOM half (UX overhaul wave 2). The key
 * logic lives in shortcuts-helpers.js.
 *
 * Two listeners on `window`:
 *  - bubble phase, so page-local handlers on `document` run first; anything a
 *    page consumed (`preventDefault`) is skipped, e.g. Needs You's own `?`;
 *  - capture phase, only while `g` is armed, so the area letter is not
 *    also read by a page (Needs You's `a`, Agent Home's `e`…).
 * Every function here no-ops without a DOM.
 */
import { openSheet } from './sheet.js';
import {
  GLOBAL_SHORTCUTS,
  G_TIMEOUT_MS,
  goTarget,
  helpSheetMarkup,
  initialShortcutState,
  pageShortcutsFor,
  resolveShortcut,
  shouldIgnoreKey,
} from './shortcuts-helpers.js';

const PENDING_ID = 'ui-shortcut-pending';

let deps = {
  /** () => { multiTenant, role } */
  ctx: () => ({}),
  /** (href) => void */
  navigate: (href) => {
    if (typeof location !== 'undefined') location.hash = href;
  },
  /** () => boolean — false on the login screen. */
  canUse: () => true,
};

let state = initialShortcutState();
let pendingTimer = null;
let registered = null;

/** A page's own key list for the help sheet; returns the unregister function. */
export function registerPageShortcuts(list) {
  registered = Array.isArray(list) ? list : null;
  const mine = registered;
  return () => {
    if (registered === mine) registered = null;
  };
}

export function clearPageShortcuts() {
  registered = null;
}

function overlayOpen() {
  if (typeof document === 'undefined') return false;
  if (document.getElementById('ui-dialog-root')) return true;
  if (document.getElementById('ui-sheet-root')) return true;
  if (document.body.classList.contains('ui-palette-open')) return true;
  const modal = document.getElementById('modal-overlay');
  return Boolean(modal && !modal.classList.contains('hidden'));
}

function showPending(on) {
  clearTimeout(pendingTimer);
  pendingTimer = null;
  let el = document.getElementById(PENDING_ID);
  if (!on) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = PENDING_ID;
    el.className = 'ui-shortcut-pending';
    el.setAttribute('role', 'status');
    el.innerHTML = '<kbd>g</kbd> then h · a · n · w · u · i · s';
    document.body.appendChild(el);
  }
  pendingTimer = setTimeout(() => {
    state = initialShortcutState();
    showPending(false);
  }, G_TIMEOUT_MS);
}

function visible(el) {
  return Boolean(el && (el.offsetParent !== null || el.getClientRects?.().length));
}

/** The first visible element matching `selector` inside the page slot. */
function pageElement(selector) {
  const scope = document.getElementById('page') ?? document;
  return [...scope.querySelectorAll(selector)].find(visible) ?? null;
}

export function openShortcutHelp() {
  openSheet({
    title: 'Keyboard shortcuts',
    body: helpSheetMarkup(GLOBAL_SHORTCUTS, pageShortcutsFor(registered)),
  });
}

/** Runs an action; true when it did something (the key is then consumed). */
function act(action) {
  switch (action?.type) {
    case 'arm-g':
      showPending(true);
      return true;
    case 'cancel-g':
      showPending(false);
      return true;
    case 'go': {
      showPending(false);
      const href = goTarget(action.area, deps.ctx());
      if (href) deps.navigate(href);
      return true;
    }
    case 'focus-filter': {
      const el = pageElement('[data-page-filter]');
      if (!el) return false;
      el.focus();
      if (typeof el.select === 'function' && el.tagName === 'INPUT') el.select();
      return true;
    }
    case 'new': {
      const el = pageElement('[data-page-new]');
      if (!el) return false;
      el.click();
      return true;
    }
    case 'help':
      openShortcutHelp();
      return true;
    default:
      return false;
  }
}

function handle(e) {
  const r = resolveShortcut(state, e, Date.now());
  state = r.state;
  if (act(r.action)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function onCapture(e) {
  if (!state.pendingG || !deps.canUse()) return;
  if (shouldIgnoreKey(e, { overlayOpen: overlayOpen() })) {
    state = initialShortcutState();
    showPending(false);
    return;
  }
  // Shift alone (on its way to a letter) must not cancel the jump.
  if (e.key === 'Shift') return;
  handle(e);
}

function onBubble(e) {
  if (state.pendingG || !deps.canUse()) return;
  if (shouldIgnoreKey(e, { overlayOpen: overlayOpen() })) return;
  handle(e);
}

/** Install once from app.js. */
export function initShortcuts(opts = {}) {
  deps = { ...deps, ...opts };
  if (typeof window === 'undefined') return;
  window.addEventListener('keydown', onCapture, true);
  window.addEventListener('keydown', onBubble);
}
