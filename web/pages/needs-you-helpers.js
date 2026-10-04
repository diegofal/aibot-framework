/**
 * Needs You queue — pure helpers (session S5 of docs/plans/jarvis-fleet-plan.md).
 *
 * Everything here is a function of its arguments: the keyboard reducer, the
 * selection bookkeeping, the request builder and the markup. `needs-you.js`
 * owns the DOM and the network; `tests/web/needs-you-helpers.test.ts` covers
 * this file without either.
 *
 * Item shape (frozen by `src/web/routes/needs-you.ts`):
 *   { id, kind, botId, botName, title, body, options, createdAt, urgency,
 *     actions: [{ id, label, method, path, body?, input?, tone, hotkey? }],
 *     href, meta }
 */
import { avatar, badge, emptyState, esc } from '../ui/index.js';
import { ago } from './agent-home-helpers.js';

export const KIND_LABEL = {
  ask: 'Question',
  permission: 'Permission',
  proposal: 'Proposal',
  production: 'Review',
  feedback: 'Feedback',
  tool: 'Tool',
};

export const KIND_TONE = {
  ask: 'info',
  permission: 'warn',
  proposal: 'accent',
  production: 'muted',
  feedback: 'ok',
  tool: 'warn',
};

export const URGENCY_TONE = { high: 'danger', normal: 'warn', low: 'muted' };

/** Verb the action buttons and hints use per kind. */
const KIND_NOUN = {
  ask: ['question', 'questions'],
  permission: ['permission', 'permissions'],
  proposal: ['proposal', 'proposals'],
  production: ['output to review', 'outputs to review'],
  feedback: ['reply to read', 'replies to read'],
  tool: ['tool to approve', 'tools to approve'],
};

export const SHORTCUTS = [
  ['j / ↓', 'Next item'],
  ['k / ↑', 'Previous item'],
  ['a', 'Approve / answer — submits the reply box or the focused quick reply'],
  ['d', 'Deny / reject / dismiss (never deletes)'],
  ['r', 'Focus the reply box'],
  ['1 – 4', 'Focus a quick-reply chip (again to unfocus)'],
  ['x', 'Select / unselect the focused item'],
  ['Shift + j / k', 'Extend the selection down / up'],
  ['*', 'Select every visible item'],
  ['o', "Open the agent's Home"],
  ['Enter', 'Open the item where it lives'],
  ['Ctrl/⌘ + Enter', 'Submit while typing in the reply box'],
  ['Esc', 'Clear the selection / leave the reply box / unfocus the chip'],
  ['?', 'Show these shortcuts'],
];

const NONE = { type: 'none' };
const MAX_CHIPS = 4;
const DAY_MS = 86_400_000;

/** Kinds the server can bulk-approve (mirror of NEEDS_YOU_SUPPORTED_ACTIONS). */
export const APPROVABLE_KINDS = new Set(['production', 'tool']);

/**
 * Kinds with a neutral (no-karma) action — what Dismiss, group Clear and
 * clear-stale may touch. Tools are not here: rejecting code is a review, so
 * a tool needs an explicit reject (server: NEEDS_YOU_NEUTRAL_ACTION.tool = null,
 * CLEAR_STALE_DEFAULT_KINDS).
 */
export const NEUTRAL_KINDS = new Set(['ask', 'permission', 'proposal', 'production', 'feedback']);

/** Ids of `items` that have a neutral action, in order. */
export function neutralIds(items) {
  return (Array.isArray(items) ? items : []).filter((i) => NEUTRAL_KINDS.has(i?.kind)).map((i) => i.id);
}

/**
 * Exactly what "Clear stale" confirms and sends: neutral-kind items older than
 * `hours`, under the agent filter, minus rows hidden by a pending Undo.
 */
export function staleClearIds(items, { hours, botId = null, nowMs = Date.now(), hidden = [] } = {}) {
  const skip = new Set(hidden ?? []);
  const cutoff = nowMs - hours * 3_600_000;
  return (Array.isArray(items) ? items : [])
    .filter((i) => !skip.has(i.id))
    .filter((i) => NEUTRAL_KINDS.has(i.kind) && (!botId || i.botId === botId))
    .filter((i) => Date.parse(i.createdAt) < cutoff)
    .map((i) => i.id);
}

/**
 * Load generations: `begin()` before each GET, `accepts(token)` when it
 * returns, `invalidate()` when a bulk commit lands. A poll that started before
 * the commit would otherwise rebuild the list from pre-commit data after
 * pendingHide was emptied, and the cleared rows would flash back.
 */
