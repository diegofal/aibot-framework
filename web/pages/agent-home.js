/**
 * Agent Home — the agent as a person on one screen (session S2 of
 * docs/plans/jarvis-fleet-plan.md).
 *
 * Presence header (live), needs-you strip, a chat panel that talks to the
 * agent through the dashboard conversations API, the timeline, then goals,
 * traits, karma and the memory history (consolidations, facts saved,
 * hygiene fixes, its own request). Data comes from `/api/agents/:id/home`; live updates
 * ride the shared `watchAgent()` link.
 */
import { card, emptyState, openSheet, showToast, skeleton } from '../ui/index.js';
import { registerPageShortcuts } from '../ui/shortcuts.js';
import { authedAvatarSrc, wireFaceControl, wireSpeakButton } from './agent-face.js';
import {
  AGENT_HOME_SHORTCUTS,
  applyPresence,
  findBoardGoal,
  goalFormPayload,
  goalMovePayload,
  goalsColumns,
  homeKeyAction,
  homeTabs,
  isTaskConflict,
  karmaBody,
  needsYouStrip,
  presenceHeader,
  taskAddRequest,
  taskMoveRequest,
  timelineBody,
  traitsBody,
} from './agent-home-helpers.js';
import { FOCUS_CHAT_KEY } from './agent-wizard-helpers.js';
import { mountMind } from './curiosity.js';
import {
  goalDetailBody,
  goalDetailError,
  goalDetailLoading,
  goalDetailUrl,
  goalEditPayload,
  goalEditor,
} from './goal-detail-helpers.js';
import { watchAgent } from './live-presence.js';
import { memoryHistoryBody, memoryHistoryUrl } from './memory-history-helpers.js';
import { api, renderThread } from './shared.js';

const HOME_REFRESH_DEBOUNCE_MS = 3000;
const CHAT_POLL_MS = 2000;
const CHAT_MAX_POLLS = 90;

let watch = null;
let chat = null;
let refreshTimer = null;
let speaker = null;
let keyHandler = null;

export function destroyAgentHome() {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = null;
  watch?.stop();
  watch = null;
  chat?.destroy();
  chat = null;
  speaker?.stop();
  speaker = null;
  clearTimeout(refreshTimer);
  refreshTimer = null;
}

function homeUrl(id) {
  return `/api/agents/${encodeURIComponent(id)}/home`;
}

function actionsFor(identity, id) {
  const enc = encodeURIComponent(id);
  const rest = `<a class="btn" href="#/agents/${enc}/edit" id="home-edit" title="Edit this agent (e)">Edit</a><a class="btn" href="#/agents/${enc}/config">Config</a>`;
  if (identity.running) {
    return `<button class="btn btn-primary" id="home-run" title="Run one agent-loop cycle now (r)">Run now</button>
      <button class="btn btn-danger" id="home-toggle">Stop</button>${rest}`;
  }
  const label = identity.enabled ? 'Start' : 'Enable &amp; Start';
  return `<button class="btn btn-primary" id="home-toggle">${label}</button>${rest}`;
}

/** True while the operator is typing in a board form (a redraw would wipe it). */
function boardBusy(board) {
  const inputs = board?.querySelectorAll('#home-goal-form [name="title"], [data-task-form] input');
  return [...(inputs ?? [])].some((i) => i.value.trim() || document.activeElement === i);
}

/**
 * Draw the board from a home payload, keeping the open goal (`data-selected`)
 * and the add-task form (`data-adding`) across redraws.
 */
function paintBoard(board, goals, id) {
  board._goals = goals;
  if (board.dataset.selected && !findBoardGoal(goals, board.dataset.selected)) {
    delete board.dataset.selected;
    delete board.dataset.adding;
  }
  board.innerHTML = goalsColumns(goals, {
    selectedId: board.dataset.selected,
    botId: id,
    addingTask: board.dataset.adding === '1',
  });
  if (board.dataset.adding === '1') board.querySelector('[data-task-form] input')?.focus();
}

async function redrawBoard(el, id) {
  const home = await api(homeUrl(id)).catch(() => null);
  const board = el.querySelector('#home-goals');
  if (home && !home.error && board) paintBoard(board, home.goals, id);
}

