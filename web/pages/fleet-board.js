/**
 * Fleet Board — `#/board` (overview) and `#/board/:id` (one agent's board).
 *
 * Overview: one compact row per agent (who + plain-language state → focus →
 * up next → needs you), search, filters, j/k/Enter. Board: the agent's goals in
 * In progress / Up next / Blocked / Done; a card opens a drawer with status,
 * priority, title (headline), subtasks, brief, notes and delete. Markup lives in
 * fleet-board-helpers.js (pure, tested).
 *
 * Data: `/api/agents`, `/api/agents/presence` (live via `watchFleet`) and
 * `/api/agents/:id/home` per agent, cached for a short while so moving between
 * the overview and boards is instant. Writes: POST / PATCH / DELETE
 * `/api/agents/:id/goals`; after a write only that agent's goals are re-read.
 */
import { confirmInline, showToast, skeleton } from '../ui/index.js';
import { authedAvatarSrc } from './agent-face.js';
import {
  addTask,
  agentBoardHtml,
  drawerHtml,
  filterLanes,
  fleetPulse,
  goalRef,
  moveTask,
  overviewRow,
  removeTask,
  renameTask,
  toggleTask,
} from './fleet-board-helpers.js';
import { fleetErrorState, sortFleet } from './fleet-home-helpers.js';
import { watchFleet } from './live-presence.js';
import { api, escapeHtml } from './shared.js';

const OPTS = { avatarSrc: authedAvatarSrc };
const CACHE_MS = 30_000;
const REFRESH_MS = 60_000;
const FILTER_KEY = 'fleetBoard.filter';
const QUICK_PATHS = {
  start: (id) => `/api/agents/${id}/start`,
  'enable-start': (id) => `/api/agents/${id}/start?enable=true`,
  stop: (id) => `/api/agents/${id}/stop`,
  run: (id) => `/api/agent-loop/run/${id}`,
};

/** Survives page switches (overview ↔ board) so navigation does not refetch everything. */
let cache = null;
let state = null;
let watch = null;
let timer = null;
let onKey = null;

export function destroyFleetBoard() {
  watch?.stop();
  watch = null;
  clearInterval(timer);
  timer = null;
  if (onKey) document.removeEventListener('keydown', onKey);
  onKey = null;
  document.querySelector('.fb-drawer')?.remove();
  document.querySelector('.fb-scrim')?.remove();
  state = null;
}

async function loadHome(id) {
  const res = await api(`/api/agents/${encodeURIComponent(id)}/home`).catch(() => null);
  return res && !res.error ? res : null;
}