export function createLoadGate() {
  let started = 0;
  let floor = 0;
  return {
    begin() {
      started += 1;
      return started;
    },
    invalidate() {
      floor = started;
    },
    accepts(token) {
      return token > floor && token === started;
    },
  };
}

export const AGE_GROUPS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'older', label: 'Older' },
];

// ─── age groups ───

/** `today` (< 24 h), `week` (< 7 d) or `older`; unparseable dates are `older`. */
export function ageGroupOf(createdAt, nowMs = Date.now()) {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 'older';
  const age = nowMs - t;
  if (age < DAY_MS) return 'today';
  if (age < 7 * DAY_MS) return 'week';
  return 'older';
}

/** `[{ id, label, items }]` in Today → This week → Older order; server order inside a group. */
export function groupItems(items, nowMs = Date.now()) {
  const list = Array.isArray(items) ? items : [];
  return AGE_GROUPS.map((g) => ({
    ...g,
    items: list.filter((i) => ageGroupOf(i.createdAt, nowMs) === g.id),
  })).filter((g) => g.items.length > 0);
}

// ─── state ───

const NO_FILTER = { kind: null, botId: null };

function nowOf(state) {
  return Number.isFinite(state?.nowMs) ? state.nowMs : Date.now();
}

function matchesFilter(item, filter) {
  if (filter?.kind && item.kind !== filter.kind) return false;
  if (filter?.botId && item.botId !== filter.botId) return false;
  return true;
}

/** What the list shows: filtered, not optimistically hidden, in display (age group) order. */
export function visibleItems(state) {
  if (!state || !Array.isArray(state.items)) return [];
  const hidden = new Set(state.hidden ?? []);
  const shown = state.items.filter((i) => !hidden.has(i.id) && matchesFilter(i, state.filter));
  return groupItems(shown, nowOf(state)).flatMap((g) => g.items);
}

/** Keep the selection when it is still visible, else the first visible item. */
function reselect(state, preferId = state.selectedId) {
  const visible = visibleItems(state);
  const keep = preferId && visible.some((i) => i.id === preferId);
  return { ...state, selectedId: keep ? preferId : (visible[0]?.id ?? null) };
}

/**
 * `{ items, selectedId, chipIndex, help, filter, checked, hidden, nowMs }`.
 * Keeps `prevSelectedId` when it still exists; `carry` brings the filter, the
 * selection set and the optimistically hidden ids across a reload (ids that
 * vanished are dropped).
 */
export function initialState(items, prevSelectedId = null, carry = {}) {
  const list = Array.isArray(items) ? items.filter((i) => i && typeof i.id === 'string') : [];
  const known = new Set(list.map((i) => i.id));
  const state = {
    items: list,
    selectedId: null,
    chipIndex: -1,
    help: false,
    filter: { ...NO_FILTER, ...(carry.filter ?? {}) },
    checked: (carry.checked ?? []).filter((id) => known.has(id)),
    hidden: (carry.hidden ?? []).filter((id) => known.has(id)),
    nowMs: Number.isFinite(carry.nowMs) ? carry.nowMs : Date.now(),
  };
  return reselect(state, prevSelectedId);
}

export function selectedItem(state) {
  if (!state?.selectedId) return null;
  return state.items.find((i) => i.id === state.selectedId) ?? null;
}

/** Move the selection by `delta` through the visible list, clamped; chip focus resets. */
export function moveSelection(state, delta) {
  const visible = visibleItems(state);
  if (visible.length === 0) return { ...state, selectedId: null, chipIndex: -1 };
  const current = visible.findIndex((i) => i.id === state.selectedId);
  const next = Math.max(0, Math.min(visible.length - 1, (current < 0 ? 0 : current) + delta));
  return { ...state, selectedId: visible[next].id, chipIndex: -1 };
}

/** The visible item that takes `id`'s slot when it disappears (the previous one when it was last). */
function successor(state, goneIds) {
  const visible = visibleItems(state);
  const gone = new Set(goneIds);
  const index = visible.findIndex((i) => i.id === state.selectedId);
  const rest = visible.filter((i) => !gone.has(i.id));
  if (rest.length === 0) return null;
  const before = visible.slice(0, Math.max(0, index)).filter((i) => !gone.has(i.id)).length;
  return rest[Math.min(before, rest.length - 1)].id;
}

/**
 * Drop `id` from the list. When it was selected, the item that slides into
 * its slot becomes selected (the previous one when it was last).
 */