/** Right-hand drawer with everything about one goal; title and notes edit in place. */
async function openGoalDetail(botId, goalId, title, onChange) {
  const body = openSheet({ title: 'Goal', body: goalDetailLoading(), wide: true });
  if (!body) return;
  const load = async (key) => {
    const detail = await api(goalDetailUrl(botId, key)).catch((err) => ({
      error: err?.message || 'Request failed',
    }));
    if (!body.isConnected) return;
    body.innerHTML =
      !detail || detail.error
        ? goalDetailError(detail?.error || 'no response')
        : goalDetailBody(detail, botId);
  };
  await load({ id: goalId, title });
  wireGoalEditing(body, botId, load, onChange);
}

function wireGoalEditing(body, botId, load, onChange) {
  const startEdit = (target) => {
    if (body.querySelector('.gd-editor')) return;
    const field = target.dataset.edit;
    const root = body.querySelector('.gd');
    if (!root || !field) return;
    const value =
      field === 'title'
        ? root.dataset.goal
        : target.classList.contains('gd-notes-empty')
          ? ''
          : target.textContent.trim();
    const holder = document.createElement('div');
    holder.innerHTML = goalEditor(field, value);
    const editor = holder.firstElementChild;
    target.replaceWith(editor);
    const input = editor.querySelector('textarea');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    const goal = { id: root.dataset.goalId, title: root.dataset.goal };
    const reload = () => load({ id: goal.id, title: goal.title });
    const save = async () => {
      const payload = goalEditPayload(goal, field, input.value);
      if (!payload) {
        showToast('A goal needs a title', { tone: 'danger' });
        return;
      }
      editor.querySelectorAll('button').forEach((btn) => {
        btn.disabled = true;
      });
      const res = await api(`/api/agents/${encodeURIComponent(botId)}/goals`, {
        method: 'PATCH',
        body: payload,
      }).catch((err) => ({ error: err?.message || 'Request failed' }));
      if (res?.error) {
        showToast(res.error, { tone: 'danger' });
        editor.querySelectorAll('button').forEach((btn) => {
          btn.disabled = false;
        });
        return;
      }
      if (field === 'title') goal.title = payload.title;
      await reload();
      onChange?.();
    };
    editor.addEventListener('click', (e) => {
      if (e.target.closest('[data-edit-save]')) save();
      else if (e.target.closest('[data-edit-cancel]')) reload();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        reload();
      } else if (e.key === 'Enter' && (field === 'title' ? !e.shiftKey : e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      }
    });
  };
  body.addEventListener('click', (e) => {
    const target = e.target.closest('[data-edit]');
    if (target && !e.target.closest('a')) startEdit(target);
  });
  body.addEventListener('keydown', (e) => {
    const target = e.target.closest?.('[data-edit]');
    if (target && e.key === 'Enter' && e.target === target) {
      e.preventDefault();
      startEdit(target);
    }
  });
}

