/**
 * Presence header for an agent — the first visible sign of life.
 *
 * Pure helpers (string in, string out) live here so `tests/web/` can cover
 * them; the only DOM-touching function is `applyPresence`, which updates an
 * already-rendered header in place when a live event arrives.
 */
import { avatar, badge, emptyState, esc, kpi, radar, sparkline, tabs } from '../ui/index.js';
import { faceControl, speakButton } from './agent-face-helpers.js';
import { whyPanel } from './why-helpers.js';

export const POSTURE_TONE = {
  active: 'ok',
  standby: 'warn',
  idle: 'warn',
  blocked: 'danger',
  dormant: 'muted',
  unknown: 'muted',
};

export function postureTone(posture) {
  return POSTURE_TONE[posture] ?? 'muted';
}

/** "next run in 5m" / "next run now" / '' when unknown. */
export function formatNext(nextRunAt, nowMs = Date.now()) {
  const ts =
    nextRunAt == null ? null : typeof nextRunAt === 'number' ? nextRunAt : Date.parse(nextRunAt);
  if (ts == null || !Number.isFinite(ts)) return '';
  const diff = ts - nowMs;
  if (diff <= 30_000) return 'next run now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `next run in ${m}m`;
  const h = Math.round(diff / 3_600_000);
  if (h < 48) return `next run in ${h}h`;
  return `next run in ${Math.round(diff / 86_400_000)}d`;
}

/** Secondary line under the now-line: backend, channel, next run. */
export function presenceMeta(identity = {}, presence = {}, nowMs = Date.now()) {
  const parts = [];
  if (identity.backend)
    parts.push(identity.model ? `${identity.backend} · ${identity.model}` : identity.backend);
  if (identity.channel?.kind) {
    const state = identity.channel.state ? ` ${identity.channel.state}` : '';
    parts.push(`${identity.channel.kind}${state}`);
  }
  if (presence.isExecuting) parts.push('cycle running');
  else {
    const next = formatNext(presence.nextRunAt, nowMs);
    if (next) parts.push(next);
  }
  return parts.join(' · ');
}

/**
 * Header markup. `home` is the `/api/agents/:id/home` payload (or at least
 * `{ identity, presence }`); `actions` is trusted HTML for the button row.
 * Session S4: `avatarSrc` decorates `identity.avatarUrl` (the page adds the
 * auth token), `face` adds the "Change face" control inside the avatar and
 * `voice` adds the play button next to the now-line.
 */
export function presenceHeader(
  home,
  {
    actions = '',
    nowMs = Date.now(),
    backHref = '#/agents',
    avatarSrc = (u) => u,
    face = false,
    voice = false,
  } = {}
) {
  const identity = home?.identity ?? {};
  const presence = home?.presence ?? {};
  const tone = postureTone(presence.posture);
  const name = identity.name ?? identity.id ?? 'Agent';
  const meta = presenceMeta(identity, presence, nowMs);
  const src = identity.avatarUrl ? avatarSrc(identity.avatarUrl) : undefined;
  return `<header class="presence-header" data-bot-id="${esc(identity.id ?? '')}">
    <a href="${esc(backHref)}" class="back presence-back" aria-label="Back">&larr;</a>
    <div class="presence-avatar" id="presence-avatar">${avatar({
      seed: identity.avatarSeed ?? identity.id,
      name,
      src,
      size: 56,
      status: tone,
    })}${face ? faceControl(identity.id ?? '', { hasAvatar: Boolean(identity.avatarUrl) }) : ''}</div>
    <div class="presence-body">
      <div class="presence-title">
        <span class="presence-name">${esc(name)}</span>
        <span id="presence-badge">${badge(presence.posture ?? 'unknown', tone, { dot: true })}</span>
        ${identity.running ? '' : badge('stopped', 'muted')}
      </div>
      <div class="presence-now-row"><div class="presence-now presence-now-${esc(
        presence.tone ?? tone
      )}" id="presence-now">${esc(presence.nowLine ?? '…')}</div>${voice ? speakButton() : ''}</div>
      <div class="presence-meta text-dim" id="presence-meta">${esc(meta)}</div>
      <div class="presence-why" id="presence-why">${whyPanel(presence.postureWhy, {
        nowMs,
        botId: identity.id,
      })}</div>
    </div>
    <div class="presence-actions">${actions}</div>
  </header>`;
}

