/**
 * Command palette — the DOM half (session S8 of docs/plans/jarvis-fleet-plan.md).
 *
 * Ctrl+K / Cmd+K anywhere (not while typing in a field, unless the palette
 * is already open) opens a dialog that searches agents, pages and actions
 * (see palette-helpers.js). Arrow keys move, Enter runs, Esc closes. Agents
 * come from /api/agents, fetched lazily on first open and cached 30 s.
 * Every function here no-ops without a DOM.
 */
import {
  RECENTS_KEY,
  buildItems,
  isEditableTarget,
  isPaletteHotkey,
  moveIndex,
  paletteMarkup,
  paletteShell,
  pushRecent,
  rankItems,
} from './palette-helpers.js';
import { currentTheme, toggleTheme } from './theme.js';
import { showToast } from './toast.js';

const AGENTS_TTL_MS = 30_000;
const ROOT_ID = 'ui-palette-root';

let deps = {
  /** () => Promise<agent[]> — the /api/agents list. */
  loadAgents: async () => [],
  /** () => { multiTenant, role } — the nav visibility context. */
  ctx: () => ({}),
  /** (path, { method }) => Promise<json> — the authed API helper. */
  api: null,
  /** (href) => void */
  navigate: (href) => {
    if (typeof location !== 'undefined') location.hash = href;
  },
  /** () => boolean — false while the login screen shows. */
  canOpen: () => true,
};

let state = null;
let agentsCache = { at: 0, agents: [] };

function readRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function storeRecents(list) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    /* private mode, quota — the recents are a convenience */
  }
}

export function isPaletteOpen() {
  return state !== null;
}

function render() {
  if (!state) return;
  state.results = rankItems(state.items, state.query, { recents: readRecents() });
  if (state.active >= state.results.length) state.active = 0;
  state.list.innerHTML = paletteMarkup(state.results, state.active, { query: state.query });
  state.list.querySelector('.ui-palette-row.active')?.scrollIntoView?.({ block: 'nearest' });
}

function rebuildItems() {
  if (!state) return;
  state.items = buildItems({
    agents: agentsCache.agents,
    ctx: deps.ctx(),
    theme: currentTheme(),
  });
  render();
}

async function refreshAgents() {
  if (Date.now() - agentsCache.at < AGENTS_TTL_MS) return;
  try {
    const agents = await deps.loadAgents();
    if (Array.isArray(agents)) agentsCache = { at: Date.now(), agents };
  } catch {
    /* keep whatever we had */
  }
  rebuildItems();
}

export function invalidateAgents() {
  agentsCache = { at: 0, agents: agentsCache.agents };
}

async function run(item) {
  if (!item) return;
  storeRecents(pushRecent(readRecents(), item.id));
  closePalette();
  if (item.theme) {
    toggleTheme();
    return;
  }
  if (item.api) {
    if (!deps.api) return;
    try {
      const res = await deps.api(item.api.path, { method: item.api.method || 'POST' });
      if (res?.error) showToast(res.error, { tone: 'danger' });
      else showToast(item.label, { tone: 'ok' });
    } catch (err) {
      showToast(err?.message || 'Action failed', { tone: 'danger' });
    }
    invalidateAgents();
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('badges:refresh'));
    return;
  }
  if (item.href) deps.navigate(item.href);
}

function onKeyWhileOpen(e) {
  if (!state) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    state.active = moveIndex(state.active, e.key === 'ArrowDown' ? 1 : -1, state.results.length);
    render();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    run(state.results[state.active]);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePalette();
  }
}

function onGlobalKey(e) {
  if (isPaletteHotkey(e)) {
    if (!isPaletteOpen() && isEditableTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (isPaletteOpen()) closePalette();
    else openPalette();
    return;
  }
  if (isPaletteOpen()) onKeyWhileOpen(e);
}

export function openPalette() {
  if (typeof document === 'undefined' || isPaletteOpen() || !deps.canOpen()) return;
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.innerHTML = paletteShell();
  document.body.appendChild(root);
  document.body.classList.add('ui-palette-open');
  const input = root.querySelector('#ui-palette-input');
  const list = root.querySelector('#ui-palette-list');
  state = { root, input, list, items: [], results: [], active: 0, query: '' };

  input.addEventListener('input', () => {
    state.query = input.value;
    state.active = 0;
    render();
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest?.('[data-index]');
    if (row) run(state.results[Number(row.dataset.index)]);
  });
  list.addEventListener('mousemove', (e) => {
    const row = e.target.closest?.('[data-index]');
    if (!row) return;
    const i = Number(row.dataset.index);
    if (i !== state.active) {
      state.active = i;
      render();
    }
  });
  for (const el of root.querySelectorAll('[data-palette-close]')) {
    el.addEventListener('click', closePalette);
  }

  rebuildItems();
  refreshAgents();
  if (typeof requestAnimationFrame === 'function')
    requestAnimationFrame(() => root.classList.add('show'));
  else root.classList.add('show');
  input.focus();
}

export function closePalette() {
  if (typeof document === 'undefined') return;
  document.getElementById(ROOT_ID)?.remove();
  document.body.classList.remove('ui-palette-open');
  state = null;
}

export function togglePalette() {
  if (isPaletteOpen()) closePalette();
  else openPalette();
}

/**
 * Install the global hotkey and wire every `[data-palette-open]` button.
 * Call once from app.js.
 */
export function initPalette(opts = {}) {
  deps = { ...deps, ...opts };
  if (typeof document === 'undefined') return;
  document.addEventListener('keydown', onGlobalKey, true);
  for (const el of document.querySelectorAll('[data-palette-open]')) {
    el.addEventListener('click', () => openPalette());
  }
}
