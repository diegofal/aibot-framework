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

/** Needs You items (`GET /api/needs-you` → `items`) grouped by agent id. */
export function needsByBot(items) {
  const out = {};
  for (const it of Array.isArray(items) ? items : []) {
    if (!it?.botId) continue;
    (out[it.botId] ??= []).push(it);
  }
  return out;
}

const NEED_LABEL = {
  ask: 'question',
  production: 'to review',
  permission: 'permission',
  proposal: 'proposal',
  feedback: 'feedback',
  tool: 'tool',
};

/** How many things wait on you for this agent: Needs You items, else the presence counters. */
function waitingCount(p, needs) {
  if (Array.isArray(needs) && needs.length) return needs.length;
  return (Number(p?.pendingAsks) || 0) + (Number(p?.unreviewed) || 0);
}

/**
 * One agent as a compact line; `expanded` adds its panel underneath. The line
 * is a div (role=button) on purpose: the panel holds links, and a link inside a
 * link is invalid HTML that browsers split apart.
 */
export function agentLine(
  lane,
  needs = [],
  {
    nowMs = Date.now(),
    expanded = false,
    selected = false,
    selectedRef = null,
    avatarSrc = (u) => u,
  } = {}
) {
  const { agent, presence: p, home } = lane;
  const id = String(agent?.id ?? '');
  const state = stateLine(p, nowMs);
  const cols = boardColumns(home);
  const open = [...cols.inProgress, ...cols.todo, ...cols.blocked];
  const focus = cols.inProgress[0] ?? cols.todo[0] ?? null;
  const tasks = open.flatMap((g) => (Array.isArray(g.tasks) ? g.tasks : []));
  const waiting = waitingCount(p, needs);
  const focusText = home
    ? focus
      ? `<span class="fb-pri ${esc(focus.priority)}"></span><span class="fb-t">${esc(goalHeadline(focus).head)}</span>${cols.inProgress.length > 1 ? `<span class="fb-more">+${cols.inProgress.length - 1}</span>` : ''}`
      : '<span class="fb-dim">No open goals</span>'
    : '<span class="fb-dim">Goals not loaded</span>';
  return `<div class="fb-agent-row${expanded ? ' open' : ''}${selected ? ' kb' : ''}" data-row="${esc(id)}">
    <div class="fb-line" role="button" tabindex="0" data-toggle="${esc(id)}" aria-expanded="${expanded}">
      <span class="fb-chev" aria-hidden="true">›</span>
      ${face(agent, p, 26, avatarSrc)}
      <span class="fb-name">${esc(agent?.name ?? id)}</span>
      <span class="fb-state ${state.tone}">${esc(state.text)}</span>
      <span class="fb-focus">${focusText}</span>
      <span class="fb-count">${open.length} goal${open.length === 1 ? '' : 's'}${tasks.length ? ` · ${mini(tasks)}` : ''}${cols.blocked.length ? ` · <span class="fb-bad">${cols.blocked.length} blocked</span>` : ''}</span>
      <span class="fb-wait">${waiting ? `<span class="fb-pill">${waiting} waiting</span>` : ''}</span>
    </div>
    ${expanded ? agentPanel(lane, needs, { nowMs, selectedRef }) : ''}
  </div>`;
}

/** The expanded part: what it is doing, what it waits on (the real items), controls, its goals. */
export function agentPanel(lane, needs = [], { nowMs = Date.now(), selectedRef = null } = {}) {
  const { agent, presence: p, home } = lane;
  const id = String(agent?.id ?? '');
  const state = stateLine(p, nowMs);
  const cycle = lastCycle(home);
  const items = Array.isArray(needs) ? needs : [];
  const shown = items.slice(0, 5);
  const fallback = waitingCount(p, []);
  const waitList = shown.length
    ? `<ul class="fb-needlist">${shown
        .map(
          (n) =>
            `<li><span class="fb-needkind">${esc(NEED_LABEL[n.kind] ?? n.kind)}</span><a href="${esc(n.href || '#/needs')}">${esc(n.title || 'Open')}</a></li>`
        )
        .join(
          ''
        )}</ul>${items.length > shown.length ? `<a class="fb-link" href="#/needs?bot=${encodeURIComponent(id)}">+${items.length - shown.length} more in Needs you</a>` : ''}`
    : fallback
      ? `<a class="fb-link" href="#/needs?bot=${encodeURIComponent(id)}">${fallback} item${fallback === 1 ? '' : 's'} in Needs you</a>`
      : '<div class="fb-dim">Nothing waiting on you. It can keep going.</div>';
  const cols = boardColumns(home);
  const board = home
    ? `<div class="fb-board${cols.blocked.length ? '' : ' no-blocked'}" data-bot="${esc(id)}">${BOARD_COLUMNS.map((c) => column(c, cols[c.id], selectedRef)).join('')}</div>`
    : `<div class="fb-error">Could not load goals for this agent. <button type="button" class="btn btn-sm" data-reload="${esc(id)}">Retry</button></div>`;
  return `<div class="fb-panel">
    <aside class="fb-side">
      <div class="fb-side-block"><div class="fb-lbl">Doing now</div>
        <div class="fb-state ${state.tone} fb-wrap">${esc(state.text)}</div>
        ${cycle?.summary ? `<div class="fb-last">Last cycle ${esc(relativeTime(cycle.ts, nowMs))}: ${esc(cycle.summary)}</div>` : ''}</div>
      <div class="fb-side-block"><div class="fb-lbl">Waiting on you</div>${waitList}</div>
      <div class="fb-side-act">${fleetQuickActions(agent, p)}<a class="btn btn-sm" href="#/agents/${encodeURIComponent(id)}">Agent home</a></div>
    </aside>
    ${board}
  </div>`;
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
        <div class="fb-brief"><div class="fb-brief-text${brief.length > 180 ? ' clamp' : ''}" id="fb-brief">${esc(brief)}</div></div>
        ${brief.length > 180 ? '<button type="button" class="fb-link" id="fb-morebrief">Show full brief</button>' : ''}</div>
      <div class="fb-field"><div class="fb-lbl">Notes<span class="fb-sp"></span><button type="button" class="fb-link" id="fb-editnotes">${notes ? 'Edit' : 'Add'}</button></div>
        <div id="fb-notes">${notes ? `<div class="fb-notes">${esc(notes)}</div>` : '<div class="fb-dim">No notes yet.</div>'}</div></div>
    </div>
    <div class="fb-d-foot"><button type="button" class="btn btn-sm btn-danger" id="fb-del">Delete goal</button><span class="fb-sp"></span><button type="button" class="btn btn-sm" data-close>Done</button></div>`;
}