/** True when an activity event concerns this bot's presence. */
export function isPresenceEvent(event, botId) {
  if (!event || event.botId !== botId || typeof event.type !== 'string') return false;
  return (
    event.type.startsWith('agent:') || event.type.startsWith('tool:') || event.type === 'llm:start'
  );
}

/** Update a rendered header in place from a `/presence` payload. No-op without a DOM. */
export function applyPresence(root, presence, identity = {}, nowMs = Date.now()) {
  if (!root || typeof root.querySelector !== 'function' || !presence) return false;
  const tone = postureTone(presence.posture);
  const now = root.querySelector('#presence-now');
  if (now) {
    now.textContent = presence.nowLine ?? '…';
    now.className = `presence-now presence-now-${presence.tone ?? tone}`;
  }
  const b = root.querySelector('#presence-badge');
  if (b) b.innerHTML = badge(presence.posture ?? 'unknown', tone, { dot: true });
  const dot = root.querySelector('.ui-avatar-dot');
  if (dot) dot.className = `ui-avatar-dot ui-avatar-dot-${tone}`;
  const meta = root.querySelector('#presence-meta');
  if (meta) meta.textContent = presenceMeta(identity, presence, nowMs);
  const why = root.querySelector('#presence-why');
  if (why && presence.postureWhy) {
    const html = whyPanel(presence.postureWhy, { nowMs, botId: identity.id });
    if (why.innerHTML !== html) {
      const wasOpen = Boolean(why.querySelector('details')?.open);
      why.innerHTML = html;
      const fold = why.querySelector('details');
      if (wasOpen && fold) fold.open = true;
    }
  }
  return true;
}

// ── Agent Home page pieces (session S2) ─────────────────────────────────────

export const TIMELINE_KIND_TONE = {
  llm: 'accent',
  tool: 'info',
  production: 'ok',
  ask: 'warn',
  cycle: 'muted',
  karma: 'accent',
};

export const TIMELINE_KIND_LABEL = {
  llm: 'LLM',
  tool: 'tool',
  production: 'output',
  ask: 'ask',
  cycle: 'cycle',
  karma: 'karma',
};

/** Hour bucket label for a timeline item: "Today 14:00", "Yesterday 09:00", "Mon 12 · 08:00". */
export function hourLabel(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Unknown time';
  const d = new Date(t);
  const now = new Date(nowMs);
  const hh = `${String(d.getHours()).padStart(2, '0')}:00`;
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, now)) return `Today ${hh}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${hh}`;
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  return `${day} · ${hh}`;
}

/** Group newest-first timeline items into hour buckets, preserving order. */
export function groupTimelineByHour(items, nowMs = Date.now()) {
  const groups = [];
  let cur = null;
  for (const it of Array.isArray(items) ? items : []) {
    const label = hourLabel(it.ts, nowMs);
    if (!cur || cur.label !== label) {
      cur = { label, items: [] };
      groups.push(cur);
    }
    cur.items.push(it);
  }
  return groups;
}

function timeOfDay(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One timeline row. */
export function timelineRow(item) {
  const kind = TIMELINE_KIND_LABEL[item.kind] ? item.kind : 'cycle';
  const tone = item.ok === false ? 'danger' : TIMELINE_KIND_TONE[kind];
  const status = item.ok === false ? ' home-tl-failed' : '';
  return `<div class="home-tl-row${status}">
    <span class="home-tl-time">${esc(timeOfDay(item.ts))}</span>
    ${badge(TIMELINE_KIND_LABEL[kind], tone)}
    <span class="home-tl-title">${esc(item.title ?? '')}</span>
    ${item.detail ? `<span class="home-tl-detail text-dim">${esc(item.detail)}</span>` : ''}
  </div>`;
}

/**
 * Newest-first timeline items as entries: a cycle (`{ cycleId, ts, head, items }`,
 * `head` = its row from the cycle log or null) placed where its newest row is,
 * holding every row of that cycle; rows without a cycle stay loose (`{ ts, item }`).
 */
export function groupTimelineByCycle(items) {
  const entries = [];
  const byCycle = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it?.cycleId) {
      entries.push({ ts: it?.ts, item: it });
      continue;
    }
    let g = byCycle.get(it.cycleId);
    if (!g) {
      g = { cycleId: it.cycleId, ts: it.ts, head: null, items: [] };
      byCycle.set(it.cycleId, g);
      entries.push(g);
    }
    if (it.kind === 'cycle' && !g.head) g.head = it;
    else g.items.push(it);
  }
  return entries;
}