export function removeItem(state, id) {
  if (!state.items.some((i) => i.id === id)) return state;
  const items = state.items.filter((i) => i.id !== id);
  const checked = (state.checked ?? []).filter((c) => c !== id);
  if (state.selectedId !== id) return { ...state, items, checked };
  const next = successor(state, [id]);
  return { ...state, items, checked, selectedId: next, chipIndex: -1 };
}

/** Narrow by `{ kind?, botId? }` (null clears); the selection set keeps only visible ids. */
export function setFilter(state, patch = {}) {
  const filter = { ...NO_FILTER, ...(state.filter ?? {}), ...patch };
  const next = { ...state, filter, chipIndex: -1 };
  const visible = new Set(visibleItems(next).map((i) => i.id));
  return reselect({ ...next, checked: (state.checked ?? []).filter((id) => visible.has(id)) });
}

/** Optimistically hide rows (pending bulk action); the selection moves on. */
export function hideItems(state, ids) {
  const add = (ids ?? []).filter((id) => state.items.some((i) => i.id === id));
  if (add.length === 0) return state;
  const hidden = [...new Set([...(state.hidden ?? []), ...add])];
  const gone = new Set(add);
  const selectedGone = gone.has(state.selectedId);
  const next = successor(state, add);
  return {
    ...state,
    hidden,
    checked: (state.checked ?? []).filter((id) => !gone.has(id)),
    selectedId: selectedGone ? next : state.selectedId,
    chipIndex: selectedGone ? -1 : state.chipIndex,
  };
}

/** Undo of `hideItems`. */
export function unhideItems(state, ids) {
  const drop = new Set(ids ?? []);
  const next = { ...state, hidden: (state.hidden ?? []).filter((id) => !drop.has(id)) };
  return next.selectedId ? next : reselect(next);
}

export function toggleChecked(state, id) {
  const checked = state.checked ?? [];
  return {
    ...state,
    checked: checked.includes(id) ? checked.filter((c) => c !== id) : [...checked, id],
  };
}

function addChecked(state, ids) {
  return { ...state, checked: [...new Set([...(state.checked ?? []), ...ids])] };
}

export function checkAllVisible(state) {
  return addChecked(state, visibleItems(state).map((i) => i.id));
}

export function clearChecked(state) {
  return { ...state, checked: [] };
}

/** Counts for the filter chips: per kind under the agent filter, hidden rows excluded. */
export function kindCounts(state) {
  const counts = { all: 0, ask: 0, permission: 0, proposal: 0, production: 0, feedback: 0, tool: 0 };
  const hidden = new Set(state?.hidden ?? []);
  for (const item of state?.items ?? []) {
    if (hidden.has(item.id)) continue;
    if (state.filter?.botId && item.botId !== state.filter.botId) continue;
    counts.all += 1;
    if (item.kind in counts) counts[item.kind] += 1;
  }
  return counts;
}

// ─── bulk ───

/** What the bulk bar can do with `ids`: `{ ids, count, neutralIds, productionIds, canApprove }`. */
export function bulkPlan(items, ids) {
  const byId = new Map((Array.isArray(items) ? items : []).map((i) => [i.id, i]));
  const picked = (ids ?? []).map((id) => byId.get(id)).filter(Boolean);
  return {
    ids: picked.map((i) => i.id),
    count: picked.length,
    neutralIds: neutralIds(picked),
    productionIds: picked.filter((i) => i.kind === 'production').map((i) => i.id),
    canApprove: picked.length > 0 && picked.every((i) => APPROVABLE_KINDS.has(i.kind)),
  };
}

/** `{ ok, failed, failedIds, text }` from `POST /api/needs-you/bulk` results. */
export function summarizeBulk(results, verb) {
  const list = Array.isArray(results) ? results : [];
  const ok = list.filter((r) => r?.ok).length;
  const failedIds = list.filter((r) => r && !r.ok).map((r) => r.id);
  const failed = failedIds.length;
  return {
    ok,
    failed,
    failedIds,
    text: failed > 0 ? `${verb} ${ok} · ${failed} failed` : `${verb} ${ok}`,
  };
}

// ─── actions ───

export function actionByHotkey(item, hotkey) {
  if (!item || !Array.isArray(item.actions)) return null;
  return item.actions.find((a) => a && a.hotkey === hotkey) ?? null;
}

function inputAction(item) {
  if (!item || !Array.isArray(item.actions)) return null;
  return item.actions.find((a) => a?.input) ?? null;
}

