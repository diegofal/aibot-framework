/**
 * Agent Home — the agent as a person on one screen (session S2 of
 * docs/plans/jarvis-fleet-plan.md).
 *
 * Presence header (live), needs-you strip, a chat panel that talks to the
 * agent through the dashboard conversations API, the timeline, then goals,
 * traits and karma. Data comes from `/api/agents/:id/home`; live updates
 * ride the shared `watchAgent()` link.
 */
import { card, emptyState, openSheet, showToast, skeleton } from '../ui/index.js';
import { registerPageShortcuts } from '../ui/shortcuts.js';
import { authedAvatarSrc, wireFaceControl, wireSpeakButton } from './agent-face.js';
import {
  AGENT_HOME_SHORTCUTS,
  applyPresence,
  goalFormPayload,
  goalMovePayload,
  goalsColumns,
  homeKeyAction,
  homeTabs,
  karmaBody,
  needsYouStrip,
  presenceHeader,
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

/** True while the operator is typing in the board's add form (a redraw would wipe it). */
function boardBusy(board) {
  const input = board?.querySelector('#home-goal-form [name="title"]');
  return Boolean(input && (input.value.trim() || document.activeElement === input));
}

async function redrawBoard(el, id) {
  const home = await api(homeUrl(id)).catch(() => null);
  const board = el.querySelector('#home-goals');
  if (home && !home.error && board) board.innerHTML = goalsColumns(home.goals);
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

/** Goals board: add (submit) and move (change) by delegation, so redraws keep working. */
function wireGoalBoard(el, id) {
  const board = el.querySelector('#home-goals');
  if (!board) return;
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
  const openFrom = (target) => {
    if (target.closest('.home-goal-move')) return;
    const goalCard = target.closest('.home-goal-card');
    if (goalCard)
      openGoalDetail(id, goalCard.dataset.goalId, goalCard.dataset.goal, () => redrawBoard(el, id));
  };
  board.addEventListener('click', (e) => openFrom(e.target));
  board.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('home-goal-card')) {
      e.preventDefault();
      openFrom(e.target);
    }
  });
  const move = async (goal, status) => {
    const payload = goalMovePayload(goal, status);
    if (!payload) return;
    const res = await api(url, { method: 'PATCH', body: payload }).catch((err) => ({
      error: err?.message || 'Request failed',
    }));
    if (res?.error) showToast(res.error, { tone: 'danger' });
    await redrawBoard(el, id);
  };
  board.addEventListener('change', async (e) => {
    const select = e.target.closest('.home-goal-move');
    if (!select) return;
    select.disabled = true;
    await move(select.dataset.goal, select.value);
  });

  // Drag a card onto another column to move it there.
  let dragged = null;
  const clearOver = () =>
    board
      .querySelectorAll('.home-board-col.drag-over')
      .forEach((c) => c.classList.remove('drag-over'));
  board.addEventListener('dragstart', (e) => {
    const goalCard = e.target.closest?.('.home-goal-card');
    if (!goalCard) return;
    dragged = {
      goal: goalCard.dataset.goal,
      from: goalCard.closest('.home-board-col')?.dataset.status,
    };
    goalCard.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', goalCard.dataset.goal || '');
  });
  board.addEventListener('dragend', (e) => {
    e.target.closest?.('.home-goal-card')?.classList.remove('dragging');
    clearOver();
    dragged = null;
  });
  board.addEventListener('dragover', (e) => {
    const col = e.target.closest('.home-board-col');
    if (!col || !dragged) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!col.classList.contains('drag-over')) {
      clearOver();
      col.classList.add('drag-over');
    }
  });
  board.addEventListener('dragleave', (e) => {
    const col = e.target.closest('.home-board-col');
    if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
  });
  board.addEventListener('drop', async (e) => {
    const col = e.target.closest('.home-board-col');
    if (!col || !dragged) return;
    e.preventDefault();
    clearOver();
    const { goal, from } = dragged;
    dragged = null;
    if (col.dataset.status && col.dataset.status !== from) await move(goal, col.dataset.status);
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
    if (goals && !boardBusy(goals)) goals.innerHTML = goalsColumns(home.goals);
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
          'Add goals in To do; click a card for its history, move it with its menu. The agent works on yours first.',
        body: `<div id="home-goals">${goalsColumns(home.goals)}</div>`,
      })}
    </div>
    <div class="home-grid" style="margin-top:16px">
      ${card({ title: 'Traits', body: traitsBody(home.traits) })}
      ${card({
        title: 'Karma',
        body: karmaBody(home.karma),
        actions: `<a class="btn btn-sm" href="#/insights/karma/${encodeURIComponent(id)}">Details</a>`,
      })}
    </div>`;

  wireActions(el, id, identity);
  wireGoalBoard(el, id);
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
  watch = watchAgent(id, {
    onPresence: (p) => applyPresence(el, p, identity),
    onEvent: () => scheduleHomeRefresh(el, id),
  });
}
