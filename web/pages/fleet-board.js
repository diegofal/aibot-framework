/**
 * Fleet Board — `#/board` (and `#/board/:id`, the same view with that agent open).
 *
 * One screen: a compact line per agent (state, focus, goal and subtask counts,
 * how much waits on you). Click a line to expand it in place: what the agent is
 * doing, the actual items waiting on you (from Needs You), its controls, and
 * its goals in four compact columns. A card opens the goal drawer (title,
 * status, priority, subtasks, brief, notes, delete). Markup lives in
 * fleet-board-helpers.js (pure, tested).
 *
 * Data: `/api/agents`, `/api/agents/presence` (live via `watchFleet`),
 * `/api/needs-you`, and `/api/agents/:id/home` per agent; cached briefly.
 * Writes: POST / PATCH / DELETE `/api/agents/:id/goals`.
 */
import { confirmInline, showToast, skeleton } from '../ui/index.js';
import { authedAvatarSrc } from './agent-face.js';
import {
  addTask,
  agentLine,
  drawerHtml,
  filterLanes,
  fleetPulse,
  goalRef,
  moveTask,
  needsByBot,
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

function lineHtml(lane, i) {
  const id = lane.agent.id;
  return agentLine(lane, cache.needs[id] ?? [], {
    ...OPTS,
    expanded: state.open.has(id),
    selected: i === state.kb,
    selectedRef: state.drawer?.botId === id ? state.drawer.ref : null,
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

function paintDrawer() {
  const drawer = document.querySelector('.fb-drawer');
  const scrim = document.querySelector('.fb-scrim');
  const goal = state?.drawer && findGoal(state.drawer.botId, state.drawer.ref);
  if (!drawer || !scrim) return;
  drawer.classList.toggle('on', Boolean(goal));
  scrim.classList.toggle('on', Boolean(goal));
  if (!goal) return;
  const agent = cache.agents.find((a) => a.id === state.drawer.botId);
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
  paintList();
  paintDrawer();
}

// ── writes ──

async function reloadAgent(id) {
  const home = await loadHome(id);
  if (cache) cache.homes[id] = home;
}

async function goalWrite(botId, method, body, okText) {
  const res = await api(`/api/agents/${encodeURIComponent(botId)}/goals`, { method, body }).catch(
    (err) => ({ error: err?.message })
  );
  const ok = res && !res.error;
  if (!ok)
    showToast(`Could not save: ${res?.error || 'request failed'}`, {
      tone: 'danger',
      duration: 8000,
    });
  else if (okText) showToast(okText, { tone: 'ok' });
  await reloadAgent(botId);
  if (!state) return ok;
  if (state.drawer?.botId === botId) {
    if (method === 'DELETE') state.drawer = null;
    else {
      // A goal without an id gets one on its first write: follow it by id from now on.
      const g =
        findGoal(botId, state.drawer.ref) ?? (body.brief ? findGoal(botId, body.brief) : null);
      if (g) state.drawer.ref = g.id || g.text;
    }
  }
  paintRow(botId);
  paintDrawer();
  return ok;
}

function currentGoal() {
  return state?.drawer ? findGoal(state.drawer.botId, state.drawer.ref) : null;
}

function saveTasks(goal, tasks) {
  goal.tasks = tasks;
  paintDrawer();
  paintRow(state.drawer.botId);
  return goalWrite(state.drawer.botId, 'PATCH', { ...goalRef(goal), tasks });
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
  const card = t.closest('.fb-card[data-goal]');
  if (card) {
    const botId = card.closest('[data-row]')?.dataset.row;
    if (botId) {
      state.drawer = { botId, ref: card.dataset.goal };
      paintRow(botId);
      paintDrawer();
    }
    return;
  }
  if (t.closest('[data-close]') || t.classList.contains('fb-scrim')) {
    const botId = state.drawer?.botId;
    state.drawer = null;
    if (botId) paintRow(botId);
    paintDrawer();
    return;
  }
  const goal = currentGoal();
  if (!goal || !t.closest('.fb-drawer')) return;
  const botId = state.drawer.botId;
  const st = t.closest('[data-st]');
  if (st) {
    await goalWrite(botId, 'PATCH', { ...goalRef(goal), status: st.dataset.st });
    return;
  }
  const pr = t.closest('[data-pri]');
  if (pr) {
    await goalWrite(botId, 'PATCH', { ...goalRef(goal), priority: pr.dataset.pri });
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
    const box = document.getElementById('fb-brief')?.closest('.fb-brief');
    if (box) {
      box.outerHTML = `<textarea class="fb-edit" id="fb-briefed" maxlength="1000">${escapeHtml(goal.text)}</textarea><div class="fb-edit-row"><button type="button" class="btn btn-sm btn-primary" id="fb-savebrief">Save brief</button><button type="button" class="btn btn-sm" data-cancel>Cancel</button></div>`;
      document.getElementById('fb-morebrief')?.remove();
      document.getElementById('fb-briefed')?.focus();
    }
    return;
  }
  if (t.id === 'fb-savebrief') {
    const brief = document.getElementById('fb-briefed')?.value.trim();
    if (brief) await goalWrite(botId, 'PATCH', { ...goalRef(goal), brief }, 'Brief saved');
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
    await goalWrite(botId, 'PATCH', { ...goalRef(goal), notes }, 'Notes saved');
    return;
  }
  if (t.closest('[data-cancel]')) {
    paintDrawer();
    return;
  }
  if (t.id === 'fb-del' && confirmInline(t, { label: 'Click again to delete' })) {
    await goalWrite(botId, 'DELETE', goalRef(goal), 'Goal deleted');
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
    if (v && v !== shown) {
      await goalWrite(
        state.drawer.botId,
        'PATCH',
        { ...goalRef(goal), headline: v },
        'Title saved'
      );
    }
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
  paintList();
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
    const botId = t.closest('[data-row]')?.dataset.row;
    const title = t.value.trim();
    t.value = '';
    if (botId) await goalWrite(botId, 'POST', { title }, 'Goal added to Up next');
    state?.el
      .querySelector(`.fb-agent-row[data-row="${CSS.escape(botId)}"] [data-addgoal]`)
      ?.focus();
    return;
  }
  if (e.key === 'Enter' && (t.id === 'fb-title' || t.classList?.contains('fb-tx'))) {
    e.preventDefault();
    t.blur();
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && t.matches?.('[data-toggle]')) {
    e.preventDefault();
    toggleRow(t.dataset.toggle);
    return;
  }
  if (e.key === 'Escape') {
    if (inField) {
      t.blur();
      return;
    }
    if (state.drawer) {
      const botId = state.drawer.botId;
      state.drawer = null;
      paintRow(botId);
      paintDrawer();
    }
    return;
  }
  if (inField || state.drawer) return;
  if (e.key === 'j' || e.key === 'k') {
    const max = (state.shown?.length ?? 1) - 1;
    state.kb = Math.max(0, Math.min(max, state.kb + (e.key === 'j' ? 1 : -1)));
    paintList();
    state.el.querySelector('.fb-agent-row.kb')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && state.shown?.[state.kb]) {
    toggleRow(state.shown[state.kb]);
  }
}

function wireDrag(root) {
  let dragged = null;
  const clear = () =>
    root.querySelectorAll('.fb-col.over').forEach((c) => c.classList.remove('over'));
  root.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.fb-card[draggable="true"]');
    if (!card) return;
    dragged = {
      botId: card.closest('[data-row]')?.dataset.row,
      ref: card.dataset.goal,
      from: card.closest('.fb-col')?.dataset.status,
    };
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
    // Goals belong to one agent: only that agent's columns accept the card.
    if (!col || !dragged || col.closest('[data-row]')?.dataset.row !== dragged.botId) return;
    e.preventDefault();
    if (!col.classList.contains('over')) {
      clear();
      col.classList.add('over');
    }
  });
  root.addEventListener('drop', async (e) => {
    const col = e.target.closest('.fb-col');
    if (!col || !dragged || col.closest('[data-row]')?.dataset.row !== dragged.botId) return;
    e.preventDefault();
    clear();
    const { botId, ref, from } = dragged;
    dragged = null;
    if (col.dataset.status === from) return;
    const goal = findGoal(botId, ref);
    if (goal) await goalWrite(botId, 'PATCH', { ...goalRef(goal), status: col.dataset.status });
  });
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
    drawer: null,
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
