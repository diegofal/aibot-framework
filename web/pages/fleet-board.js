/**
 * Fleet Board — `#/board` (and `#/board/:id`, the same view with that agent open).
 *
 * One screen: a compact line per agent (state, focus, goal and subtask counts,
 * how much waits on you). Click a line to expand it in place: what the agent is
 * doing, the actual items waiting on you (from Needs You), its controls, and
 * its goals in four compact columns, each card with its open tasks inline. The
 * board itself (drag, + New goal, inline tasks, the goal drawer) is the shared
 * goal-board.js, the same one Agent Home uses. Markup lives in
 * fleet-board-helpers.js (pure, tested).
 *
 * Data: `/api/agents`, `/api/agents/presence` (live via `watchFleet`),
 * `/api/needs-you`, and `/api/agents/:id/home` per agent; cached briefly.
 * Goal and task writes: see goal-board.js.
 */
import { showToast, skeleton } from '../ui/index.js';
import { authedAvatarSrc } from './agent-face.js';
import { agentLine, filterLanes, fleetPulse, needsByBot } from './fleet-board-helpers.js';
import { fleetErrorState, sortFleet } from './fleet-home-helpers.js';
import { mountGoalBoard } from './goal-board.js';
import { watchFleet } from './live-presence.js';
import { api } from './shared.js';

const OPTS = { avatarSrc: authedAvatarSrc };
const CACHE_MS = 30_000;
const REFRESH_MS = 60_000;
const FILTER_KEY = 'fleetBoard.filter';
const OPEN_KEY = 'fleetBoard.open';
const QUICK_PATHS = {
  start: (id) => `/api/agents/${id}/start`,
  'enable-start': (id) => `/api/agents/${id}/start?enable=true`,
  stop: (id) => `/api/agents/${id}/stop`,
  run: (id) => `/api/agent-loop/run/${id}`,
};

let cache = null;
let state = null;
let watch = null;
let timer = null;
let onKey = null;
let board = null;

export function destroyFleetBoard() {
  watch?.stop();
  watch = null;
  clearInterval(timer);
  timer = null;
  if (onKey) document.removeEventListener('keydown', onKey);
  onKey = null;
  board?.destroy();
  board = null;
  state = null;
}

function readOpen() {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]');
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}
function saveOpen() {
  localStorage.setItem(OPEN_KEY, JSON.stringify([...state.open]));
}

async function loadHome(id) {
  const res = await api(`/api/agents/${encodeURIComponent(id)}/home`).catch(() => null);
  return res && !res.error ? res : null;
}

async function loadNeeds() {
  const res = await api('/api/needs-you').catch(() => null);
  return Array.isArray(res?.items) ? needsByBot(res.items) : null;
}

async function loadAll() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const [agents, presence, needs] = await Promise.all([
    api('/api/agents').catch((err) => ({ error: err?.message || 'Request failed' })),
    api('/api/agents/presence').catch(() => null),
    loadNeeds(),
  ]);
  if (!Array.isArray(agents)) return { error: agents?.error || 'Request failed' };
  const homes = await Promise.all(agents.map((a) => loadHome(a.id)));
  cache = {
    at: Date.now(),
    agents,
    presence: presence?.agents ?? {},
    needs: needs ?? {},
    homes: Object.fromEntries(agents.map((a, i) => [a.id, homes[i]])),
  };
  return cache;
}

function lanes() {
  return sortFleet(cache.agents, cache.presence).map((agent) => ({
    agent,
    presence: cache.presence[agent.id],
    home: cache.homes[agent.id],
  }));
}

// ── painting ──

function lineHtml(lane, i) {
  const id = lane.agent.id;
  return agentLine(lane, cache.needs[id] ?? [], {
    ...OPTS,
    expanded: state.open.has(id),
    selected: i === state.kb,
    selectedRef: board?.selectedRef(id) ?? null,
  });
}