/** One cycle group: its header row, the cycle's Why, then its rows. */
function cycleGroup(g, nowMs) {
  const head = g.head
    ? timelineRow(g.head)
    : timelineRow({ ts: g.ts, kind: 'cycle', title: 'Cycle with no record yet', ok: null });
  const why = g.head?.why ? whyPanel(g.head.why, { nowMs }) : '';
  const rows = g.items.length
    ? `<div class="home-tl-cycle-rows">${g.items.map(timelineRow).join('')}</div>`
    : '';
  return `<div class="home-tl-cycle">${head}${why}${rows}</div>`;
}

/** Whole timeline body (grouped by hour, rows of one cycle together) or an empty state. */
export function timelineBody(items, nowMs = Date.now()) {
  const groups = groupTimelineByHour(groupTimelineByCycle(items), nowMs);
  if (groups.length === 0) {
    return emptyState({
      icon: '◷',
      title: 'Nothing happened yet',
      hint: 'LLM calls, tool runs, outputs, questions and karma changes will show up here as they happen.',
    });
  }
  return groups
    .map(
      (g) => `<div class="home-tl-group">
      <div class="home-tl-group-label">${esc(g.label)}</div>
      ${g.items.map((e) => (e.cycleId ? cycleGroup(e, nowMs) : timelineRow(e.item))).join('')}
    </div>`
    )
    .join('');
}

const GOAL_MOVES = [
  ['pending', 'To do'],
  ['in_progress', 'In progress'],
  ['blocked', 'Blocked'],
  ['done', 'Done'],
];

/** Task lanes, the same four as the goal columns. */
const TASK_LANES = [
  ['todo', 'To do'],
  ['in_progress', 'In progress'],
  ['blocked', 'Blocked'],
  ['done', 'Done'],
];
const TASK_LANE_IDS = TASK_LANES.map(([v]) => v);

