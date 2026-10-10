/**
 * Fleet Board — pure helpers (no DOM, no fetch), tested in
 * tests/web/fleet-board-helpers.test.ts.
 *
 * Two levels plus a drawer, designed for reading first:
 *   overview  one compact row per agent: who + state → focus → up next → needs you
 *   board     one agent's goals in In progress / Up next / Blocked / Done
 *   drawer    one goal: status, priority, subtasks, brief, notes, delete
 * Cards show a short headline (`goal.headline`, else derived from the text by
 * `goalHeadline`); the full text is the brief the agent reads, shown in the drawer.
 */
import { avatar, esc } from '../ui/index.js';
import { formatNext, postureTone } from './agent-home-helpers.js';
import { fleetQuickActions } from './fleet-home-helpers.js';
import { relativeTime } from './stats-helpers.js';

/** Board columns, left to right; `status` is what a drop / the drawer PATCHes. */
export const BOARD_COLUMNS = [
  { id: 'inProgress', label: 'In progress', status: 'in_progress', hint: 'what it works on' },
  { id: 'todo', label: 'Up next', status: 'pending', hint: 'queued' },
  { id: 'blocked', label: 'Blocked', status: 'blocked', hint: 'needs a decision' },
  { id: 'done', label: 'Done', status: 'done', hint: 'latest' },
];
export const DONE_SHOWN = 8;
const HEADLINE_MAX = 72;

// ── Subtasks (pure; a new array, or the same one when nothing changes) ──

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

// ── Headline ──

function cutAtWord(s, n) {
  const c = s.slice(0, n);
  const at = Math.max(c.lastIndexOf(' '), n - 12);
  return `${c.slice(0, at).replace(/[,;:\s]+$/, '')}…`;
}

/**
 * `{ head, tag }` for a card. A headline set on the board wins; otherwise the
 * text up to its earliest clause break (`: `, ` — `, ` (`, `. `, `; `, `, `,
 * each with a minimum length before it, never inside quotes), capped at a word.
 * "Live up to my purpose: X" reads "Purpose: X"; a leading all-caps tag
 * ("DORMIDO — …") becomes `tag`; an all-caps opening is sentence-cased.
 */