function paintList() {
  const el = state.el.querySelector('#fb-list');
  if (!el) return;
  const all = lanes();
  const shown = filterLanes(all, state.filter, state.query);
  if (state.kb >= shown.length) state.kb = Math.max(0, shown.length - 1);
  state.shown = shown.map((l) => l.agent.id);
  el.innerHTML = shown.length
    ? shown.map(lineHtml).join('')
    : '<div class="fb-dim fb-none">No agents match.</div>';
  const p = fleetPulse(all);
  const pulse = state.el.querySelector('#fb-pulse');
  if (pulse) {
    pulse.innerHTML = `<span><b>${p.agents}</b> agents</span><span class="live"><b>${p.working}</b> working</span><span class="hot"><b>${p.waiting}</b> waiting on you</span><span><b>${p.openGoals}</b> open goals</span>`;
  }
  state.el.querySelectorAll('[data-filter]').forEach((b) => {
    b.classList.toggle('on', b.dataset.filter === state.filter);
  });
}

/** Repaint one agent's line in place (cheap; keeps scroll position). */
function paintRow(id) {
  const row = state.el.querySelector(`.fb-agent-row[data-row="${CSS.escape(id)}"]`);
  const i = state.shown.indexOf(id);
  const lane = lanes().find((l) => l.agent.id === id);
  if (row && lane && i >= 0) row.outerHTML = lineHtml(lane, i);
}

function busy() {
  const a = document.activeElement;
  return Boolean(
    a && (a.closest?.('.fb-drawer') || a.matches?.('input, textarea, [contenteditable]'))
  );
}

function repaint({ force = false } = {}) {
  if (!state || (!force && busy())) return;
  paintList();
  board?.paintDrawer();
}

// ── writes ──

async function reloadAgent(id) {
  const home = await loadHome(id);
  if (cache) cache.homes[id] = home;
}

function toggleRow(id) {
  if (state.open.has(id)) state.open.delete(id);
  else state.open.add(id);
  saveOpen();
  paintRow(id);
}

async function onQuick(btn) {
  const action = btn.dataset.quick;
  const id = btn.dataset.id;
  const path = QUICK_PATHS[action]?.(encodeURIComponent(id));
  if (!path) return;
  const name = cache.agents.find((a) => a.id === id)?.name || id;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = action === 'run' ? 'Running…' : action === 'stop' ? 'Stopping…' : 'Starting…';
  const res = await api(path, { method: 'POST' }).catch((err) => ({ error: err?.message }));
  btn.disabled = false;
  btn.textContent = label;
  if (!res || res.error) {
    showToast(`${name}: ${res?.error || 'request failed'}`, { tone: 'danger', duration: 8000 });
    return;
  }
  showToast(
    `${name} ${action === 'run' ? 'finished a cycle' : action === 'stop' ? 'stopped' : 'started'}`,
    { tone: 'ok' }
  );
  if (action !== 'run' && cache.presence[id]) {
    cache.presence[id] = { ...cache.presence[id], running: action !== 'stop' };
  }
  await reloadAgent(id);
  paintRow(id);
}

// ── events ──

async function onClick(e) {
  if (!state) return;
  const t = e.target;
  const quick = t.closest('[data-quick]');
  if (quick) {
    e.preventDefault();
    await onQuick(quick);
    return;
  }
  const f = t.closest('[data-filter]');
  if (f) {
    state.filter = f.dataset.filter;
    state.kb = 0;
    localStorage.setItem(FILTER_KEY, state.filter);
    paintList();
    return;
  }
  if (t.closest('[data-expand-all]')) {
    for (const id of state.shown) state.open.add(id);
    saveOpen();
    paintList();
    return;
  }
  if (t.closest('[data-collapse-all]')) {
    state.open.clear();
    saveOpen();
    paintList();
    return;
  }
  const reload = t.closest('[data-reload]');
  if (reload) {
    await reloadAgent(reload.dataset.reload);
    paintRow(reload.dataset.reload);
    return;
  }
  const toggle = t.closest('[data-toggle]');
  if (toggle) {
    toggleRow(toggle.dataset.toggle);
    return;
  }
}

function onInput(e) {
  if (e.target.id !== 'fb-q' || !state) return;
  state.query = e.target.value;
  state.kb = 0;
  paintList();
}