/** Goals board: select, add, move goals and tasks by delegation, so redraws keep working. */
function wireGoalBoard(el, id, goals) {
  const board = el.querySelector('#home-goals');
  if (!board) return;
  board._goals = goals;
  const url = `/api/agents/${encodeURIComponent(id)}/goals`;
  board.addEventListener('submit', async (e) => {
    const form = e.target.closest('#home-goal-form');
    if (!form) return;
    e.preventDefault();
    const payload = goalFormPayload(form.elements.title?.value, form.elements.priority?.value);
    if (!payload) return;
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      const res = await api(url, { method: 'POST', body: payload });
      if (res?.error) {
        showToast(res.error, { tone: 'danger' });
        return;
      }
      form.reset();
      showToast('Goal added — the agent picks it up next cycle', { tone: 'ok' });
      await redrawBoard(el, id);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  const repaint = () => paintBoard(board, board._goals, id);
  const send = async (payload, okMessage) => {
    if (!payload) return;
    const res = await api(url, { method: 'PATCH', body: payload }).catch((err) => ({
      error: err?.message || 'Request failed',
    }));
    if (res?.error) showToast(res.error, { tone: 'danger' });
    else if (okMessage) showToast(okMessage, { tone: 'ok' });
    await redrawBoard(el, id);
  };
  const move = (goal, status) => send(goalMovePayload(goal, status));
  // Task ops go one at a time to the task store, with the board's rev: a stale
  // board (or a task a worker holds) gets a 409, and we refetch and repaint.
  const sendTask = async (req, okMessage) => {
    if (!req) return;
    const res = await api(req.path, { method: req.method, body: req.body }).catch((err) => ({
      error: err?.message || 'Request failed',
    }));
    if (isTaskConflict(res))
      showToast(`The board changed meanwhile, so it was reloaded. ${res.error}`, { tone: 'warn' });
    else if (res?.error) showToast(res.error, { tone: 'danger' });
    else if (okMessage) showToast(okMessage, { tone: 'ok' });
    await redrawBoard(el, id);
  };
  const openGoal = () => findBoardGoal(board._goals, board.dataset.selected)?.goal;

  // Click a goal: its tasks open under its row; click it again (or ✕) to close.
  const toggle = (goalCard) => {
    const key = goalCard.dataset.goalId || goalCard.dataset.goal;
    if (board.dataset.selected === key) delete board.dataset.selected;
    else board.dataset.selected = key;
    delete board.dataset.adding;
    repaint();
    board.querySelector('.home-goal-card.is-selected')?.focus();
  };
  board.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-open-cycle]')) return; // app.js opens the cycle sheet
    if (t.closest('[data-goal-close]')) {
      delete board.dataset.selected;
      delete board.dataset.adding;
      return repaint();
    }
    if (t.closest('[data-goal-history]')) {
      const panel = t.closest('.home-goal-panel');
      return openGoalDetail(id, panel.dataset.panelGoalId, panel.dataset.panelGoal, () =>
        redrawBoard(el, id)
      );
    }
    if (t.closest('[data-add-task]')) {
      board.dataset.adding = '1';
      return repaint();
    }
    if (t.closest('[data-complete-goal]')) {
      const goal = openGoal();
      if (goal) await move(goal.text, 'done');
      return;
    }
    const goalCard = t.closest('.home-goal-card');
    if (goalCard) toggle(goalCard);
  });
  board.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && board.dataset.adding) {
      delete board.dataset.adding;
      return repaint();
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('home-goal-card')) {
      e.preventDefault();
      toggle(e.target);
    }
  });
  board.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-task-form]');
    if (!form) return;
    e.preventDefault();
    const req = taskAddRequest(id, openGoal(), form.elements.text?.value);
    if (!req) return;
    form.querySelector('button[type="submit"]')?.setAttribute('disabled', '');
    delete board.dataset.adding;
    await sendTask(req, 'Task added — the agent sees it next cycle');
  });
  board.addEventListener('change', async (e) => {
    const select = e.target.closest('.home-goal-status');
    if (!select) return;
    select.disabled = true;
    await move(select.dataset.goal, select.value);
  });

  // Drag a goal onto another column, or a task onto another lane of its goal.
  let dragged = null;
  const clearOver = () => {
    for (const c of board.querySelectorAll('.drag-over')) c.classList.remove('drag-over');
  };
  const zoneOf = (target) => {
    if (dragged?.kind === 'task') return target.closest?.('.home-task-lane') ?? null;
    if (dragged?.kind === 'goal') return target.closest?.('.home-board-cell') ?? null;
    return null;
  };
  board.addEventListener('dragstart', (e) => {
    const taskCard = e.target.closest?.('.home-task-card');
    const goalCard = taskCard ? null : e.target.closest?.('.home-goal-card');
    if (taskCard) {
      dragged = {
        kind: 'task',
        task: taskCard.dataset.taskId,
        from: taskCard.closest('.home-task-lane')?.dataset.taskStatus,
      };
    } else if (goalCard) {
      dragged = {
        kind: 'goal',
        goal: goalCard.dataset.goal,
        from: goalCard.closest('.home-board-cell')?.dataset.status,
      };
    } else return;
    (taskCard ?? goalCard).classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged.task ?? dragged.goal ?? '');
  });
  board.addEventListener('dragend', (e) => {
    e.target.closest?.('.dragging')?.classList.remove('dragging');
    clearOver();
    dragged = null;
  });
  board.addEventListener('dragover', (e) => {
    const zone = zoneOf(e.target);
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (zone.classList.contains('drag-over')) return;
    clearOver();
    if (dragged.kind === 'task') zone.classList.add('drag-over');
    else
      for (const c of board.querySelectorAll(
        `.home-board-cell[data-status="${zone.dataset.status}"]`
      ))
        c.classList.add('drag-over');
  });
  board.addEventListener('dragleave', (e) => {
    if (!board.contains(e.relatedTarget)) clearOver();
  });
  board.addEventListener('drop', async (e) => {
    const zone = zoneOf(e.target);
    if (!zone) return;
    e.preventDefault();
    clearOver();
    const drop = dragged;
    dragged = null;
    if (drop.kind === 'task') {
      const lane = zone.dataset.taskStatus;
      if (lane && lane !== drop.from)
        await sendTask(taskMoveRequest(id, openGoal(), drop.task, lane, board._goals?.tasksRev));
    } else if (zone.dataset.status && zone.dataset.status !== drop.from) {
      await move(drop.goal, zone.dataset.status);
    }
  });
}