/** `{ path, method, body? }` for `api()`, or `{ error }` when a required reply is missing. */
export function buildRequest(action, text) {
  if (!action) return { error: 'No action' };
  if (action.method === 'DELETE') return { path: action.path, method: 'DELETE' };
  const body = { ...(action.body ?? {}) };
  if (action.input) {
    const t = String(text ?? '').trim();
    if (t) body[action.input.field] = t;
    else if (action.input.required) return { error: 'A reply is required' };
  }
  return { path: action.path, method: action.method, body };
}

function fire(state, action, item, ctx) {
  if (!action) return { state, effect: NONE };
  const chip =
    state.chipIndex >= 0 && Array.isArray(item.options) ? item.options[state.chipIndex] : undefined;
  const typed = String(ctx.replyText ?? '').trim();
  // The chip is the last thing the user pointed at; a stale draft does not beat it.
  const text = chip !== undefined && action.input ? chip : typed;
  if (action.input?.required && !text) return { state, effect: { type: 'focusReply' } };
  return { state, effect: { type: 'act', action, text: action.input ? text : '' } };
}

/**
 * Keyboard reducer. `ctx`: `{ inInput, mod, replyText }` — whether the event
 * came from the reply box, whether Ctrl/⌘ was held, and the box's text.
 * Returns `{ state, effect }`; effects are `none`, `act { action, text }`,
 * `focusReply`, `blurReply`, `open { href }` and `help`.
 */
export function reduceKey(state, key, ctx = {}) {
  const item = selectedItem(state);

  if (ctx.inInput) {
    if (key === 'Escape') return { state, effect: { type: 'blurReply' } };
    if (key === 'Enter' && ctx.mod && item) {
      const action = actionByHotkey(item, 'a');
      const typed = String(ctx.replyText ?? '').trim();
      if (!action || !typed) return { state, effect: NONE };
      return { state, effect: { type: 'act', action, text: typed } };
    }
    return { state, effect: NONE };
  }

  if (key === '?') return { state: { ...state, help: !state.help }, effect: { type: 'help' } };
  if (!item) return { state, effect: NONE };

  switch (key) {
    case 'j':
    case 'ArrowDown':
      return { state: moveSelection(state, 1), effect: NONE };
    case 'k':
    case 'ArrowUp':
      return { state: moveSelection(state, -1), effect: NONE };
    case 'a':
      return fire(state, actionByHotkey(item, 'a'), item, ctx);
    case 'd':
      return fire(state, actionByHotkey(item, 'd'), item, ctx);
    case 'r':
      return inputAction(item)
        ? { state, effect: { type: 'focusReply' } }
        : { state, effect: NONE };
    case 'o':
      return {
        state,
        effect: { type: 'open', href: `#/agents/${encodeURIComponent(item.botId)}` },
      };
    case 'Enter':
      return item.href
        ? { state, effect: { type: 'open', href: item.href } }
        : { state, effect: NONE };
    case 'x':
      return { state: toggleChecked(state, item.id), effect: NONE };
    case 'J':
    case 'K': {
      const moved = moveSelection(state, key === 'J' ? 1 : -1);
      return { state: addChecked(moved, [item.id, moved.selectedId]), effect: NONE };
    }
    case '*':
      return { state: checkAllVisible(state), effect: NONE };
    case 'Escape':
      if ((state.checked ?? []).length > 0) return { state: clearChecked(state), effect: NONE };
      return { state: { ...state, chipIndex: -1, help: false }, effect: NONE };
    default:
      break;
  }

  if (/^[1-4]$/.test(key)) {
    const idx = Number(key) - 1;
    const options = Array.isArray(item.options) ? item.options : [];
    if (idx >= options.length) return { state, effect: NONE };
    return { state: { ...state, chipIndex: state.chipIndex === idx ? -1 : idx }, effect: NONE };
  }
  return { state, effect: NONE };
}

// ─── markup ───

function kindBadge(kind) {
  return badge(KIND_LABEL[kind] ?? kind, KIND_TONE[kind] ?? 'muted', { class: 'needs-kind' });
}

function urgencyBadge(urgency) {
  if (urgency !== 'high') return '';
  return badge('urgent', 'danger', { dot: true, class: 'needs-urgency' });
}