function moveValue(status) {
  const s = String(status ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (s === 'completed' || s === 'done') return 'done';
  if (s === 'blocked') return 'blocked';
  if (['in_progress', 'active', 'doing', 'started', 'ongoing'].includes(s)) return 'in_progress';
  return 'pending';
}

/** A task's lane, falling back to its checkbox for tasks written before lanes. */
function taskLane(t) {
  return TASK_LANE_IDS.includes(t?.status) ? t.status : t?.done ? 'done' : 'todo';
}

/** One colour per goal, stable across redraws (hash of its id, or its text). */
const GOAL_COLORS = ['#7c9cff', '#f0a35e', '#c084fc', '#34d399', '#f472b6', '#67e8f9', '#facc15'];
function goalColor(g) {
  const key = String(g?.id || g?.text || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return GOAL_COLORS[h % GOAL_COLORS.length];
}

const YOU_BADGE = '<span class="home-goal-you" title="You set this">you</span>';
const AGENT_BADGE = '<span class="home-goal-agent" title="The agent set this">✦ agent</span>';

/** Who set a goal: you (dashboard), the agent (any of its own writers), or nobody shown. */
function goalBadge(g) {
  const source = String(g?.source ?? '');
  if (/^operator\b/i.test(source)) return YOU_BADGE;
  if (/^(agent|strategist|curiosity|reflection)\b/i.test(source)) return AGENT_BADGE;
  return '';
}

function taskBadge(t) {
  if (t?.by === 'agent') return AGENT_BADGE;
  return YOU_BADGE;
}

function priorityChip(g) {
  const p = String(g?.priority || 'medium');
  return `<span class="home-goal-pri pri-${esc(p)}">${esc(p)}</span>`;
}

/** Segmented bar (done, in progress, blocked, to do) plus "d/t tasks done · n blocked". */
function taskBar(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return '<div class="home-task-tally">No tasks yet</div>';
  const order = ['done', 'in_progress', 'blocked', 'todo'];
  const segs = [...list]
    .sort((a, b) => order.indexOf(taskLane(a)) - order.indexOf(taskLane(b)))
    .map((t) => `<span class="home-task-seg seg-${taskLane(t)}"></span>`)
    .join('');
  const done = list.filter((t) => taskLane(t) === 'done').length;
  const blocked = list.filter((t) => taskLane(t) === 'blocked').length;
  return `<div class="home-task-bar" aria-hidden="true">${segs}</div>
    <div class="home-task-tally">${done}/${list.length} tasks done${blocked ? ` · <span class="home-task-blocked">${blocked} blocked</span>` : ''}</div>`;
}

function goalCard(g, selected) {
  const text = String(g.text || '(untitled)');
  const title = String(g.headline || text);
  return `<div class="home-goal-card${selected ? ' is-selected' : ''}" role="button" tabindex="0" aria-expanded="${selected}" data-goal="${esc(text)}" data-goal-id="${esc(g.id ?? '')}" style="--goal-color:${goalColor(g)}" aria-label="Show the tasks of this goal" draggable="true">
    <div class="home-goal-text">${esc(title)}</div>
    <div class="home-goal-meta">${priorityChip(g)}${goalBadge(g)}</div>
    ${taskBar(g.tasks)}
  </div>`;
}

function taskCard(t, botId) {
  const lane = taskLane(t);
  const cycle =
    t.cycleId && botId
      ? `<button type="button" class="home-task-cycle" data-open-cycle="${esc(t.cycleId)}" data-bot-id="${esc(botId)}" title="Open the cycle that made this task">cycle</button>`
      : '';
  return `<div class="home-task-card${lane === 'done' ? ' is-done' : ''}" draggable="true" data-task-id="${esc(t.id ?? '')}">
    <div class="home-task-text">${esc(String(t.text ?? ''))}</div>
    <div class="home-task-meta">${taskBadge(t)}${cycle}</div>
  </div>`;
}

/** The selected goal's tasks: header, then the four lanes lined up under the goal columns. */
function goalTasksPanel(g, column, botId, addingTask) {
  const text = String(g.text || '(untitled)');
  const tasks = Array.isArray(g.tasks) ? g.tasks : [];
  const status = moveValue(column);
  const allDone =
    tasks.length > 0 && status !== 'done' && tasks.every((t) => taskLane(t) === 'done');
  const options = GOAL_MOVES.map(
    ([v, label]) => `<option value="${v}"${v === status ? ' selected' : ''}>${label}</option>`
  ).join('');
  const lanes = TASK_LANES.map(([lane, label]) => {
    const list = tasks.filter((t) => taskLane(t) === lane);
    const add =
      lane !== 'todo'
        ? ''
        : addingTask
          ? `<form class="home-task-form" data-task-form><input class="home-goal-input" name="text" maxlength="200" placeholder="New task…" autocomplete="off" required><button class="btn btn-sm btn-primary" type="submit">Add</button></form>`
          : '<button type="button" class="home-task-add" data-add-task>+ Add task</button>';
    return `<div class="home-task-lane" data-task-status="${lane}">
      <div class="home-board-head"><span class="home-board-dot dot-${lane === 'todo' ? 'pending' : lane}"></span>${label}<span class="home-board-count">${list.length}</span></div>
      ${add}${list.map((t) => taskCard(t, botId)).join('')}
    </div>`;
  }).join('');
  return `<section class="home-goal-panel" style="--goal-color:${goalColor(g)};--col:${GOAL_MOVES.findIndex(([v]) => v === status)}" data-panel-goal="${esc(text)}" data-panel-goal-id="${esc(g.id ?? '')}" aria-label="Tasks of this goal">
    <div class="home-goal-panel-head">
      <div class="home-goal-panel-main">
        <div class="home-goal-panel-title">${esc(text)}</div>
        <div class="home-goal-meta"><select class="home-goal-status status-${status}" data-goal="${esc(text)}" aria-label="Goal status">${options}</select>${priorityChip(g)}${goalBadge(g)}</div>
        ${g.notes ? `<div class="home-goal-notes">${esc(String(g.notes))}</div>` : ''}
        ${tasks.length ? taskBar(tasks) : ''}
        ${allDone ? '<div class="home-goal-alldone">All tasks done <button type="button" class="btn btn-sm" data-complete-goal>Mark goal done</button></div>' : ''}
      </div>
      <button type="button" class="btn btn-sm btn-ghost" data-goal-history>History</button>
      <button type="button" class="btn btn-sm btn-ghost home-goal-close" data-goal-close aria-label="Close tasks">✕</button>
    </div>
    <div class="home-task-lanes">${lanes}</div>
  </section>`;
}

/** Add-a-goal form at the bottom of the To do column; agent-home.js wires it by delegation. */
export function goalAddForm() {
  return `<form id="home-goal-form" class="home-goal-form">
    <input class="home-goal-input" name="title" maxlength="200" placeholder="Add a goal…" autocomplete="off" required>
    <div class="home-goal-form-row">
      <select class="home-goal-pri-select" name="priority" aria-label="Priority">
        <option value="low">low</option>
        <option value="medium" selected>medium</option>
        <option value="high">high</option>
      </select>
      <button class="btn btn-sm btn-primary" type="submit">Add</button>
    </div>
  </form>`;
}

/** POST body for /api/agents/:id/goals, or null when there is no title. */
export function goalFormPayload(title, priority) {
  const t = String(title ?? '').trim();
  if (!t) return null;
  return { title: t, priority: priority || 'medium' };
}

/** PATCH body for moving a goal on the board, or null when it cannot be sent. */
export function goalMovePayload(goal, status) {
  const g = String(goal ?? '').trim();
  if (!g || !GOAL_MOVES.some(([v]) => v === status)) return null;
  return { goal: g, status };
}

/** How a PATCH names a goal: its id when it has one, else its title. */
function goalRef(goal) {
  return goal?.id ? { id: goal.id } : { goal: String(goal?.text ?? '') };
}

function wireTasks(tasks) {
  return tasks.map((t) => ({ ...(t.id ? { id: t.id } : {}), text: t.text, status: taskLane(t) }));
}

/** PATCH body moving task `taskId` to `lane`, or null when nothing would change. */
export function taskMovePayload(goal, taskId, lane) {
  const tasks = Array.isArray(goal?.tasks) ? goal.tasks : [];
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !TASK_LANE_IDS.includes(lane) || taskLane(task) === lane) return null;
  return {
    ...goalRef(goal),
    tasks: wireTasks(tasks).map((t) => (t.id === taskId ? { ...t, status: lane } : t)),
  };
}

/** PATCH body adding one To do task (single line), or null when the text is empty. */
export function taskAddPayload(goal, text) {
  const clean = String(text ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
  if (!clean) return null;
  const tasks = Array.isArray(goal?.tasks) ? goal.tasks : [];
  return { ...goalRef(goal), tasks: [...wireTasks(tasks), { text: clean, status: 'todo' }] };
}

/** The four goal columns of a home payload, in board order. */
export function goalBuckets(goals) {
  const active = goals?.active ?? [];
  return [
    [
      'pending',
      'To do',
      goals?.todo ?? active.filter((g) => moveValue(g.status) === 'pending'),
      'Nothing queued',
    ],
    [
      'in_progress',
      'In progress',
      goals?.inProgress ?? active.filter((g) => moveValue(g.status) === 'in_progress'),
      'Nothing in progress',
    ],
    ['blocked', 'Blocked', goals?.blocked ?? [], 'Nothing blocked'],
    ['done', 'Done', goals?.completedRecently ?? [], 'Nothing finished recently'],
  ];
}

/** The goal a board selection names (by id, else by title), with its column. */
export function findBoardGoal(goals, ref) {
  if (!ref) return null;
  for (const [status, , list] of goalBuckets(goals)) {
    const goal = list.find((g) => (g.id && g.id === ref) || (!g.id && g.text === ref));
    if (goal) return { goal, status };
  }
  return null;
}

/**
 * Goals board: To do / In progress / Blocked / Done laid out row by row (row r
 * holds the r-th goal of each column), so the selected goal's tasks open as a
 * full-width row right under its own row. The add form sits at the bottom of To do.
 */
export function goalsColumns(goals, { selectedId, botId, addingTask = false } = {}) {
  const buckets = goalBuckets(goals);
  const total = buckets.reduce((n, [, , list]) => n + list.length, 0);
  const selected = findBoardGoal(goals, selectedId);
  const rows = Math.max(1, ...buckets.map(([, , list]) => list.length));
  let html = buckets
    .map(
      ([status, title, list]) =>
        `<div class="home-board-cell home-board-top" data-status="${status}"${list.length ? '' : ' data-empty'}><div class="home-board-head"><span class="home-board-dot dot-${status}"></span>${title}<span class="home-board-count">${list.length}</span></div></div>`
    )
    .join('');
  for (let r = 0; r < rows; r++) {
    for (const [status, , list, empty] of buckets) {
      const g = list[r];
      const body = g
        ? goalCard(g, selected?.goal === g)
        : r === 0
          ? `<div class="home-board-empty">${esc(empty)}</div>`
          : '';
      html += `<div class="home-board-cell" data-status="${status}">${body}</div>`;
    }
    if (selected && buckets.find(([s]) => s === selected.status)[2].indexOf(selected.goal) === r)
      html += goalTasksPanel(selected.goal, selected.status, botId, addingTask);
  }
  html += buckets
    .map(
      ([status]) =>
        `<div class="home-board-cell home-board-bottom" data-status="${status}">${status === 'pending' ? goalAddForm() : ''}</div>`
    )
    .join('');
  const intro =
    total === 0
      ? emptyState({
          icon: '◎',
          title: 'No goals yet',
          hint: 'Add one in To do: the agent works on goals you set before its own, and asks you if one is unclear.',
        })
      : '';
  return `${intro}<div class="home-board">${html}</div>`;
}

/** Radar axes from a traits record (0.1–0.9 values) — sorted by name for stability. */
export function traitAxes(current) {
  if (!current || typeof current !== 'object') return [];
  return Object.entries(current)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, v]) => ({ label, value: Number(v) }));
}

