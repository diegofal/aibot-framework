/**
 * The goal board, wired — one controller for the Fleet Board (`#/board`, a
 * board per expanded agent) and Agent Home (its one board). Markup is
 * `boardHtml` / `cardHtml` / `drawerHtml` in fleet-board-helpers.js (pure, tested).
 *
 * The page owns the data and the repaint: `getHome(botId)` returns the agent's
 * `/api/agents/:id/home` payload, `reload(botId)` refetches it, `paint(botId)`
 * redraws that agent's board (with `selectedRef(botId)` marked). This module
 * owns everything a board does: goal drag between columns, "+ New goal",
 * card click → goal drawer, the drawer's controls (status, priority, subtasks,
 * brief, notes, standing / project, History, delete) and the inline tasks on
 * a card (tick to finish, "+ task", "+N more"). A board is any `[data-bot]`
 * element under `root`.
 *
 * Writes: POST / PATCH / DELETE `/api/agents/:id/goals`; tasks one op at a time
 * (`/api/agents/:id/goals/:goalId/tasks[/reorder]`, `/api/agents/:id/tasks/:taskId`)
 * with the board's `tasksRev` (a 409 reloads). The drawer's Activity section
 * loads `/api/agents/:id/goals/detail`; History opens the goal detail sheet.
 */
import { confirmInline, openSheet, showToast } from '../ui/index.js';
import { captureEdits, restoreEdits } from './drawer-edits.js';
import {
  addTask,
  drawerHtml,
  goalKindPayload,
  goalRef,
  goalYardstickMs,
  moveTask,
  removeTask,
  renameTask,
  taskAddRequest,
  taskRemoveRequest,
  taskRenameRequest,
  taskReorderRequest,
  taskToggleRequest,
  toggleTask,
} from './fleet-board-helpers.js';
import {
  goalDetailBody,
  goalDetailError,
  goalDetailLoading,
  goalDetailUrl,
  goalEditPayload,
  goalEditor,
} from './goal-detail-helpers.js';
import { api, escapeHtml } from './shared.js';

const DETAIL_CACHE_MS = 30_000;
const ACTIVITY_DAYS = 30;
const TASK_ADDED = 'Task added — the agent sees it next cycle';

