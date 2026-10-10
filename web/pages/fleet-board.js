/**
 * Fleet Board (`#/board`) — the whole fleet on one screen, as a board.
 *
 * One swimlane per agent: what it is doing right now (live presence), its last
 * cycle, what needs you and its Run/Stop controls, then its goals in To do /
 * In progress / Blocked / Done. Each goal card holds its subtasks. Everything
 * is editable in place: add / rename / delete goals, notes and priority, drag
 * a card to another column, add / tick / rename / reorder / remove subtasks.
 *
 * Data: `/api/agents`, `/api/agents/presence` (live through `watchFleet`) and
 * `/api/agents/:id/home` per agent. Writes: POST / PATCH / DELETE
 * `/api/agents/:id/goals` (GOALS.md, logged as operator goal events). After a
 * write only that agent's lane is re-fetched and repainted.
 */
import { confirmInline, showToast, skeleton } from '../ui/index.js';
import { authedAvatarSrc } from './agent-face.js';
import {
  addTask,
  boardFilterChips,
  boardFilterCounts,
  boardLane,
  filterLanes,
  goalRef,
  moveTask,
  removeTask,
  renameTask,
  toggleTask,
} from './fleet-board-helpers.js';
import { fleetErrorState, sortFleet } from './fleet-home-helpers.js';
import { watchFleet } from './live-presence.js';
import { api } from './shared.js';

const LANE_OPTS = { avatarSrc: authedAvatarSrc };
/** Goals are re-read this often (agents edit them too); presence is live. */
const HOMES_REFRESH_MS = 60_000;
const FILTER_KEY = 'fleetBoard.filter';
const PRIORITY_NEXT = { low: 'medium', medium: 'high', high: 'low' };
const QUICK_PATHS = {
  start: (id) => `/api/agents/${id}/start`,
  'enable-start': (id) => `/api/agents/${id}/start?enable=true`,
  stop: (id) => `/api/agents/${id}/stop`,
  run: (id) => `/api/agent-loop/run/${id}`,
};

let state = null;
let watch = null;
let timer = null;

export function destroyFleetBoard() {
  watch?.stop();
  watch = null;
  clearInterval(timer);
  timer = null;
  state = null;
}

function storage() {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

function lanes() {
  return state.order.map((agent) => ({
    agent,
    presence: state.presence[agent.id],
    home: state.homes[agent.id],
  }));
}

async function loadHome(id) {
  const res = await api(`/api/agents/${encodeURIComponent(id)}/home`).catch(() => null);
  return res && !res.error ? res : null;
}

/** A lane being edited (focused field, open detail panel, dragged card) is left alone. */
function busy(laneEl) {
  return Boolean(
    laneEl &&
      (laneEl.contains(document.activeElement) ||
        laneEl.querySelector('.fb-detail:not([hidden]), .fb-card.dragging, [data-quick]:disabled'))
  );
}

function paintLane(id, { force = false } = {}) {
  if (!state) return;
  const laneEl = state.el.querySelector(`.fb-lane[data-lane="${CSS.escape(id)}"]`);
  const agent = state.agents.find((a) => a.id === id);
  if (!laneEl || !agent || (!force && busy(laneEl))) return;
  laneEl.outerHTML = boardLane(agent, state.presence[id], state.homes[id], Date.now(), LANE_OPTS);
}

function paintBoard() {
  if (!state) return;
  const all = lanes();
  const chips = state.el.querySelector('#fb-chips');
  if (chips) chips.innerHTML = boardFilterChips(state.filter, boardFilterCounts(all));
  const wrap = state.el.querySelector('#fb-lanes');
  if (!wrap) return;
  const shown = filterLanes(all, state.filter);
  wrap.innerHTML = shown.length
    ? shown.map((l) => boardLane(l.agent, l.presence, l.home, Date.now(), LANE_OPTS)).join('')
    : '<div class="text-dim fb-empty">No agents match this filter.</div>';
}

async function reloadLane(id) {
  if (!state) return;
  state.homes[id] = await loadHome(id);
  paintLane(id, { force: true });
}

/** Find the goal object a card stands for (id, else exact title). */
function findGoal(botId, ref) {
  const g = state?.homes[botId]?.goals;
  if (!g) return null;
  const all = [
    ...(g.todo ?? []),
    ...(g.inProgress ?? []),
    ...(g.blocked ?? []),
    ...(g.completedRecently ?? []),
  ];
  return all.find((x) => x.id === ref) ?? all.find((x) => x.text === ref) ?? null;
}

async function goalWrite(botId, method, body, okText) {
  const res = await api(`/api/agents/${encodeURIComponent(botId)}/goals`, { method, body }).catch(
    (err) => ({ error: err?.message })
  );
  if (!res || res.error) {
    showToast(`Could not save: ${res?.error || 'request failed'}`, {
      tone: 'danger',
      duration: 8000,
    });
    await reloadLane(botId);
    return false;
  }
  if (okText) showToast(okText, { tone: 'ok' });
  await reloadLane(botId);
  return true;
}

function saveTasks(botId, goal, tasks) {
  // Optimistic: show the change at once; the reload after the write confirms it.
  goal.tasks = tasks;
  paintLane(botId, { force: true });
  return goalWrite(botId, 'PATCH', { ...goalRef(goal), tasks });
}

/** Swap a text element for an input; Enter / blur saves, Esc cancels. */
function inlineEdit(textEl, initial, onSave) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'fb-inline-input';
  input.value = initial;
  input.maxLength = 200;
  textEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== initial) onSave(value);
    else input.replaceWith(textEl);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function cardContext(target) {
  const card = target.closest('.fb-card');
  if (!card) return null;
  const botId = card.dataset.bot;
  const goal = findGoal(botId, card.dataset.goal);
  return goal ? { card, botId, goal } : null;
}