/** Score tone: >= 70 ok, >= 40 warn, else danger. */
export function karmaTone(score) {
  if (score == null || !Number.isFinite(Number(score))) return 'muted';
  const s = Number(score);
  return s >= 70 ? 'ok' : s >= 40 ? 'warn' : 'danger';
}

/** Chips for what the human owes the agent; '' when nothing is pending. */
export function needsYouStrip(needsYou, botId) {
  const n = needsYou ?? {};
  const id = encodeURIComponent(botId ?? '');
  const chips = [];
  if (n.asks > 0)
    chips.push(
      `<a class="home-need" href="#/needs/inbox">${n.asks} question${n.asks === 1 ? '' : 's'} to answer</a>`
    );
  if (n.permissions > 0)
    chips.push(
      `<a class="home-need" href="#/needs/permissions">${n.permissions} permission${n.permissions === 1 ? '' : 's'} to decide</a>`
    );
  if (n.productionsPending > 0)
    chips.push(
      `<a class="home-need" href="#/work/productions/${id}">${n.productionsPending} output${n.productionsPending === 1 ? '' : 's'} to review</a>`
    );
  if (chips.length === 0) return '';
  return `<div class="home-needs"><span class="home-needs-label">Needs you</span>${chips.join('')}</div>`;
}

/** Tab strip shared by Home and Config. */
export function homeTabs(botId, active) {
  const id = encodeURIComponent(botId ?? '');
  return tabs(
    [
      { id: 'home', label: 'Home', href: `#/agents/${id}` },
      { id: 'config', label: 'Config', href: `#/agents/${id}/config` },
      { id: 'stats', label: 'Stats', href: `#/insights/stats/bot/${id}` },
      { id: 'productions', label: 'Productions', href: `#/work/productions/${id}` },
      { id: 'conversations', label: 'Conversations', href: `#/work/conversations/${id}` },
    ],
    active
  );
}