function wireActions(el, id, identity) {
  el.querySelector('#home-toggle')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const startPath = identity.enabled
      ? `/api/agents/${encodeURIComponent(id)}/start`
      : `/api/agents/${encodeURIComponent(id)}/start?enable=true`;
    const res = identity.running
      ? await api(`/api/agents/${encodeURIComponent(id)}/stop`, { method: 'POST' })
      : await api(startPath, { method: 'POST' });
    const verb = identity.running ? 'stop' : 'start';
    if (!res || res.error) {
      showToast(`Could not ${verb} ${identity.name}: ${res?.error || 'request failed'}`, {
        tone: 'danger',
        duration: 8000,
      });
    } else {
      showToast(`${identity.name} ${verb === 'stop' ? 'stopped' : 'started'}`, { tone: 'ok' });
    }
    renderAgentHome(el, id);
  });
  el.querySelector('#home-run')?.addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Running…';
    try {
      const res = await api(`/api/agent-loop/run/${encodeURIComponent(id)}`, { method: 'POST' });
      if (!res || res.error) {
        showToast(`Run failed: ${res?.error || 'request failed'}`, {
          tone: 'danger',
          duration: 8000,
        });
      } else {
        showToast(`${identity.name} finished a cycle`, { tone: 'ok' });
      }
    } finally {
      btn.textContent = 'Run now';
      btn.disabled = false;
      watch?.refresh();
    }
  });
}