async function loadAll() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const [agents, presence] = await Promise.all([
    api('/api/agents').catch((err) => ({ error: err?.message || 'Request failed' })),
    api('/api/agents/presence').catch(() => null),
  ]);
  if (!Array.isArray(agents)) return { error: agents?.error || 'Request failed' };
  const homes = await Promise.all(agents.map((a) => loadHome(a.id)));
  cache = {
    at: Date.now(),
    agents,
    presence: presence?.agents ?? {},
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

function findGoal(botId, ref) {
  const g = cache?.homes[botId]?.goals;
  if (!g || !ref) return null;
  const all = [
    ...(g.inProgress ?? []),
    ...(g.todo ?? []),
    ...(g.blocked ?? []),
    ...(g.completedRecently ?? []),
  ];
  return all.find((x) => x.id === ref) ?? all.find((x) => x.text === ref) ?? null;
}

// ── painting ──

function paintOverview() {
  const el = state.el.querySelector('#fb-rows');
  if (!el) return;
  const all = lanes();
  const shown = filterLanes(all, state.filter, state.query);
  if (state.kb >= shown.length) state.kb = Math.max(0, shown.length - 1);
  state.shown = shown.map((l) => l.agent.id);
  el.innerHTML = shown.length
    ? shown.map((l, i) => overviewRow(l, i, { ...OPTS, selected: i === state.kb })).join('')
    : '<div class="fb-dim fb-none">No agents match.</div>';
  const p = fleetPulse(all);
  const pulse = state.el.querySelector('#fb-pulse');
  if (pulse) {
    pulse.innerHTML = `<div><b>${p.agents}</b><span>agents</span></div><div class="live"><b>${p.working}</b><span>working now</span></div><div class="hot"><b>${p.waiting}</b><span>waiting on you</span></div><div><b>${p.openGoals}</b><span>open goals</span></div>`;
  }
  state.el.querySelectorAll('[data-filter]').forEach((b) => {
    b.classList.toggle('on', b.dataset.filter === state.filter);
  });
}

function renderOverviewShell() {
  state.el.innerHTML = `<div class="fb-root">
    <div class="fb-top">
      <div>
        <div class="page-title">Fleet board</div>
        <div class="fb-pulse" id="fb-pulse"></div>
      </div>
      <div class="fb-tools">
        <input class="fb-search" id="fb-q" placeholder="Search agents and goals…" value="${escapeHtml(state.query)}" aria-label="Search">
        <div class="fb-seg">
          <button type="button" data-filter="all">All</button>
          <button type="button" data-filter="live">Working</button>
          <button type="button" data-filter="needs">Needs you</button>
        </div>
        <a class="btn btn-sm" href="#/">Cards</a>
        <a class="btn btn-sm btn-primary" href="#/agents/new">+ New agent</a>
      </div>
    </div>
    <section class="fb-fleet" aria-label="Agents">
      <div class="fb-fleet-head"><span>Agent</span><span>Focus</span><span>Up next</span><span>Needs you</span><span></span></div>
      <div id="fb-rows"></div>
    </section>
    <div class="fb-foot-hint"><span class="fb-kbd">j</span> <span class="fb-kbd">k</span> move · <span class="fb-kbd">Enter</span> open · click a row to see its board</div>
  </div>`;
  paintOverview();
}

function paintBoard() {
  const root = state.el.querySelector('.fb-root');
  const lane = lanes().find((l) => l.agent.id === state.agentId);
  if (!root) return;
  if (!lane) {
    root.innerHTML = `<div class="fb-crumbs"><a href="#/board">← Fleet board</a></div><div class="fb-error">No agent "${escapeHtml(state.agentId)}".</div>`;
    return;
  }
  root.innerHTML = agentBoardHtml(lane, lanes(), { ...OPTS, selectedRef: state.goalRef });
}

function paintDrawer() {
  const drawer = document.querySelector('.fb-drawer');
  const scrim = document.querySelector('.fb-scrim');
  const goal = state && findGoal(state.agentId, state.goalRef);
  if (!drawer || !scrim) return;
  const open = Boolean(goal);
  drawer.classList.toggle('on', open);
  scrim.classList.toggle('on', open);
  if (!open) return;
  const agent = cache.agents.find((a) => a.id === state.agentId);
  drawer.innerHTML = drawerHtml(agent, goal);
}

function busy() {
  const a = document.activeElement;
  return Boolean(
    a && (a.closest?.('.fb-drawer') || a.matches?.('input, textarea, [contenteditable]'))
  );
}

function repaint({ force = false } = {}) {
  if (!state || (!force && busy())) return;
  if (state.view === 'overview') paintOverview();
  else {
    paintBoard();
    paintDrawer();
  }
}

// ── writes ──

async function reloadAgent(id) {
  const home = await loadHome(id);
  if (cache) cache.homes[id] = home;
}

async function goalWrite(method, body, okText) {
  const id = state.agentId;
  const res = await api(`/api/agents/${encodeURIComponent(id)}/goals`, { method, body }).catch(
    (err) => ({ error: err?.message })
  );
  const ok = res && !res.error;
  if (!ok)
    showToast(`Could not save: ${res?.error || 'request failed'}`, {
      tone: 'danger',
      duration: 8000,
    });
  else if (okText) showToast(okText, { tone: 'ok' });
  await reloadAgent(id);
  if (!state) return ok;
  // A goal without an id gets one on its first write: follow it by id from now on.
  const g = findGoal(id, state.goalRef) ?? (body.brief ? findGoal(id, body.brief) : null);
  if (state.goalRef && g) state.goalRef = g.id || g.text;
  if (method === 'DELETE') state.goalRef = null;
  repaint({ force: true });
  return ok;
}

function currentGoal() {
  return state && findGoal(state.agentId, state.goalRef);
}

function saveTasks(goal, tasks) {
  goal.tasks = tasks;
  paintDrawer();
  paintBoard();
  return goalWrite('PATCH', { ...goalRef(goal), tasks });
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
    {
      tone: 'ok',
    }
  );
  if (action !== 'run' && cache.presence[id]) {
    cache.presence[id] = { ...cache.presence[id], running: action !== 'stop' };
  }
  await reloadAgent(id);
  repaint({ force: true });
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
    paintOverview();
    return;
  }
  if (t.closest('[data-reload]')) {
    await reloadAgent(state.agentId);
    repaint({ force: true });
    return;
  }
  const card = t.closest('.fb-card[data-goal]');
  if (card) {
    state.goalRef = card.dataset.goal;
    paintBoard();
    paintDrawer();
    return;
  }
  if (t.closest('[data-close]') || t.classList.contains('fb-scrim')) {
    state.goalRef = null;
    paintBoard();
    paintDrawer();
    return;
  }
  const goal = currentGoal();
  if (!goal || !t.closest('.fb-drawer')) return;
  const st = t.closest('[data-st]');
  if (st) {
    await goalWrite('PATCH', { ...goalRef(goal), status: st.dataset.st });
    return;
  }
  const pr = t.closest('[data-pri]');
  if (pr) {
    await goalWrite('PATCH', { ...goalRef(goal), priority: pr.dataset.pri });
    return;
  }
  const li = t.closest('.fb-task');
  const i = li ? Number(li.dataset.i) : -1;
  if (t.closest('[data-tdel]')) {
    await saveTasks(goal, removeTask(goal.tasks ?? [], i));
    return;
  }
  const mv = t.closest('[data-tmove]');
  if (mv) {
    const next = moveTask(goal.tasks ?? [], i, Number(mv.dataset.tmove));
    if (next !== goal.tasks) await saveTasks(goal, next);
    return;
  }
  if (t.id === 'fb-morebrief') {
    document.getElementById('fb-brief')?.classList.remove('clamp');
    t.remove();
    return;
  }
  if (t.id === 'fb-editbrief') {
    const box = document.getElementById('fb-brief');
    if (box) {
      box.outerHTML = `<textarea class="fb-edit" id="fb-briefed" maxlength="1000">${escapeHtml(goal.text)}</textarea><div class="fb-edit-row"><button type="button" class="btn btn-sm btn-primary" id="fb-savebrief">Save brief</button><button type="button" class="btn btn-sm" data-cancel>Cancel</button></div>`;
      document.getElementById('fb-morebrief')?.remove();
      document.getElementById('fb-briefed')?.focus();
    }
    return;
  }
  if (t.id === 'fb-savebrief') {
    const brief = document.getElementById('fb-briefed')?.value.trim();
    if (brief) await goalWrite('PATCH', { ...goalRef(goal), brief }, 'Brief saved');
    return;
  }
  if (t.id === 'fb-editnotes') {
    const box = document.getElementById('fb-notes');
    if (box) {
      box.innerHTML = `<textarea class="fb-edit" id="fb-notesed" maxlength="600">${escapeHtml(goal.notes ?? '')}</textarea><div class="fb-edit-row"><button type="button" class="btn btn-sm btn-primary" id="fb-savenotes">Save notes</button><button type="button" class="btn btn-sm" data-cancel>Cancel</button></div>`;
      document.getElementById('fb-notesed')?.focus();
    }
    return;
  }
  if (t.id === 'fb-savenotes') {
    const notes = document.getElementById('fb-notesed')?.value ?? '';
    await goalWrite('PATCH', { ...goalRef(goal), notes }, 'Notes saved');
    return;
  }
  if (t.closest('[data-cancel]')) {
    paintDrawer();
    return;
  }
  if (t.id === 'fb-del' && confirmInline(t, { label: 'Click again to delete' })) {
    await goalWrite('DELETE', goalRef(goal), 'Goal deleted');
  }
}