export function listRow(item, selected, nowMs = Date.now(), checked = false) {
  const cls = selected ? 'needs-row selected' : 'needs-row';
  const wrap = checked ? 'needs-row-wrap checked' : 'needs-row-wrap';
  return `<div class="${wrap}">
  <input type="checkbox" class="needs-check" data-check-id="${esc(item.id)}" aria-label="Select ${esc(
    item.title
  )}"${checked ? ' checked' : ''}>
  <button type="button" class="${cls}" data-item-id="${esc(item.id)}" role="option" aria-selected="${
    selected ? 'true' : 'false'
  }">
    <span class="needs-row-avatar">${avatar({ seed: item.botId, name: item.botName, size: 28 })}</span>
    <span class="needs-row-main">
      <span class="needs-row-top"><span class="needs-row-bot">${esc(item.botName)}</span>${kindBadge(
        item.kind
      )}${urgencyBadge(item.urgency)}</span>
      <span class="needs-row-title">${esc(item.title)}</span>
    </span>
    <span class="needs-row-time text-dim">${esc(ago(item.createdAt, nowMs))}</span>
  </button>
  </div>`;
}

/**
 * Rows under Today / This week / Older headers. Each header carries a
 * "Clear N" button (`data-clear-group`) that applies the neutral action to
 * exactly that group's visible non-tool rows (N counts only those; no button
 * when the group holds only tools); `checked` marks the selection set.
 */
export function listBody(items, selectedId, nowMs = Date.now(), checked = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return emptyState({
      icon: '✓',
      title: 'Nothing needs you',
      hint: 'Questions, permissions, proposals, unreviewed outputs, tools and feedback replies land here.',
    });
  }
  const marked = new Set(checked ?? []);
  return groupItems(items, nowMs)
    .map((g) => {
      const clearable = neutralIds(g.items).length;
      const clear =
        clearable > 0
          ? `<button type="button" class="btn btn-sm needs-group-clear" data-clear-group="${
              g.id
            }" title="Dismiss / deny / archive every item in this group (nothing is approved; tools are left for an explicit review)">Clear ${clearable}</button>`
          : '';
      return `<div class="needs-group" data-group="${g.id}">
  <div class="needs-group-head"><span class="needs-group-label">${esc(g.label)}</span><span class="text-dim">${
    g.items.length
  }</span>${clear}</div>
  ${g.items.map((i) => listRow(i, i.id === selectedId, nowMs, marked.has(i.id))).join('')}
</div>`;
    })
    .join('');
}