/** "just now", "5m ago", "3h ago", "2d ago" — for timelines and event lists. */
export function ago(iso, nowMs = Date.now()) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, nowMs - t);
  if (diff < 60_000) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(diff / 3_600_000);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/**
 * Recent trait changes (newest first), each with who made it, when, and its
 * "Why this?" fold (`traitChangeToWhy`, built server-side). '' when none.
 */
export function traitChangesList(changes, { nowMs = Date.now(), botId } = {}) {
  if (!Array.isArray(changes) || changes.length === 0) return '';
  const items = changes
    .filter((c) => c?.why?.what)
    .map(
      (c) => `<li class="home-trait-change">
        <div class="home-trait-change-head"><span>${esc(c.why.what)}</span>
          <span class="text-dim text-sm">${esc(c.source ?? '')} · ${esc(ago(c.ts, nowMs))}</span></div>
        ${whyPanel(c.why, { nowMs, botId })}
      </li>`
    )
    .join('');
  if (!items) return '';
  return `<div class="home-trait-changes"><div class="text-dim text-sm">Recent changes</div><ul>${items}</ul></div>`;
}

/** Traits card body: radar when there are at least three traits, then the change history. */
export function traitsBody(traits, changes, opts = {}) {
  const axes = traitAxes(traits?.current);
  if (axes.length < 3) {
    return emptyState({
      icon: '◈',
      title: 'No trait registers yet',
      hint: 'TRAITS.json appears after the first strategist pass.',
    });
  }
  const adj = traits?.adjustments != null ? `${traits.adjustments} adjustments` : '';
  const drift = traits?.drift
    ? Object.entries(traits.drift)
        .filter(([, v]) => Math.abs(Number(v)) >= 0.05)
        .map(([k, v]) => `${k} ${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}`)
        .join(', ')
    : '';
  const note = [adj, drift ? `drift: ${drift}` : ''].filter(Boolean).join(' · ');
  return `<div class="home-traits-radar">${radar(axes, { size: 220 })}</div>
    <div class="text-dim text-sm" style="text-align:center;margin-top:6px">${esc(
      note || 'stable since baseline'
    )}</div>${traitChangesList(changes, opts)}`;
}

