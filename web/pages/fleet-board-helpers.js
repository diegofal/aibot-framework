/**
 * Fleet Board — pure helpers (no DOM, no fetch), tested in
 * tests/web/fleet-board-helpers.test.ts.
 *
 * The whole fleet as one board: a swimlane per agent (what it is doing now,
 * its controls, what needs you) with its goals in four columns, and each goal
 * carrying its subtasks (`- task:` lines in GOALS.md). Every edit goes through
 * the goal routes of src/web/routes/agent-home.ts.
 */
import { avatar, badge, esc } from '../ui/index.js';
import { formatNext, postureTone } from './agent-home-helpers.js';
import { fleetQuickActions } from './fleet-home-helpers.js';
import { relativeTime } from './stats-helpers.js';

/** Board columns, left to right; `status` is what a drop onto the column PATCHes. */
export const BOARD_COLUMNS = [
  { id: 'todo', label: 'To do', status: 'pending' },
  { id: 'inProgress', label: 'In progress', status: 'in_progress' },
  { id: 'blocked', label: 'Blocked', status: 'blocked' },
  { id: 'done', label: 'Done', status: 'done' },
];

/** Completed goals shown per lane (newest first). */
export const DONE_SHOWN = 5;

// ── Subtasks (pure; each returns a new array, or the same one when nothing changes) ──