async function onChange(e) {
  const li = e.target.closest?.('.fb-task');
  const goal = currentGoal();
  if (!li || !goal || e.target.type !== 'checkbox') return;
  await saveTasks(goal, toggleTask(goal.tasks ?? [], Number(li.dataset.i)));
}

async function onFocusOut(e) {
  const goal = currentGoal();
  if (!goal) return;
  if (e.target.id === 'fb-title') {
    const v = e.target.value.replace(/\s+/g, ' ').trim();
    const shown = e.target.defaultValue.replace(/\s+/g, ' ').trim();
    if (v && v !== shown)
      await goalWrite('PATCH', { ...goalRef(goal), headline: v }, 'Title saved');
    return;
  }
  if (e.target.classList?.contains('fb-tx')) {
    const i = Number(e.target.closest('.fb-task')?.dataset.i);
    const v = e.target.textContent.trim();
    const tasks = goal.tasks ?? [];
    if (!v) await saveTasks(goal, removeTask(tasks, i));
    else if (v !== tasks[i]?.text) await saveTasks(goal, renameTask(tasks, i, v));
  }
}

function onInput(e) {
  if (e.target.id !== 'fb-q' || !state) return;
  state.query = e.target.value;
  state.kb = 0;
  paintOverview();
}

async function keydown(e) {
  if (!state) return;
  const t = e.target;
  const inField = t.matches?.('input, textarea, [contenteditable]');
  if (e.key === 'Enter' && t.id === 'fb-addtask' && t.value.trim()) {
    const goal = currentGoal();
    const text = t.value;
    t.value = '';
    if (goal) await saveTasks(goal, addTask(goal.tasks ?? [], text));
    document.getElementById('fb-addtask')?.focus();
    return;
  }
  if (e.key === 'Enter' && t.matches?.('[data-addgoal]') && t.value.trim()) {
    const title = t.value.trim();
    t.value = '';
    await goalWrite('POST', { title }, 'Goal added to Up next');
    state?.el.querySelector('[data-addgoal]')?.focus();
    return;
  }
  if (e.key === 'Enter' && (t.id === 'fb-title' || t.classList?.contains('fb-tx'))) {
    e.preventDefault();
    t.blur();
    return;
  }
  if (e.key === 'Escape') {
    if (inField) {
      t.blur();
      return;
    }
    if (state.goalRef) {
      state.goalRef = null;
      paintBoard();
      paintDrawer();
    } else if (state.view === 'board') location.hash = '#/board';
    return;
  }
  if (inField || state.view !== 'overview') return;
  if (e.key === 'j' || e.key === 'k') {
    const max = (state.shown?.length ?? 1) - 1;
    state.kb = Math.max(0, Math.min(max, state.kb + (e.key === 'j' ? 1 : -1)));
    paintOverview();
    state.el.querySelector('.fb-row.kb')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && state.shown?.[state.kb]) {
    location.hash = `#/board/${encodeURIComponent(state.shown[state.kb])}`;
  }
}