export function goalHeadline(goal) {
  const set = String(goal?.headline ?? '').trim();
  if (set) return { head: set, tag: null };
  let t = String(goal?.text ?? '').trim();
  let tag = null;
  const tagged = t.match(/^([A-ZÁÉÍÓÚÑ]{4,})\s*[—–-]\s*(.*)$/);
  if (tagged) {
    tag = tagged[1].toLowerCase() === 'dormido' ? 'dormant' : tagged[1].toLowerCase();
    t = tagged[2].replace(/^Gatillo:\s*/i, '');
  }
  const purpose = t.match(/^Live up to my purpose:\s*(.*)$/i);
  if (purpose) t = `Purpose: ${purpose[1]}`;
  const caps = t.match(/^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{8,})(?=[,:—])/);
  if (caps) t = caps[1].charAt(0) + caps[1].slice(1).toLowerCase() + t.slice(caps[1].length);
  const MIN = { ': ': 8, ' — ': 8, ' (': 24, '. ': 16, '; ': 16, ', ': 28 };
  const quotesOk = (s) => (s.match(/["“”]/g) || []).length % 2 === 0;
  let best = -1;
  for (const [sep, min] of Object.entries(MIN)) {
    const i = t.indexOf(sep);
    if (i >= min && i <= 78 && quotesOk(t.slice(0, i)) && (best < 0 || i < best)) best = i;
  }
  let head = best > 0 ? t.slice(0, best) : t;
  if (head.length > HEADLINE_MAX) head = cutAtWord(head, HEADLINE_MAX);
  return { head: head.charAt(0).toUpperCase() + head.slice(1), tag };
}

// ── State and data shaping ──

/** `{ text, tone }`: "Working · web_fetch" / "Waiting on you · 1 question" / "Idle · next run in 3h". */
export function stateLine(p, nowMs = Date.now()) {
  if (p?.isExecuting) {
    const what =
      p.currentTool ||
      String(p.phase ?? '')
        .replace(/[:_-]+/g, ' ')
        .trim();
    return { text: what ? `Working · ${what}` : 'Working', tone: 'live' };
  }
  if (p && p.running === false)
    return { text: p.enabled === false ? 'Disabled' : 'Stopped', tone: 'off' };
  const asks = Number(p?.pendingAsks) || 0;
  if (asks)
    return { text: `Waiting on you · ${asks} question${asks === 1 ? '' : 's'}`, tone: 'wait' };
  const next = formatNext(p?.nextRunAt, nowMs);
  return { text: next ? `Idle · ${next}` : 'Idle', tone: 'idle' };
}

/** How the routes find a goal: its id, else its exact text (goals written before ids). */
export function goalRef(goal) {
  return goal?.id ? { id: goal.id } : { goal: goal?.text ?? '' };
}
function refValue(goal) {
  return goal?.id || goal?.text || '';
}

/** Agent Home payload → the board columns. */
export function boardColumns(home) {
  const g = home?.goals;
  return {
    inProgress: g?.inProgress ?? [],
    todo: g?.todo ?? [],
    blocked: g?.blocked ?? [],
    done: (g?.completedRecently ?? []).slice(0, DONE_SHOWN),
  };
}

/** Newest agent-loop cycle in the home timeline: `{ ts, summary }` or null. */
export function lastCycle(home) {
  const cycles = (home?.timeline ?? []).filter((i) => i?.kind === 'cycle');
  if (!cycles.length) return null;
  const newest = cycles.reduce((a, b) => (Date.parse(b.ts) > Date.parse(a.ts) ? b : a));
  return { ts: newest.ts, summary: newest.detail ?? newest.title ?? '' };
}

function openGoals(home) {
  const c = boardColumns(home);
  return [...c.inProgress, ...c.todo, ...c.blocked];
}

export function fleetPulse(lanes = []) {
  return {
    agents: lanes.length,
    working: lanes.filter((l) => l.presence?.isExecuting).length,
    waiting: lanes.reduce(
      (s, l) => s + (Number(l.presence?.pendingAsks) || 0) + (Number(l.presence?.unreviewed) || 0),
      0
    ),
    openGoals: lanes.reduce((s, l) => s + openGoals(l.home).length, 0),
  };
}

/** `filter`: all | live | needs; `query` matches the agent name or any goal text / headline. */
export function filterLanes(lanes = [], filter = 'all', query = '') {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  return lanes.filter((l) => {
    const p = l.presence ?? {};
    if (filter === 'live' && !p.isExecuting) return false;
    if (filter === 'needs' && !((Number(p.pendingAsks) || 0) + (Number(p.unreviewed) || 0)))
      return false;
    if (!q) return true;
    const name = String(l.agent?.name ?? l.agent?.id ?? '').toLowerCase();
    return (
      name.includes(q) ||
      openGoals(l.home).some((g) => `${g.text} ${g.headline ?? ''}`.toLowerCase().includes(q))
    );
  });
}

// ── Markup ──

const PRIORITIES = ['low', 'medium', 'high'];

function face(agent, p, size, avatarSrc) {
  const id = String(agent?.id ?? '');
  const name = agent?.name ?? id;
  const url = p?.avatarUrl ?? agent?.avatarUrl ?? null;
  return avatar({
    seed: id,
    name,
    src: url ? avatarSrc(url) : undefined,
    size,
    status: postureTone(p?.posture ?? 'unknown'),
  });
}

function mini(tasks) {
  const p = taskProgress(tasks);
  if (!p.total) return '';
  return `<span class="fb-mini" title="${p.done} of ${p.total} subtasks done"><s><em style="width:${p.pct}%"></em></s>${p.done}/${p.total}</span>`;
}

function sourceTag(goal) {
  const src = String(goal?.source ?? '');
  if (/^operator/.test(src)) return '<span class="fb-tag you">you</span>';
  return src ? `<span class="fb-tag">${esc(src.split(':')[0])}</span>` : '';
}

function needsPills(id, p) {
  const asks = Number(p?.pendingAsks) || 0;
  const review = Number(p?.unreviewed) || 0;
  const out = [];
  if (asks)
    out.push(
      `<a class="fb-pill" href="#/needs?bot=${encodeURIComponent(id)}">${asks} ask${asks === 1 ? '' : 's'}</a>`
    );
  if (review)
    out.push(
      `<a class="fb-pill" href="#/work/productions/${encodeURIComponent(id)}">${review} to review</a>`
    );
  return out.join('');
}

/** One overview row (the whole row links to the agent's board). */
export function overviewRow(
  lane,
  i,
  { nowMs = Date.now(), selected = false, avatarSrc = (u) => u } = {}
) {
  const { agent, presence: p, home } = lane;
  const id = String(agent?.id ?? '');
  const state = stateLine(p, nowMs);
  const cols = boardColumns(home);
  const focusLine = (g) =>
    `<div class="fb-fl"><span class="fb-pri ${esc(g.priority)}"></span><span class="fb-t">${esc(goalHeadline(g).head)}</span>${mini(g.tasks)}</div>`;
  const focus = home
    ? cols.inProgress.slice(0, 2).map(focusLine).join('') ||
      '<span class="fb-dim">Nothing in progress</span>'
    : '<span class="fb-dim">Goals not loaded</span>';
  const moreFocus =
    cols.inProgress.length > 2
      ? `<span class="fb-more">+${cols.inProgress.length - 2} more</span>`
      : '';
  const blocked = cols.blocked.length
    ? `<span class="fb-pill danger">${cols.blocked.length} blocked</span>`
    : '';
  const next = cols.todo[0]
    ? `<span class="fb-t">${esc(goalHeadline(cols.todo[0]).head)}</span>${cols.todo.length > 1 ? `<span class="fb-more">+${cols.todo.length - 1} queued</span>` : ''}`
    : blocked
      ? ''
      : '<span class="fb-dim">—</span>';
  const needs = needsPills(id, p) || '<span class="fb-dim">nothing</span>';
  return `<a class="fb-row${selected ? ' kb' : ''}" href="#/board/${encodeURIComponent(id)}" data-row="${esc(id)}" style="animation-delay:${Math.min(i, 12) * 30}ms">
    <div class="fb-who">${face(agent, p, 38, avatarSrc)}<div class="fb-who-txt"><div class="fb-name">${esc(agent?.name ?? id)}</div><div class="fb-state ${state.tone}">${esc(state.text)}</div></div></div>
    <div class="fb-focus">${focus}${moreFocus}</div>
    <div class="fb-next">${blocked}${next}</div>
    <div class="fb-needs">${needs}</div>
    <div class="fb-go" aria-hidden="true">›</div>
  </a>`;
}

/** One goal card: headline (≤ 2 lines), quiet meta, priority as a colored edge. */
export function cardHtml(goal, selected) {
  const { head, tag } = goalHeadline(goal);
  const ref = esc(refValue(goal));
  if (goal?.section === 'completed' || goal?.status === 'completed') {
    return `<div class="fb-card done" data-goal="${ref}"><div class="fb-h"><span class="fb-check">✓</span>${esc(head)}</div></div>`;
  }
  const pri = PRIORITIES.includes(goal?.priority) ? goal.priority : 'medium';
  return `<div class="fb-card ${pri}${selected ? ' sel' : ''}" data-goal="${ref}" draggable="true" tabindex="0">
    <div class="fb-h">${esc(head)}</div>
    <div class="fb-meta">${tag ? `<span class="fb-tag sleep">${esc(tag)}</span>` : ''}${sourceTag(goal)}${goal?.notes ? '<span class="fb-dim" title="Has notes">✎</span>' : ''}<span class="fb-sp"></span>${mini(goal?.tasks)}</div>
  </div>`;
}

function column(col, goals, selectedRef) {
  if (col.id === 'blocked' && goals.length === 0) {
    return `<div class="fb-col slim" data-col="${col.id}" data-status="${col.status}" title="Blocked — drop a goal here"><div class="fb-slim-label">Blocked · 0</div></div>`;
  }
  const cards = goals.map((g) => cardHtml(g, refValue(g) === selectedRef)).join('');
  return `<div class="fb-col" data-col="${col.id}" data-status="${col.status}">
    <div class="fb-col-h"><h3>${esc(col.label)}</h3><span class="fb-n">${goals.length}</span><span class="fb-hint">${esc(col.hint)}</span></div>
    <div class="fb-cards">${cards || '<div class="fb-dim fb-empty-col">Nothing here. Drag a goal in.</div>'}</div>
    ${col.id === 'todo' ? '<input class="fb-add" data-addgoal maxlength="200" placeholder="+ New goal, then Enter" aria-label="New goal">' : ''}
  </div>`;
}

/** One agent's board: agent switcher, header (state, last cycle, controls), columns. */
export function agentBoardHtml(
  lane,
  lanes = [],
  { nowMs = Date.now(), selectedRef = null, avatarSrc = (u) => u } = {}
) {
  const { agent, presence: p, home } = lane;
  const id = String(agent?.id ?? '');
  const state = stateLine(p, nowMs);
  const cycle = lastCycle(home);
  const chips = lanes
    .map(
      (l) =>
        `<a class="fb-chip${l.agent.id === id ? ' on' : ''}" href="#/board/${encodeURIComponent(l.agent.id)}">${face(l.agent, l.presence, 22, avatarSrc)}${esc(l.agent.name ?? l.agent.id)}</a>`
    )
    .join('');
  const cols = boardColumns(home);
  const board = home
    ? `<div class="fb-board${cols.blocked.length ? '' : ' no-blocked'}">${BOARD_COLUMNS.map((c) => column(c, cols[c.id], selectedRef)).join('')}</div>`
    : '<div class="fb-error">Could not load goals for this agent. <button type="button" class="btn btn-sm" data-reload>Retry</button></div>';
  return `<div class="fb-crumbs"><a href="#/board">← Fleet board</a></div>
    <nav class="fb-switch" aria-label="Agents">${chips}</nav>
    <header class="fb-agent">
      ${face(agent, p, 48, avatarSrc)}
      <div class="fb-agent-txt">
        <div class="fb-agent-name">${esc(agent?.name ?? id)}</div>
        <div class="fb-state ${state.tone}">${esc(state.text)}</div>
        ${cycle?.summary ? `<div class="fb-last" title="${esc(cycle.summary)}">Last cycle ${esc(relativeTime(cycle.ts, nowMs))}: ${esc(cycle.summary)}</div>` : ''}
      </div>
      <div class="fb-agent-act">${needsPills(id, p)}<a class="btn btn-sm" href="#/agents/${encodeURIComponent(id)}">Agent home</a>${fleetQuickActions(agent, p)}</div>
    </header>
    ${board}
    <div class="fb-foot-hint">Click a card to edit · drag cards between columns · <span class="fb-kbd">Esc</span> back</div>`;
}

/** The goal drawer. Every control carries a data attribute the page delegates. */
export function drawerHtml(agent, goal) {
  const { head } = goalHeadline(goal);
  const done = goal?.section === 'completed' || goal?.status === 'completed';
  const status = done
    ? 'done'
    : goal?.status === 'blocked'
      ? 'blocked'
      : goal?.status === 'pending'
        ? 'pending'
        : 'in_progress';
  const tasks = Array.isArray(goal?.tasks) ? goal.tasks : [];
  const p = taskProgress(tasks);
  const notes = goal?.notes ? String(goal.notes) : '';
  const brief = String(goal?.text ?? '');
  const seg = (attr, items, on) =>
    items
      .map(
        ([v, label]) =>
          `<button type="button" data-${attr}="${v}" class="${v === on ? 'on' : ''}">${label}</button>`
      )
      .join('');
  return `<div class="fb-d-head">
      <div class="fb-d-who">${esc(agent?.name ?? agent?.id ?? '')} · ${sourceTag(goal) || '<span class="fb-tag">agent</span>'}<button type="button" class="fb-d-close" data-close aria-label="Close">×</button></div>
      <textarea class="fb-d-title" id="fb-title" rows="2" maxlength="100" aria-label="Title">${esc(head)}</textarea>
    </div>
    <div class="fb-d-body">
      <div class="fb-field"><div class="fb-lbl">Status</div>
        <div class="fb-seg">${seg(
          'st',
          BOARD_COLUMNS.map((c) => [c.status, c.label]),
          status
        )}</div></div>
      <div class="fb-field"><div class="fb-lbl">Priority</div>
        <div class="fb-seg">${seg(
          'pri',
          PRIORITIES.map((x) => [
            x,
            `<span class="fb-pri ${x}"></span>${x[0].toUpperCase()}${x.slice(1)}`,
          ]),
          goal?.priority
        )}</div></div>
      <div class="fb-field"><div class="fb-lbl">Subtasks<span class="fb-sp"></span>${p.total ? `${p.done}/${p.total}` : ''}</div>
        ${p.total ? `<div class="fb-prog"><em style="width:${p.pct}%"></em></div>` : ''}
        <ul class="fb-tasks">${tasks
          .map(
            (t, i) => `<li class="fb-task${t.done ? ' done' : ''}" data-i="${i}">
          <input type="checkbox"${t.done ? ' checked' : ''} aria-label="Done">
          <span class="fb-tx" contenteditable="true" spellcheck="false">${esc(t.text)}</span>
          <span class="fb-tt"><button type="button" class="fb-ic" data-tmove="-1" title="Move up">↑</button><button type="button" class="fb-ic" data-tmove="1" title="Move down">↓</button><button type="button" class="fb-ic" data-tdel title="Remove">×</button></span>
        </li>`
          )
          .join('')}</ul>
        ${done ? '' : '<input class="fb-add" id="fb-addtask" maxlength="200" placeholder="+ Add a subtask, then Enter" aria-label="Add subtask">'}</div>
      <div class="fb-field"><div class="fb-lbl">Brief<span class="fb-sp"></span><span class="fb-lbl-note">what the agent reads</span><button type="button" class="fb-link" id="fb-editbrief">Edit</button></div>
        <div class="fb-brief${brief.length > 180 ? ' clamp' : ''}" id="fb-brief">${esc(brief)}</div>
        ${brief.length > 180 ? '<button type="button" class="fb-link" id="fb-morebrief">Show full brief</button>' : ''}</div>
      <div class="fb-field"><div class="fb-lbl">Notes<span class="fb-sp"></span><button type="button" class="fb-link" id="fb-editnotes">${notes ? 'Edit' : 'Add'}</button></div>
        <div id="fb-notes">${notes ? `<div class="fb-notes">${esc(notes)}</div>` : '<div class="fb-dim">No notes yet.</div>'}</div></div>
    </div>
    <div class="fb-d-foot"><button type="button" class="btn btn-sm btn-danger" id="fb-del">Delete goal</button><span class="fb-sp"></span><button type="button" class="btn btn-sm" data-close>Done</button></div>`;
}