async function onQuick(btn) {
  const action = btn.dataset.quick;
  const id = btn.dataset.id;
  const path = QUICK_PATHS[action]?.(encodeURIComponent(id));
  if (!path) return;
  const name = state.agents.find((a) => a.id === id)?.name || id;
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
  if (state && action !== 'run') {
    const running = action !== 'stop';
    const p = state.presence[id];
    if (p)
      state.presence[id] = {
        ...p,
        running,
        ...(action === 'enable-start' ? { enabled: true } : {}),
      };
  }
  await reloadLane(id);
}

async function onClick(e) {
  if (!state) return;
  const quick = e.target.closest('[data-quick]');
  if (quick) {
    e.preventDefault();
    await onQuick(quick);
    return;
  }
  const filter = e.target.closest('[data-board-filter]');
  if (filter) {
    state.filter = filter.dataset.boardFilter;
    storage()?.setItem(FILTER_KEY, state.filter);
    paintBoard();
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  if (action === 'reload-lane') {
    await reloadLane(el.closest('.fb-lane')?.dataset.lane);
    return;
  }
  const ctx = cardContext(el);
  if (!ctx) return;
  const { card, botId, goal } = ctx;
  const tasks = goal.tasks ?? [];
  const i = Number(el.closest('[data-task]')?.dataset.task);

  switch (action) {
    case 'edit-title':
      inlineEdit(el, goal.text, (title) => goalWrite(botId, 'PATCH', { ...goalRef(goal), title }));
      break;
    case 'toggle-detail': {
      const panel = card.querySelector('.fb-detail');
      if (panel) panel.hidden = !panel.hidden;
      break;
    }
    case 'cycle-priority':
      await goalWrite(botId, 'PATCH', {
        ...goalRef(goal),
        priority: PRIORITY_NEXT[goal.priority] ?? 'medium',
      });
      break;
    case 'save-notes': {
      const notes = card.querySelector('.fb-detail textarea')?.value ?? '';
      card.querySelector('.fb-detail').hidden = true;
      await goalWrite(botId, 'PATCH', { ...goalRef(goal), notes }, 'Notes saved');
      break;
    }
    case 'delete-goal':
      if (confirmInline(el, { label: 'Click again to delete' })) {
        card.querySelector('.fb-detail').hidden = true;
        await goalWrite(botId, 'DELETE', goalRef(goal), `Deleted "${goal.text}"`);
      }
      break;
    case 'task-up':
    case 'task-down': {
      const next = moveTask(tasks, i, action === 'task-up' ? -1 : 1);
      if (next !== tasks) await saveTasks(botId, goal, next);
      break;
    }
    case 'remove-task':
      await saveTasks(botId, goal, removeTask(tasks, i));
      break;
    default:
      break;
  }
}

async function onChange(e) {
  if (!state || e.target.dataset.action !== 'toggle-task') return;
  const ctx = cardContext(e.target);
  if (!ctx) return;
  const i = Number(e.target.closest('[data-task]')?.dataset.task);
  await saveTasks(ctx.botId, ctx.goal, toggleTask(ctx.goal.tasks ?? [], i));
}

function onDblClick(e) {
  const textEl = e.target.closest('[data-action="edit-task"]');
  if (!textEl || !state) return;
  const ctx = cardContext(textEl);
  if (!ctx) return;
  const i = Number(textEl.closest('[data-task]')?.dataset.task);
  const tasks = ctx.goal.tasks ?? [];
  inlineEdit(textEl, tasks[i]?.text ?? '', (text) =>
    saveTasks(ctx.botId, ctx.goal, renameTask(tasks, i, text))
  );
}

async function onSubmit(e) {
  const form = e.target.closest('form[data-action]');
  if (!form || !state) return;
  e.preventDefault();
  const input = form.querySelector('input');
  const value = input?.value.trim() ?? '';
  if (!value) return;
  input.value = '';
  if (form.dataset.action === 'add-goal') {
    const botId = form.closest('.fb-col')?.dataset.bot;
    if (botId) await goalWrite(botId, 'POST', { title: value });
    return;
  }
  if (form.dataset.action === 'add-task') {
    const ctx = cardContext(form);
    if (ctx) await saveTasks(ctx.botId, ctx.goal, addTask(ctx.goal.tasks ?? [], value));
  }
}

function wireDrag(root) {
  let dragged = null;
  const clearOver = () =>
    root.querySelectorAll('.fb-col.drag-over').forEach((c) => c.classList.remove('drag-over'));
  root.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.fb-card[draggable="true"]');
    if (!card) return;
    dragged = {
      bot: card.dataset.bot,
      goal: card.dataset.goal,
      from: card.closest('.fb-col')?.dataset.col,
    };
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.goal || '');
  });
  root.addEventListener('dragend', (e) => {
    e.target.closest?.('.fb-card')?.classList.remove('dragging');
    clearOver();
    dragged = null;
  });
  root.addEventListener('dragover', (e) => {
    const col = e.target.closest('.fb-col');
    // Goals belong to one agent: only that agent's columns accept the card.
    if (!col || !dragged || col.dataset.bot !== dragged.bot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!col.classList.contains('drag-over')) {
      clearOver();
      col.classList.add('drag-over');
    }
  });
  root.addEventListener('dragleave', (e) => {
    const col = e.target.closest('.fb-col');
    if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
  });
  root.addEventListener('drop', async (e) => {
    const col = e.target.closest('.fb-col');
    if (!col || !dragged || col.dataset.bot !== dragged.bot) return;
    e.preventDefault();
    clearOver();
    const { bot, goal: ref, from } = dragged;
    dragged = null;
    if (col.dataset.col === from || !state) return;
    const goal = findGoal(bot, ref);
    if (goal) await goalWrite(bot, 'PATCH', { ...goalRef(goal), status: col.dataset.status });
  });
}