function wireDrag(root) {
  let dragged = null;
  const clear = () =>
    root.querySelectorAll('.fb-col.over').forEach((c) => c.classList.remove('over'));
  root.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.fb-card[draggable="true"]');
    if (!card) return;
    dragged = { ref: card.dataset.goal, from: card.closest('.fb-col')?.dataset.status };
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged.ref);
  });
  root.addEventListener('dragend', (e) => {
    e.target.closest?.('.fb-card')?.classList.remove('dragging');
    clear();
    dragged = null;
  });
  root.addEventListener('dragover', (e) => {
    const col = e.target.closest('.fb-col');
    if (!col || !dragged) return;
    e.preventDefault();
    if (!col.classList.contains('over')) {
      clear();
      col.classList.add('over');
    }
  });
  root.addEventListener('drop', async (e) => {
    const col = e.target.closest('.fb-col');
    if (!col || !dragged) return;
    e.preventDefault();
    clear();
    const { ref, from } = dragged;
    dragged = null;
    if (col.dataset.status === from) return;
    const goal = findGoal(state.agentId, ref);
    if (goal) await goalWrite('PATCH', { ...goalRef(goal), status: col.dataset.status });
  });
}

export async function renderFleetBoard(el, agentId) {
  destroyFleetBoard();
  if (!cache) el.innerHTML = `<div class="page-title">Fleet board</div>${skeleton({ lines: 6 })}`;
  const data = await loadAll();
  if (data.error) {
    el.innerHTML = `<div class="page-title">Fleet board</div>${fleetErrorState(data.error)}`;
    el.querySelector('[data-action="fleet-retry"]')?.addEventListener('click', () =>
      renderFleetBoard(el, agentId)
    );
    return;
  }
  const saved = localStorage.getItem(FILTER_KEY);
  state = {
    el,
    view: agentId ? 'board' : 'overview',
    agentId: agentId ?? null,
    goalRef: null,
    filter: ['all', 'live', 'needs'].includes(saved) ? saved : 'all',
    query: '',
    kb: 0,
    shown: [],
  };
  if (state.view === 'overview') renderOverviewShell();
  else {
    el.innerHTML = '<div class="fb-root"></div>';
    paintBoard();
  }
  // The drawer sits outside the page container so it can overlay everything.
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div class="fb-scrim"></div><aside class="fb-drawer" aria-label="Goal"></aside>'
  );

  const root = el.querySelector('.fb-root');
  const drawer = document.querySelector('.fb-drawer');
  const scrim = document.querySelector('.fb-scrim');
  for (const target of [root, drawer]) {
    target.addEventListener('click', onClick);
    target.addEventListener('change', onChange);
    target.addEventListener('focusout', onFocusOut);
  }
  scrim.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  wireDrag(root);
  onKey = keydown;
  document.addEventListener('keydown', onKey);

  watch = watchFleet({
    onPresence: (body) => {
      if (!state || !body?.agents || !cache) return;
      cache.presence = body.agents;
      repaint();
    },
  });
  timer = setInterval(async () => {
    if (!state || busy()) return;
    const ids = state.view === 'board' ? [state.agentId] : cache.agents.map((a) => a.id);
    for (const id of ids) await reloadAgent(id);
    repaint();
  }, REFRESH_MS);
}