/** Chat panel backed by the newest `general` dashboard conversation. */
function mountChat(container, botId, name) {
  let convId = null;
  let messages = [];
  let generating = false;
  let error = null;
  let poll = null;
  let destroyed = false;
  const base = `/api/conversations/${encodeURIComponent(botId)}`;

  const render = () => {
    if (destroyed || !container?.isConnected) return;
    renderThread(container, {
      thread: messages,
      generating,
      error,
      botId,
      onSend: send,
      onRetry: retry,
      onApprove: approve,
    });
  };

  const stopPolling = () => {
    clearInterval(poll);
    poll = null;
  };

  const startPolling = () => {
    stopPolling();
    let n = 0;
    poll = setInterval(async () => {
      if (destroyed || !convId) return stopPolling();
      n++;
      if (n >= CHAT_MAX_POLLS) {
        stopPolling();
        generating = false;
        error = 'Response timed out (3 minutes). The agent may still be thinking.';
        render();
        return;
      }
      const st = await api(`${base}/${convId}/status`).catch(() => ({}));
      if (st.status === 'error') {
        stopPolling();
        generating = false;
        error = st.error || 'Generation failed';
        render();
      } else if (st.status === 'idle') {
        stopPolling();
        if (st.lastBotMessage && !messages.find((m) => m.id === st.lastBotMessage.id)) {
          messages.push(st.lastBotMessage);
        }
        generating = false;
        error = null;
        render();
      }
    }, CHAT_POLL_MS);
  };

  const ensureConversation = async () => {
    if (convId) return convId;
    const c = await api(base, {
      method: 'POST',
      body: { type: 'general', title: `Chat with ${name}` },
    });
    if (!c || c.error || !c.id) throw new Error(c?.error || 'Could not open a conversation');
    convId = c.id;
    return convId;
  };

  const send = async (text, images, documents) => {
    messages.push({
      id: `temp-${Date.now()}`,
      role: 'human',
      content: text,
      images: images || undefined,
      documents: documents
        ? documents.map((d) => ({ name: d.name, mimeType: d.mimeType, size: d.content.length }))
        : undefined,
      createdAt: new Date().toISOString(),
    });
    generating = true;
    error = null;
    render();
    try {
      await ensureConversation();
    } catch (err) {
      generating = false;
      error = err.message;
      render();
      return;
    }
    const body = { message: text };
    if (images?.length) body.images = images;
    if (documents?.length) body.documents = documents;
    const res = await api(`${base}/${convId}/messages`, { method: 'POST', body });
    if (res?.error) {
      generating = false;
      error = res.error;
      render();
      return;
    }
    if (res?.message) {
      const i = messages.findIndex((m) => String(m.id).startsWith('temp-'));
      if (i !== -1) messages[i] = res.message;
    }
    startPolling();
  };

  const retry = async () => {
    if (!convId) return;
    error = null;
    generating = true;
    render();
    await api(`${base}/${convId}/retry`, { method: 'POST' });
    startPolling();
  };

  const approve = async (action, messageId) => {
    if (!convId) return;
    const res = await api(`${base}/${convId}/approve`, {
      method: 'POST',
      body: { action, messageId },
    });
    if (res?.error) error = res.error;
    if (res?.status === 'approved') generating = true;
    const fresh = await api(`${base}/${convId}`).catch(() => null);
    if (fresh?.messages) messages = fresh.messages;
    render();
    if (generating) startPolling();
  };

  const load = async () => {
    let pending = false;
    try {
      const list = await api(`${base}?type=general&limit=1`);
      const convo = Array.isArray(list) ? list[0] : null;
      if (convo?.id) {
        convId = convo.id;
        const data = await api(`${base}/${convo.id}`);
        messages = Array.isArray(data?.messages) ? data.messages.slice(-30) : [];
        // A reply may still be in flight (the creation wizard sends the first
        // greeting right before landing here): show the typing state and poll.
        const st = await api(`${base}/${convo.id}/status`).catch(() => null);
        pending = st?.status === 'generating';
      }
    } catch {
      /* start empty */
    }
    generating = pending;
    render();
    if (pending) startPolling();
    focusIfRequested();
  };

  /** The wizard asks for the chat box to be focused once after creation. */
  const focusIfRequested = () => {
    try {
      if (sessionStorage.getItem(FOCUS_CHAT_KEY) !== botId) return;
      sessionStorage.removeItem(FOCUS_CHAT_KEY);
    } catch {
      return;
    }
    const input = container?.querySelector('.thread-input');
    if (input) {
      input.focus();
      input.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }
  };

  load();
  return {
    destroy() {
      destroyed = true;
      stopPolling();
    },
  };
}

/** `r` Run now, `e` Edit, `c` focus the chat box (never while typing). */
function wireKeys(el, id, identity) {
  keyHandler = (e) => {
    if (!el.isConnected) return;
    if (document.getElementById('ui-dialog-root')) return;
    const action = homeKeyAction(e);
    if (!action) return;
    if (action === 'run') {
      const btn = el.querySelector('#home-run');
      if (!btn) {
        if (!identity.running) showToast(`${identity.name} is not running`, { tone: 'muted' });
        return;
      }
      e.preventDefault();
      if (!btn.disabled) btn.click();
    } else if (action === 'edit') {
      e.preventDefault();
      location.hash = `#/agents/${encodeURIComponent(id)}/edit`;
    } else if (action === 'chat') {
      const input = el.querySelector('#home-chat .thread-input');
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }
  };
  document.addEventListener('keydown', keyHandler);
}

/** Its own request, like the Mind section: a slow read never holds the home back. */
async function mountMemoryHistory(box, id) {
  if (!box) return;
  const res = await api(memoryHistoryUrl(id)).catch((err) => ({
    error: err?.message || 'Request failed',
  }));
  if (!box.isConnected) return;
  box.innerHTML = memoryHistoryBody(res, { botId: id });
}