/** Karma card body: score tile, sparkline, last events. */
export function karmaBody(karma, nowMs = Date.now()) {
  const score = karma?.score ?? null;
  const tone = karmaTone(score);
  const history = (karma?.history ?? []).map((h) => h.score);
  const events = (karma?.recentEvents ?? []).slice(0, 6);
  const top = `<div class="home-karma-top">${kpi({
    label: 'Score',
    value: score ?? '--',
    delta: karma?.delta7d,
    tone,
    hint: karma?.trend ? `${karma.trend} · 7d` : '7d',
  })}${sparkline(history, { width: 180, height: 44, tone })}</div>`;
  if (events.length === 0) {
    return `${top}<div class="text-dim text-sm" style="margin-top:8px">No karma events yet. Approve an output or answer a question and it moves.</div>`;
  }
  return `${top}<div class="home-karma-events">${events
    .map(
      (e) => `<div class="home-karma-event">
        <span class="home-karma-delta" style="color:${e.delta >= 0 ? 'var(--ok)' : 'var(--danger)'}">${e.delta >= 0 ? '+' : ''}${Number(e.delta) || 0}</span>
        ${badge(e.source || 'karma', 'muted')}
        <span style="flex:1">${esc(e.reason)}</span>
        <span class="text-dim text-sm">${esc(ago(e.ts, nowMs))}</span>
      </div>`
    )
    .join('')}</div>`;
}

// ── Keyboard (UX overhaul phase 5) ──────────────────────────────────────────

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** True while focus is somewhere a key press means text. */
export function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return TYPING_TAGS.has(String(target.tagName ?? '').toUpperCase());
}

const HOME_KEYS = { r: 'run', e: 'edit', c: 'chat' };

/** Agent Home shortcuts: `r` Run now, `e` Edit, `c` focus chat. */
export function homeKeyAction(e) {
  if (!e || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(e.target)) return null;
  return HOME_KEYS[String(e.key ?? '')] ?? null;
}

/** Keys Agent Home binds, for the `?` help sheet (registerPageShortcuts). */
export const AGENT_HOME_SHORTCUTS = [
  ['r', 'Run now'],
  ['e', 'Edit'],
  ['c', 'Focus the chat'],
];