/** Kind chips (with counts, zero kinds hidden) and an agent select. */
export function filterBar(state) {
  const counts = kindCounts(state);
  const active = state?.filter?.kind ?? null;
  const chip = (kind, label, n) =>
    `<button type="button" class="needs-filter-chip${
      (active ?? '') === kind ? ' active' : ''
    }" data-filter-kind="${esc(kind)}" aria-pressed="${(active ?? '') === kind ? 'true' : 'false'}">${esc(
      label
    )} <span class="needs-filter-n">${n}</span></button>`;
  const chips = [chip('', 'All', counts.all)];
  for (const kind of Object.keys(KIND_LABEL)) {
    if (counts[kind] > 0 || active === kind) chips.push(chip(kind, KIND_LABEL[kind], counts[kind]));
  }
  const bots = new Map();
  for (const item of state?.items ?? []) {
    if (!bots.has(item.botId)) bots.set(item.botId, item.botName || item.botId);
  }
  const selectedBot = state?.filter?.botId ?? '';
  // A pre-applied agent (#/needs?bot=) with nothing waiting still shows as selected.
  if (selectedBot && !bots.has(selectedBot)) bots.set(selectedBot, selectedBot);
  const options = [...bots.entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .map(
      ([id, name]) =>
        `<option value="${esc(id)}"${id === selectedBot ? ' selected' : ''}>${esc(name)}</option>`
    )
    .join('');
  return `<div class="needs-filters" role="group" aria-label="Filter the queue">
  <div class="needs-filter-chips">${chips.join('')}</div>
  <select class="needs-filter-agent" id="needs-filter-agent" data-page-filter aria-label="Filter by agent"><option value="">All agents</option>${options}</select>
</div>`;
}

/** The bar shown while the selection set is non-empty; '' otherwise. */
export function bulkBar(plan) {
  if (!plan || plan.count === 0) return '';
  const n = plan.count;
  const archive =
    plan.productionIds.length > 0
      ? `<button type="button" class="btn btn-sm" data-bulk="archive" title="Archive the selected outputs without a review (no karma)">Archive ${plan.productionIds.length}</button>`
      : '';
  const approve = plan.canApprove
    ? `<button type="button" class="btn btn-sm btn-primary" data-bulk="approve">Approve ${n}</button>`
    : '';
  const nNeutral = (plan.neutralIds ?? []).length;
  const dismiss =
    nNeutral > 0
      ? `<button type="button" class="btn btn-sm" data-bulk="neutral" title="Questions dismissed, permissions denied, proposals rejected, outputs archived — nothing approved; tools are skipped (reject them explicitly)">Dismiss ${nNeutral}</button>`
      : '';
  return `<div class="needs-bulk-bar" role="toolbar" aria-label="Bulk actions">
  <span class="needs-bulk-count">${n} selected</span>
  ${dismiss}
  ${archive}${approve}
  <button type="button" class="btn btn-sm needs-bulk-clear" data-bulk="clear">Clear selection <kbd>Esc</kbd></button>
</div>`;
}

export function chipBar(options, chipIndex) {
  if (!Array.isArray(options) || options.length === 0) return '';
  return `<div class="needs-chips" role="group" aria-label="Quick replies">${options
    .slice(0, MAX_CHIPS)
    .map(
      (o, i) =>
        `<button type="button" class="${i === chipIndex ? 'needs-chip focus' : 'needs-chip'}" data-chip="${i}"><kbd>${
          i + 1
        }</kbd>${esc(o)}</button>`
    )
    .join('')}</div>`;
}

function actionButton(action) {
  const cls =
    action.tone === 'ok' ? 'btn btn-primary' : action.tone === 'danger' ? 'btn btn-danger' : 'btn';
  const key = action.hotkey ? ` <kbd>${esc(action.hotkey)}</kbd>` : '';
  return `<button type="button" class="${cls} needs-action" data-action="${esc(action.id)}">${esc(
    action.label
  )}${key}</button>`;
}

function fileChips(meta) {
  const files = Array.isArray(meta?.files) ? meta.files : [];
  if (files.length === 0) return '';
  return `<div class="needs-files">${files
    .map((f) => `<span class="needs-file">${esc(f)}</span>`)
    .join('')}</div>`;
}

export function detailPanel(item, state = {}, nowMs = Date.now()) {
  if (!item) {
    return `<div class="needs-detail-empty text-dim">Select an item — <kbd>j</kbd> / <kbd>k</kbd> move, <kbd>?</kbd> for all shortcuts.</div>`;
  }
  const input = inputAction(item);
  const chips = chipBar(item.options, state.chipIndex ?? -1);
  const reply = input
    ? `<textarea id="needs-reply" class="needs-reply" rows="3" placeholder="${esc(
        input.input.placeholder ?? ''
      )}" aria-label="Reply"></textarea>`
    : '';
  const actions = (item.actions ?? []).map(actionButton).join('');
  const agentHref = `#/agents/${encodeURIComponent(item.botId)}`;
  return `<div class="needs-detail-head">
      ${avatar({ seed: item.botId, name: item.botName, size: 40 })}
      <div class="needs-detail-who">
        <a class="needs-detail-bot" href="${esc(agentHref)}">${esc(item.botName)}</a>
        <div class="needs-detail-meta">${kindBadge(item.kind)}${urgencyBadge(item.urgency)}<span class="text-dim">${esc(
          ago(item.createdAt, nowMs)
        )}</span></div>
      </div>
      <a class="btn btn-sm needs-detail-open" href="${esc(item.href)}">Open <kbd>↵</kbd></a>
    </div>
    <h2 class="needs-detail-title">${esc(item.title)}</h2>
    <div class="needs-detail-body">${esc(item.body)}</div>
    ${fileChips(item.meta)}
    ${chips}
    ${reply}
    <div class="needs-actions">${actions}</div>
    <div class="needs-hints text-dim"><kbd>o</kbd> agent home · <kbd>r</kbd> reply · <kbd>?</kbd> shortcuts</div>`;
}

export function shortcutsHelp() {
  return `<table class="needs-shortcuts">${SHORTCUTS.map(
    ([keys, what]) => `<tr><td><kbd>${esc(keys)}</kbd></td><td>${esc(what)}</td></tr>`
  ).join('')}</table>`;
}

/** "2 questions · 1 permission · 3 outputs to review", or "All clear". */
export function queueSummary(byKind) {
  const parts = [];
  for (const kind of Object.keys(KIND_NOUN)) {
    const n = Number(byKind?.[kind]) || 0;
    if (n > 0) parts.push(`${n} ${KIND_NOUN[kind][n === 1 ? 0 : 1]}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'All clear';
}