function scheduleHomeRefresh(el, id) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const home = await api(homeUrl(id)).catch(() => null);
    if (!home || home.error || !el.isConnected) return;
    const tl = el.querySelector('#home-timeline');
    if (tl) tl.innerHTML = timelineBody(home.timeline);
    const needs = el.querySelector('#home-needs');
    if (needs) needs.innerHTML = needsYouStrip(home.needsYou, id);
    const goals = el.querySelector('#home-goals');
    if (goals && !boardBusy(goals)) paintBoard(goals, home.goals, id);
  }, HOME_REFRESH_DEBOUNCE_MS);
}

export async function renderAgentHome(el, id) {
  registerPageShortcuts(AGENT_HOME_SHORTCUTS);
  destroyAgentHome();
  el.innerHTML = `<div style="max-width:720px">${skeleton({ lines: 2 })}<div style="height:16px"></div>${skeleton({ block: true, height: 220 })}</div>`;

  const home = await api(homeUrl(id)).catch((err) => ({ error: err?.message || 'Request failed' }));
  if (!home || home.error) {
    el.innerHTML = `<div class="page-title">Agent</div>${emptyState({
      icon: '∅',
      title: 'Agent not found',
      hint: home?.error || 'The server did not return this agent.',
      action: '<a class="btn" href="#/agents">Back to agents</a>',
    })}`;
    return;
  }
  const identity = home.identity;

  el.innerHTML = `<div class="page-wide"></div>
    ${presenceHeader(home, {
      actions: actionsFor(identity, id),
      avatarSrc: authedAvatarSrc,
      face: true,
      voice: Boolean(identity.voiceEnabled),
    })}
    ${homeTabs(id, 'home')}
    <div id="home-needs">${needsYouStrip(home.needsYou, id)}</div>
    <div class="home-grid home-grid-stretch">
      ${card({
        title: `Talk to ${identity.name}`,
        subtitle: 'A direct conversation; the full thread lives under Conversations',
        body: '<div class="home-chat"><div id="home-chat"></div></div>',
      })}
      ${card({
        title: 'Timeline',
        subtitle: 'What happened, newest first',
        body: `<div class="home-timeline" id="home-timeline">${timelineBody(home.timeline)}</div>`,
      })}
    </div>
    <div id="home-mind" class="home-mind"></div>
    <div class="home-goals-row">
      ${card({
        title: 'Goals',
        subtitle:
          'Click a goal to see its tasks and drag them between lanes; drag goals between columns. The agent works on yours first.',
        body: `<div id="home-goals">${goalsColumns(home.goals, { botId: id })}</div>`,
      })}
    </div>
    <div class="home-grid" style="margin-top:16px">
      ${card({ title: 'Traits', body: traitsBody(home.traits, home.traitChanges, { nowMs: Date.now(), botId: home.identity?.id }) })}
      ${card({
        title: 'Karma',
        body: karmaBody(home.karma),
        actions: `<a class="btn btn-sm" href="#/insights/karma/${encodeURIComponent(id)}">Details</a>`,
      })}
    </div>
    <div class="home-memory-row">
      ${card({
        title: 'Memory history',
        subtitle:
          'Edits to its memory you did not make: consolidations, facts saved, hygiene fixes',
        body: `<div id="home-memory">${skeleton({ lines: 3 })}</div>`,
      })}
    </div>`;

  wireActions(el, id, identity);
  wireGoalBoard(el, id, home.goals);
  wireKeys(el, id, identity);
  wireFaceControl(el, id, {
    onChanged: (avatarUrl) => {
      identity.avatarUrl = avatarUrl;
      if (!avatarUrl) renderAgentHome(el, id);
    },
  });
  speaker = wireSpeakButton(el, id, () => el.querySelector('#presence-now')?.textContent);
  chat = mountChat(el.querySelector('#home-chat'), id, identity.name);
  // Curiosity DNA (knowledge map, frontier, direction, dispatches): its own
  // request so a slow or missing curiosity state never holds the home back.
  mountMind(el.querySelector('#home-mind'), id);
  mountMemoryHistory(el.querySelector('#home-memory'), id);
  watch = watchAgent(id, {
    onPresence: (p) => applyPresence(el, p, identity),
    onEvent: () => scheduleHomeRefresh(el, id),
  });
}