export async function renderFleetBoard(el) {
  destroyFleetBoard();
  el.innerHTML = `<div class="page-title">Fleet board</div>${skeleton({ lines: 6 })}`;

  const [agentsRes, presenceRes] = await Promise.all([
    api('/api/agents').catch((err) => ({ error: err?.message || 'Request failed' })),
    api('/api/agents/presence').catch(() => null),
  ]);
  if (!Array.isArray(agentsRes)) {
    el.innerHTML = `<div class="page-title">Fleet board</div>${fleetErrorState(agentsRes?.error)}`;
    el.querySelector('[data-action="fleet-retry"]')?.addEventListener('click', () =>
      renderFleetBoard(el)
    );
    return;
  }
  const agents = agentsRes;
  const presence = presenceRes?.agents ?? {};
  const homeList = await Promise.all(agents.map((a) => loadHome(a.id)));
  const homes = Object.fromEntries(agents.map((a, n) => [a.id, homeList[n]]));
  const saved = storage()?.getItem(FILTER_KEY);

  state = {
    el,
    agents,
    presence,
    homes,
    order: sortFleet(agents, presence),
    filter: ['all', 'working', 'needs'].includes(saved) ? saved : 'all',
  };

  el.innerHTML = `<div class="fb-root">
    <div class="fleet-head">
      <div>
        <div class="page-title">Fleet board</div>
        <div class="fleet-sub text-dim">Every agent, what it is doing, and its goals and subtasks. Click to edit, drag cards between columns.</div>
      </div>
      <div class="fleet-head-actions">
        <a class="btn btn-sm" href="#/">Cards</a>
        <a class="btn btn-sm" href="#/automations/loop">Loop controls</a>
        <a class="btn btn-sm btn-primary" href="#/agents/new">+ New agent</a>
      </div>
    </div>
    <div id="fb-chips"></div>
    <div id="fb-lanes" class="fb-lanes"></div>
  </div>`;
  paintBoard();

  // Listeners live on the board's own root, which the next page replaces: none leak.
  const root = el.querySelector('.fb-root');
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('dblclick', onDblClick);
  root.addEventListener('submit', onSubmit);
  wireDrag(root);

  watch = watchFleet({
    onPresence: (body) => {
      if (!state || !body?.agents) return;
      state.presence = body.agents;
      for (const a of state.agents) paintLane(a.id);
      const chips = state.el.querySelector('#fb-chips');
      if (chips) chips.innerHTML = boardFilterChips(state.filter, boardFilterCounts(lanes()));
    },
  });
  timer = setInterval(async () => {
    if (!state) return;
    for (const a of state.agents) {
      const laneEl = state.el.querySelector(`.fb-lane[data-lane="${CSS.escape(a.id)}"]`);
      if (busy(laneEl)) continue;
      state.homes[a.id] = (await loadHome(a.id)) ?? state.homes[a.id];
      paintLane(a.id);
    }
  }, HOMES_REFRESH_MS);
}