function keydown(e) {
  // goal-board.js handled it (a card opened, the drawer closed, a task added).
  if (!state || e.defaultPrevented) return;
  const t = e.target;
  const inField = t.matches?.('input, textarea, [contenteditable]');
  if ((e.key === 'Enter' || e.key === ' ') && t.matches?.('[data-toggle]')) {
    e.preventDefault();
    toggleRow(t.dataset.toggle);
    return;
  }
  if (e.key === 'Escape') {
    if (inField) t.blur();
    return;
  }
  if (inField || board?.isOpen()) return;
  if (e.key === 'j' || e.key === 'k') {
    const max = (state.shown?.length ?? 1) - 1;
    state.kb = Math.max(0, Math.min(max, state.kb + (e.key === 'j' ? 1 : -1)));
    paintList();
    state.el.querySelector('.fb-agent-row.kb')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && state.shown?.[state.kb]) {
    toggleRow(state.shown[state.kb]);
  }
}

export async function renderFleetBoard(el, focusId) {
  destroyFleetBoard();
  if (!cache) el.innerHTML = `<div class="page-title">Fleet board</div>${skeleton({ lines: 6 })}`;
  const data = await loadAll();
  if (data.error) {
    el.innerHTML = `<div class="page-title">Fleet board</div>${fleetErrorState(data.error)}`;
    el.querySelector('[data-action="fleet-retry"]')?.addEventListener('click', () =>
      renderFleetBoard(el, focusId)
    );
    return;
  }
  const saved = localStorage.getItem(FILTER_KEY);
  state = {
    el,
    open: readOpen(),
    filter: ['all', 'live', 'needs'].includes(saved) ? saved : 'all',
    query: '',
    kb: 0,
    shown: [],
  };
  if (focusId) {
    state.open.add(focusId);
    saveOpen();
  }

  el.innerHTML = `<div class="fb-root">
    <div class="fb-top">
      <div class="fb-title-row">
        <div class="page-title">Fleet board</div>
        <div class="fb-pulse" id="fb-pulse"></div>
      </div>
      <div class="fb-tools">
        <input class="fb-search" id="fb-q" placeholder="Search agents and goals…" aria-label="Search">
        <div class="fb-seg">
          <button type="button" data-filter="all">All</button>
          <button type="button" data-filter="live">Working</button>
          <button type="button" data-filter="needs">Needs you</button>
        </div>
        <button type="button" class="btn btn-sm" data-expand-all>Expand all</button>
        <button type="button" class="btn btn-sm" data-collapse-all>Collapse all</button>
        <a class="btn btn-sm" href="#/">Cards</a>
      </div>
    </div>
    <section class="fb-list" id="fb-list" aria-label="Agents"></section>
    <div class="fb-foot-hint">Click a line to open it · <span class="fb-kbd">j</span> <span class="fb-kbd">k</span> move · <span class="fb-kbd">Enter</span> open / close · click a goal to edit it</div>
  </div>`;
  paintList();
  if (focusId) {
    state.el
      .querySelector(`.fb-agent-row[data-row="${CSS.escape(focusId)}"]`)
      ?.scrollIntoView({ block: 'start' });
  }
  const root = el.querySelector('.fb-root');
  // Goal-board keys first, so a key it handled is not also a j / k / Enter here.
  board = mountGoalBoard({
    root,
    getHome: (id) => cache?.homes[id],
    getAgent: (id) => cache?.agents.find((a) => a.id === id),
    reload: reloadAgent,
    paint: paintRow,
  });
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  onKey = keydown;
  document.addEventListener('keydown', onKey);

  watch = watchFleet({
    onPresence: async (body) => {
      if (!state || !body?.agents || !cache) return;
      cache.presence = body.agents;
      const needs = await loadNeeds();
      if (needs && cache) cache.needs = needs;
      repaint();
    },
  });
  timer = setInterval(async () => {
    if (!state || busy()) return;
    for (const id of cache.agents.map((a) => a.id)) await reloadAgent(id);
    repaint();
  }, REFRESH_MS);
}