function oneLine(text) {
  return String(text ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

export function toggleTask(tasks, i) {
  if (!Array.isArray(tasks) || !tasks[i]) return tasks;
  return tasks.map((t, n) => (n === i ? { ...t, done: !t.done } : t));
}

export function addTask(tasks, text) {
  const clean = oneLine(text);
  if (!clean) return tasks;
  return [...(tasks ?? []), { text: clean, done: false }];
}

export function renameTask(tasks, i, text) {
  const clean = oneLine(text);
  if (!clean || !Array.isArray(tasks) || !tasks[i]) return tasks;
  return tasks.map((t, n) => (n === i ? { ...t, text: clean } : t));
}

export function removeTask(tasks, i) {
  if (!Array.isArray(tasks) || !tasks[i]) return tasks;
  return tasks.filter((_, n) => n !== i);
}

/** Move task `i` by `dir` (-1 up, +1 down). */
export function moveTask(tasks, i, dir) {
  const j = i + dir;
  if (!Array.isArray(tasks) || !tasks[i] || j < 0 || j >= tasks.length) return tasks;
  const next = [...tasks];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function taskProgress(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const done = list.filter((t) => t.done).length;
  return {
    done,
    total: list.length,
    pct: list.length ? Math.round((done / list.length) * 100) : 0,
  };
}

// ── Data shaping ──

/** How the routes find a goal: its id, else its exact title (goals written before ids). */
export function goalRef(goal) {
  return goal?.id ? { id: goal.id } : { goal: goal?.text ?? '' };
}

function refValue(goal) {
  return goal?.id || goal?.text || '';
}

/** Agent Home payload → the four columns. */
export function boardColumns(home) {
  const g = home?.goals;
  return {
    todo: g?.todo ?? [],
    inProgress: g?.inProgress ?? [],
    blocked: g?.blocked ?? [],
    done: (g?.completedRecently ?? []).slice(0, DONE_SHOWN),
  };
}

/** The newest agent-loop cycle in the home timeline: `{ ts, summary }` or null. */
export function lastCycle(home) {
  const cycles = (home?.timeline ?? []).filter((i) => i?.kind === 'cycle');
  if (!cycles.length) return null;
  const newest = cycles.reduce((a, b) => (Date.parse(b.ts) > Date.parse(a.ts) ? b : a));
  return { ts: newest.ts, summary: newest.detail ?? newest.title ?? '' };
}

function laneMatches(lane, filter) {
  const p = lane?.presence ?? {};
  if (filter === 'working') return Boolean(p.isExecuting);
  if (filter === 'needs') return (Number(p.pendingAsks) || 0) + (Number(p.unreviewed) || 0) > 0;
  return true;
}

export function filterLanes(lanes = [], filter = 'all') {
  return lanes.filter((l) => laneMatches(l, filter));
}

export function boardFilterCounts(lanes = []) {
  return {
    all: lanes.length,
    working: filterLanes(lanes, 'working').length,
    needs: filterLanes(lanes, 'needs').length,
  };
}

// ── Markup ──

const PRIORITY_TONE = { high: 'danger', medium: 'warn', low: 'muted' };

function taskRow(t, i) {
  return `<li class="fb-task${t.done ? ' fb-task-done' : ''}" data-task="${i}">
    <input type="checkbox" class="fb-task-check" data-action="toggle-task" aria-label="Done"${t.done ? ' checked' : ''}>
    <span class="fb-task-text" data-action="edit-task" title="Double-click to edit">${esc(t.text)}</span>
    <span class="fb-task-tools">
      <button type="button" class="fb-icon" data-action="task-up" title="Move up" aria-label="Move up">↑</button>
      <button type="button" class="fb-icon" data-action="task-down" title="Move down" aria-label="Move down">↓</button>
      <button type="button" class="fb-icon" data-action="remove-task" title="Remove subtask" aria-label="Remove subtask">×</button>
    </span>
  </li>`;
}

/** One goal card: title, priority, owner, subtask checklist with progress, inline add. */
export function goalCard(botId, goal, column) {
  const done = column === 'done';
  const tasks = Array.isArray(goal?.tasks) ? goal.tasks : [];
  const prog = taskProgress(tasks);
  const pri = String(goal?.priority ?? 'medium');
  const mine = /^operator/.test(String(goal?.source ?? ''));
  const notes = goal?.notes ? String(goal.notes) : '';
  const bar = prog.total
    ? `<div class="fb-progress" title="${prog.done} of ${prog.total} subtasks done"><span style="width:${prog.pct}%"></span></div>
       <span class="fb-progress-label">${prog.done}/${prog.total}</span>`
    : '';
  return `<article class="fb-card${done ? ' fb-card-done' : ''}" data-bot="${esc(botId)}" data-goal="${esc(refValue(goal))}"${done ? '' : ' draggable="true"'}>
    <div class="fb-card-head">
      <span class="fb-card-title" data-action="edit-title" title="Click to rename">${esc(goal?.text ?? '')}</span>
      <button type="button" class="fb-icon fb-card-menu" data-action="toggle-detail" title="Notes, priority, delete" aria-label="Goal details">⋯</button>
    </div>
    <div class="fb-card-meta">
      <button type="button" class="fb-chip-btn" data-action="cycle-priority" title="Change priority">${badge(pri, PRIORITY_TONE[pri] ?? 'muted')}</button>
      ${mine ? badge('you', 'accent') : ''}
      ${bar}
    </div>
    ${notes ? `<div class="fb-card-notes text-dim">${esc(notes.length > 140 ? `${notes.slice(0, 139)}…` : notes)}</div>` : ''}
    ${tasks.length ? `<ul class="fb-tasks">${tasks.map(taskRow).join('')}</ul>` : ''}
    ${
      done
        ? ''
        : `<form class="fb-add-task" data-action="add-task"><input type="text" name="task" maxlength="200" placeholder="+ Add subtask" aria-label="Add subtask"></form>`
    }
    <div class="fb-detail" hidden>
      <label class="fb-detail-label">Notes
        <textarea name="notes" rows="3" maxlength="600">${esc(notes)}</textarea>
      </label>
      <div class="fb-detail-row">
        <button type="button" class="btn btn-sm" data-action="save-notes">Save notes</button>
        <a class="btn btn-sm" href="#/agents/${encodeURIComponent(botId)}" title="Open in Agent Home">History</a>
        <button type="button" class="btn btn-sm btn-danger" data-action="delete-goal">Delete goal</button>
      </div>
    </div>
  </article>`;
}

function column(botId, col, goals) {
  const add =
    col.id === 'todo'
      ? `<form class="fb-add-goal" data-action="add-goal"><input type="text" name="title" maxlength="200" placeholder="+ Add goal" aria-label="Add goal"></form>`
      : '';
  return `<div class="fb-col" data-col="${col.id}" data-status="${col.status}" data-bot="${esc(botId)}">
    <div class="fb-col-head">${esc(col.label)} <span class="fb-count">${goals.length}</span></div>
    <div class="fb-col-body">${goals.map((g) => goalCard(botId, g, col.id)).join('')}</div>
    ${add}
  </div>`;
}

/** The lane header: who, what it is doing right now, what it did last, what needs you, controls. */
function laneHead(agent, p, home, nowMs, avatarSrc) {
  const id = String(agent?.id ?? '');
  const name = agent?.name ?? p?.name ?? id;
  const tone = postureTone(p?.posture ?? 'unknown');
  const faceUrl = p?.avatarUrl ?? agent?.avatarUrl ?? null;
  const live = p?.isExecuting
    ? `<div class="fb-live"><span class="fleet-live-dot"></span> ${esc(p.currentTool ? `running ${p.currentTool}` : 'working')}</div>`
    : '';
  const cycle = lastCycle(home);
  const last = cycle?.summary
    ? `<div class="fb-last text-dim" title="${esc(cycle.summary)}">Last cycle ${esc(relativeTime(cycle.ts, nowMs))}: ${esc(cycle.summary)}</div>`
    : '';
  const asks = Number(p?.pendingAsks) || 0;
  const review = Number(p?.unreviewed) || 0;
  const needs = [];
  if (asks)
    needs.push(
      `<a class="fleet-need" href="#/needs?bot=${encodeURIComponent(id)}">${asks} ask${asks === 1 ? '' : 's'}</a>`
    );
  if (review)
    needs.push(
      `<a class="fleet-need" href="#/work/productions/${encodeURIComponent(id)}">${review} to review</a>`
    );
  const next = p && !p.isExecuting ? formatNext(p.nextRunAt, nowMs) : '';
  return `<header class="fb-lane-head">
    <a class="fb-who" href="#/agents/${encodeURIComponent(id)}">
      ${avatar({ seed: id, name, src: faceUrl ? avatarSrc(faceUrl) : undefined, size: 36, status: tone })}
      <span class="fb-name">${esc(name)}</span>
    </a>
    <div class="fleet-now fleet-now-${esc(p?.tone ?? tone)}">${esc(p?.nowLine ?? 'Loading…')}</div>
    ${live}${last}
    ${next ? `<div class="fb-next text-dim">${esc(next)}</div>` : ''}
    ${needs.length ? `<div class="fleet-needs">${needs.join('')}</div>` : ''}
    ${fleetQuickActions(agent, p)}
  </header>`;
}

/** One swimlane. `home` null = the goals could not be loaded (said, not shown as empty). */
export function boardLane(agent, p, home, nowMs = Date.now(), { avatarSrc = (u) => u } = {}) {
  const id = String(agent?.id ?? '');
  const cols = boardColumns(home);
  const body = home
    ? BOARD_COLUMNS.map((c) => column(id, c, cols[c.id])).join('')
    : `<div class="fb-lane-error text-dim">Could not load goals for this agent. <button type="button" class="btn btn-sm" data-action="reload-lane">Retry</button></div>`;
  return `<section class="fb-lane${p?.isExecuting ? ' fb-lane-live' : ''}" data-lane="${esc(id)}">
    ${laneHead(agent, p, home, nowMs, avatarSrc)}
    <div class="fb-cols">${body}</div>
  </section>`;
}

export function boardFilterChips(active = 'all', counts = {}) {
  const chip = (id, label) =>
    `<button type="button" class="agents-chip${active === id ? ' agents-chip-active' : ''}" data-board-filter="${id}" aria-pressed="${active === id}">${esc(label)} <span class="agents-chip-n">${Number(counts[id]) || 0}</span></button>`;
  return `<div class="fleet-chips" role="group" aria-label="Filter lanes">${chip('all', 'All')}${chip('working', 'Working now')}${chip('needs', 'Needs you')}</div>`;
}