/** Right-hand sheet with a goal's whole history; title and notes edit in place. */
export async function openGoalDetail(botId, goalId, title, onChange) {
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

const FIELD = 'input, textarea, [contenteditable]';

/**
 * Wire the boards under `root`. Returns the controller the page keeps:
 * `selectedRef(botId)`, `isOpen()`, `paintDrawer()`, `busy()`, `close()`, `destroy()`.
 */
export function mountGoalBoard({ root, getHome, getAgent, reload, paint }) {
  const st = { drawer: null, details: {}, showAllCycles: false };
  const scrim = document.createElement('div');
  scrim.className = 'fb-scrim';
  const drawer = document.createElement('aside');
  drawer.className = 'fb-drawer';
  drawer.setAttribute('aria-label', 'Goal');
  // Outside the page container so it can overlay everything.
  document.body.append(scrim, drawer);

  const botOf = (el) => el?.closest?.('[data-bot]')?.dataset.bot ?? null;
  const tasksRev = (botId) => getHome(botId)?.goals?.tasksRev;

  function findGoal(botId, ref) {
    const g = getHome(botId)?.goals;
    if (!g || !ref) return null;
    const all = [
      ...(g.inProgress ?? []),
      ...(g.todo ?? []),
      ...(g.blocked ?? []),
      ...(g.completedRecently ?? []),
      ...Object.values(g.spawned ?? {}).flat(),
    ];
    return all.find((x) => x.id === ref) ?? all.find((x) => x.text === ref) ?? null;
  }
  const currentGoal = () => (st.drawer ? findGoal(st.drawer.botId, st.drawer.ref) : null);
  const detailKey = (botId, goal) => `${botId}:${goal?.id || goal?.text || ''}`;

  function paintDrawer() {
    const goal = currentGoal();
    drawer.classList.toggle('on', Boolean(goal));
    scrim.classList.toggle('on', Boolean(goal));
    if (!goal) return;
    const botId = st.drawer.botId;
    const home = getHome(botId);
    // A save or the Activity load repaints mid-edit: keep what is being typed on this goal.
    const key = detailKey(botId, goal);
    const edits = drawer.dataset.goalKey === key ? captureEdits(drawer, document) : null;
    drawer.innerHTML = drawerHtml(getAgent(botId) ?? { id: botId }, goal, {
      botId,
      detail: st.details[key]?.body,
      spawned: (goal.id && home?.goals?.spawned?.[goal.id]) || [],
      showAll: st.showAllCycles,
      intervalMs: goalYardstickMs(home),
    });
    drawer.dataset.goalKey = key;
    restoreEdits(drawer, edits, { reopenNotes: () => openNotesEditor(goal) });
  }

  function openNotesEditor(goal) {
    const box = drawer.querySelector('#fb-notes');
    if (!box) return;
    box.innerHTML = `<textarea class="fb-edit" id="fb-notesed" maxlength="600">${escapeHtml(goal.notes ?? '')}</textarea><div class="fb-edit-row"><button type="button" class="btn btn-sm btn-primary" id="fb-savenotes">Save notes</button><button type="button" class="btn btn-sm" data-cancel>Cancel</button></div>`;
  }

  /** The goal's cycles for the drawer's Activity section; repaints when it lands. */
  async function loadDetail(botId, goal) {
    const key = detailKey(botId, goal);
    const have = st.details[key];
    if (have && Date.now() - have.at < DETAIL_CACHE_MS) return;
    const q = goal.id
      ? `id=${encodeURIComponent(goal.id)}`
      : `title=${encodeURIComponent(goal.text)}`;
    const res = await api(
      `/api/agents/${encodeURIComponent(botId)}/goals/detail?${q}&days=${ACTIVITY_DAYS}`
    ).catch((err) => ({ error: err?.message || 'Request failed' }));
    if (!drawer.isConnected) return;
    st.details[key] = { at: Date.now(), body: res && !res.error ? res : { error: res?.error } };
    const open = currentGoal();
    if (open && detailKey(st.drawer.botId, open) === key) paintDrawer();
  }

  function openDrawer(botId, ref) {
    st.drawer = { botId, ref };
    st.showAllCycles = false;
    paint(botId);
    paintDrawer();
    const goal = currentGoal();
    if (goal) loadDetail(botId, goal);
  }

  function closeDrawer() {
    const botId = st.drawer?.botId;
    st.drawer = null;
    if (botId) paint(botId);
    paintDrawer();
  }

  /** A goal without an id gets one on its first write: follow it by id from now on. */
  function followDrawer(botId, ...fallbacks) {
    if (st.drawer?.botId !== botId) return;
    let g = findGoal(botId, st.drawer.ref);
    for (const ref of fallbacks) g ??= ref ? findGoal(botId, ref) : null;
    if (g) st.drawer.ref = g.id || g.text;
  }

  async function goalWrite(botId, method, body, okText) {
    if (!body) return false;
    const res = await api(`/api/agents/${encodeURIComponent(botId)}/goals`, {
      method,
      body,
    }).catch((err) => ({ error: err?.message }));
    const ok = res && !res.error;
    if (!ok)
      showToast(`Could not save: ${res?.error || 'request failed'}`, {
        tone: 'danger',
        duration: 8000,
      });
    else if (okText) showToast(okText, { tone: 'ok' });
    await reload(botId);
    if (!drawer.isConnected) return ok;
    if (st.drawer?.botId === botId) {
      if (method === 'DELETE') st.drawer = null;
      else followDrawer(botId, body.brief);
    }
    paint(botId);
    paintDrawer();
    return ok;
  }

  /**
   * One task op: paint `tasks` right away, send `req`, then reload the agent.
   * A 409 (the board was stale, or a worker run holds the task) reloads too.
   */
  async function saveTasks(botId, goal, tasks, req, okText) {
    if (!req || !goal) return false;
    goal.tasks = tasks;
    paint(botId);
    paintDrawer();
    const res = await api(req.path, { method: req.method, body: req.body }).catch((err) => ({
      error: err?.message,
    }));
    const ok = res && !res.error;
    if (!ok) {
      const stale = res?.reason === 'conflict' || res?.reason === 'claimed';
      showToast(
        stale
          ? `The board changed meanwhile, so it was reloaded. ${res.error}`
          : `Could not save: ${res?.error || 'request failed'}`,
        { tone: stale ? 'warn' : 'danger', duration: 8000 }
      );
    } else if (okText) showToast(okText, { tone: 'ok' });
    await reload(botId);
    if (!drawer.isConnected) return ok;
    followDrawer(botId, goal.text);
    paint(botId);
    paintDrawer();
    return ok;
  }

  // ── Inline "+ task" on a card ──

  function cardOf(botId, ref) {
    const board = [...root.querySelectorAll('[data-bot]')].find((b) => b.dataset.bot === botId);
    return board?.querySelector(`.fb-card[data-goal="${CSS.escape(ref)}"]`) ?? null;
  }

  function openInlineAdd(card) {
    const btn = card?.querySelector('[data-iadd]');
    if (!btn) return;
    const input = document.createElement('input');
    input.className = 'fb-itask-in';
    input.dataset.iinput = '';
    input.maxLength = 200;
    input.placeholder = 'New task, then Enter';
    input.setAttribute('aria-label', 'New task');
    btn.replaceWith(input);
    input.focus();
  }

  async function addInlineTask(input) {
    const card = input.closest('.fb-card[data-goal]');
    const botId = botOf(card);
    const goal = botId ? findGoal(botId, card.dataset.goal) : null;
    const text = input.value;
    input.value = '';
    if (!goal) return;
    const ref = goal.id || goal.text;
    await saveTasks(
      botId,
      goal,
      addTask(goal.tasks ?? [], text),
      taskAddRequest(botId, goal, text),
      TASK_ADDED
    );
    // Keep typing: the next task goes on the same card.
    openInlineAdd(cardOf(botId, findGoal(botId, ref)?.id || ref));
  }

  // ── Events ──

  async function onBoardClick(t) {
    const card = t.closest('.fb-card[data-goal]');
    const botId = botOf(card);
    if (!card || !botId) return;
    if (t.closest('[data-iinput]')) return;
    if (t.closest('[data-iadd]')) {
      openInlineAdd(card);
      return;
    }
    const toggle = t.closest('[data-itoggle]');
    if (toggle) {
      const goal = findGoal(botId, card.dataset.goal);
      const i = Number(toggle.closest('.fb-itask')?.dataset.ti);
      const tasks = goal?.tasks ?? [];
      toggle.disabled = true;
      await saveTasks(
        botId,
        goal,
        toggleTask(tasks, i),
        taskToggleRequest(botId, tasks, i, tasksRev(botId))
      );
      return;
    }
    // The card, a task's text, or "+N more": the goal drawer.
    openDrawer(botId, card.dataset.goal);
  }

  async function onDrawerClick(t) {
    if (t.closest('[data-close]')) {
      closeDrawer();
      return;
    }
    const goal = currentGoal();
    if (!goal) return;
    const botId = st.drawer.botId;
    const s = t.closest('[data-st]');
    if (s) {
      await goalWrite(botId, 'PATCH', { ...goalRef(goal), status: s.dataset.st });
      return;
    }
    const pr = t.closest('[data-pri]');
    if (pr) {
      await goalWrite(botId, 'PATCH', { ...goalRef(goal), priority: pr.dataset.pri });
      return;
    }
    const kind = t.closest('[data-kind]');
    if (kind) {
      kind.disabled = true;
      await goalWrite(
        botId,
        'PATCH',
        goalKindPayload(goal, kind.dataset.kind),
        kind.dataset.kind
          ? 'Marked standing — no tasks for this one'
          : 'Now a project — the agent breaks it down'
      );
      return;
    }
    if (t.closest('[data-history]')) {
      const { id, text } = goal;
      closeDrawer();
      openGoalDetail(botId, id, text, async () => {
        await reload(botId);
        paint(botId);
      });
      return;
    }
    const li = t.closest('.fb-task');
    const i = li ? Number(li.dataset.i) : -1;
    if (t.closest('[data-tdel]')) {
      const tasks = goal.tasks ?? [];
      await saveTasks(botId, goal, removeTask(tasks, i), taskRemoveRequest(botId, tasks, i));
      return;
    }
    const mv = t.closest('[data-tmove]');
    if (mv) {
      const dir = Number(mv.dataset.tmove);
      const next = moveTask(goal.tasks ?? [], i, dir);
      if (next !== goal.tasks)
        await saveTasks(
          botId,
          goal,
          next,
          taskReorderRequest(botId, goal, i, dir, tasksRev(botId))
        );
      return;
    }
    if (t.id === 'fb-morecyc') {
      st.showAllCycles = !st.showAllCycles;
      paintDrawer();
      return;
    }
    const kid = t.closest('[data-open-goal]');
    if (kid) {
      openDrawer(botId, kid.dataset.openGoal);
      return;
    }
    if (t.id === 'fb-editnotes') {
      openNotesEditor(goal);
      drawer.querySelector('#fb-notesed')?.focus();
      return;
    }
    if (t.id === 'fb-savenotes') {
      const ed = drawer.querySelector('#fb-notesed');
      const notes = ed?.value ?? '';
      // Being saved, so no longer an edit in progress: the repaint closes the editor.
      if (ed) ed.defaultValue = notes;
      await goalWrite(botId, 'PATCH', { ...goalRef(goal), notes }, 'Notes saved');
      return;
    }
    if (t.closest('[data-cancel]')) {
      const ed = drawer.querySelector('#fb-notesed');
      if (ed) ed.value = ed.defaultValue;
      paintDrawer();
      return;
    }
    if (t.id === 'fb-del' && confirmInline(t, { label: 'Click again to delete' })) {
      await goalWrite(botId, 'DELETE', goalRef(goal), 'Goal deleted');
    }
  }

  async function onClick(e) {
    const t = e.target;
    // app.js opens the cycle and worker sheets.
    if (t.closest?.('[data-open-cycle], [data-open-worker]')) return;
    if (t === scrim) closeDrawer();
    else if (drawer.contains(t)) await onDrawerClick(t);
    else await onBoardClick(t);
  }

  async function onChange(e) {
    const li = e.target.closest?.('.fb-task');
    const goal = currentGoal();
    if (!li || !goal || e.target.type !== 'checkbox') return;
    const tasks = goal.tasks ?? [];
    const i = Number(li.dataset.i);
    const botId = st.drawer.botId;
    await saveTasks(
      botId,
      goal,
      toggleTask(tasks, i),
      taskToggleRequest(botId, tasks, i, tasksRev(botId))
    );
  }

  async function onFocusOut(e) {
    const t = e.target;
    if (t.matches?.('[data-iinput]')) {
      // Left empty: back to "+ task".
      if (t.isConnected && !t.value.trim()) paint(botOf(t));
      return;
    }
    const goal = currentGoal();
    if (!goal) return;
    const botId = st.drawer.botId;
    if (t.id === 'fb-title') {
      const v = t.value.replace(/\s+/g, ' ').trim();
      const shown = t.defaultValue.replace(/\s+/g, ' ').trim();
      if (v && v !== shown)
        await goalWrite(botId, 'PATCH', { ...goalRef(goal), headline: v }, 'Title saved');
      return;
    }
    if (t.id === 'fb-brief') {
      const v = t.value.trim();
      // Emptied: the agent still needs a brief, so it goes back to what it was.
      if (!v) t.value = t.defaultValue;
      else if (v !== t.defaultValue.trim())
        await goalWrite(botId, 'PATCH', { ...goalRef(goal), brief: v }, 'Brief saved');
      return;
    }
    if (t.classList?.contains('fb-tx')) {
      const i = Number(t.closest('.fb-task')?.dataset.i);
      const v = t.textContent.trim();
      const tasks = goal.tasks ?? [];
      if (!v)
        await saveTasks(botId, goal, removeTask(tasks, i), taskRemoveRequest(botId, tasks, i));
      else if (v !== tasks[i]?.text)
        await saveTasks(
          botId,
          goal,
          renameTask(tasks, i, v),
          taskRenameRequest(botId, tasks, i, v, tasksRev(botId))
        );
    }
  }

  async function onKey(e) {
    const t = e.target;
    const mine = root.contains(t) || drawer.contains(t);
    if (!mine && e.key !== 'Escape') return;
    if (t.matches?.('[data-iinput]')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        t.value = '';
        paint(botOf(t));
      } else if (e.key === 'Enter' && t.value.trim()) {
        e.preventDefault();
        await addInlineTask(t);
      }
      return;
    }
    if (e.key === 'Enter' && t.id === 'fb-addtask' && t.value.trim()) {
      const goal = currentGoal();
      const text = t.value;
      t.value = '';
      if (goal) {
        const botId = st.drawer.botId;
        await saveTasks(
          botId,
          goal,
          addTask(goal.tasks ?? [], text),
          taskAddRequest(botId, goal, text)
        );
      }
      drawer.querySelector('#fb-addtask')?.focus();
      return;
    }
    if (e.key === 'Enter' && t.matches?.('[data-addgoal]') && t.value.trim()) {
      e.preventDefault();
      const botId = botOf(t);
      const title = t.value.trim();
      t.value = '';
      if (botId) await goalWrite(botId, 'POST', { title }, 'Goal added to Up next');
      [...root.querySelectorAll('[data-bot]')]
        .find((b) => b.dataset.bot === botId)
        ?.querySelector('[data-addgoal]')
        ?.focus();
      return;
    }
    if (e.key === 'Enter' && (t.id === 'fb-title' || t.classList?.contains('fb-tx'))) {
      e.preventDefault();
      t.blur();
      return;
    }
    if (t.id === 'fb-brief') {
      // Enter writes a newline; Ctrl/Cmd+Enter saves; Escape drops the edit.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        t.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        t.value = t.defaultValue;
        t.blur();
      }
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && t.matches?.('[data-open-goal]') && st.drawer) {
      e.preventDefault();
      openDrawer(st.drawer.botId, t.dataset.openGoal);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && t.matches?.('.fb-card[data-goal]')) {
      const botId = botOf(t);
      if (!botId) return;
      e.preventDefault();
      openDrawer(botId, t.dataset.goal);
      return;
    }
    if (e.key === 'Escape') {
      // An Open cycle / History sheet on top closes on its own Escape.
      if (document.body.classList.contains('ui-sheet-open')) return;
      if (mine && t.matches?.(FIELD)) {
        t.blur();
        return;
      }
      if (st.drawer) {
        e.preventDefault();
        closeDrawer();
      }
    }
  }

  // ── Drag a goal between the columns of its own board ──

  let dragged = null;
  let downOn = null;
  const clearOver = () =>
    root.querySelectorAll('.fb-col.over').forEach((c) => c.classList.remove('over'));
  const onPointerDown = (e) => {
    downOn = e.target;
  };
  const onDragStart = (e) => {
    const card = e.target.closest?.('.fb-card[draggable="true"]');
    if (!card) return;
    // A drag that starts on a task control or the "+ task" input is not a goal drag.
    if (downOn?.closest?.('.fb-itasks, .fb-itask-foot')) {
      e.preventDefault();
      return;
    }
    dragged = {
      botId: botOf(card),
      ref: card.dataset.goal,
      from: card.closest('.fb-col')?.dataset.status,
    };
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged.ref);
  };
  const onDragEnd = (e) => {
    e.target.closest?.('.fb-card')?.classList.remove('dragging');
    clearOver();
    dragged = null;
  };
  // Goals belong to one agent: only that agent's columns accept the card.
  const dropCol = (e) => {
    const col = e.target.closest?.('.fb-col');
    return col && dragged && botOf(col) === dragged.botId ? col : null;
  };
  const onDragOver = (e) => {
    const col = dropCol(e);
    if (!col) return;
    e.preventDefault();
    if (!col.classList.contains('over')) {
      clearOver();
      col.classList.add('over');
    }
  };
  const onDrop = async (e) => {
    const col = dropCol(e);
    if (!col) return;
    e.preventDefault();
    clearOver();
    const { botId, ref, from } = dragged;
    dragged = null;
    if (col.dataset.status === from) return;
    const goal = findGoal(botId, ref);
    if (goal) await goalWrite(botId, 'PATCH', { ...goalRef(goal), status: col.dataset.status });
  };

  for (const target of [root, drawer]) {
    target.addEventListener('click', onClick);
    target.addEventListener('change', onChange);
    target.addEventListener('focusout', onFocusOut);
  }
  scrim.addEventListener('click', onClick);
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('dragstart', onDragStart);
  root.addEventListener('dragend', onDragEnd);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('drop', onDrop);
  document.addEventListener('keydown', onKey);

  return {
    /** The goal open in the drawer for this agent (its id or text), for the card's `sel`. */
    selectedRef: (botId) => (st.drawer?.botId === botId ? st.drawer.ref : null),
    isOpen: () => Boolean(st.drawer),
    paintDrawer,
    close: closeDrawer,
    /** True while the operator types in a board or the drawer (a repaint would wipe it). */
    busy() {
      const a = document.activeElement;
      if (!a || a === document.body) return false;
      return drawer.contains(a) || (root.contains(a) && Boolean(a.matches?.(FIELD)));
    },
    destroy() {
      document.removeEventListener('keydown', onKey);
      for (const target of [root, drawer]) {
        target.removeEventListener('click', onClick);
        target.removeEventListener('change', onChange);
        target.removeEventListener('focusout', onFocusOut);
      }
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('dragstart', onDragStart);
      root.removeEventListener('dragend', onDragEnd);
      root.removeEventListener('dragover', onDragOver);
      root.removeEventListener('drop', onDrop);
      scrim.remove();
      drawer.remove();
      st.drawer = null;
    },
  };
}
