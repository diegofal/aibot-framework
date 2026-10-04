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
};

export const KIND_TONE = {
  ask: 'info',
  permission: 'warn',
  proposal: 'accent',
  production: 'muted',
  feedback: 'ok',
};

export const URGENCY_TONE = { high: 'danger', normal: 'warn', low: 'muted' };

/** Verb the action buttons and hints use per kind. */
const KIND_NOUN = {
  ask: ['question', 'questions'],
  permission: ['permission', 'permissions'],
  proposal: ['proposal', 'proposals'],
  production: ['output to review', 'outputs to review'],
  feedback: ['reply to read', 'replies to read'],
};

export const SHORTCUTS = [
  ['j / ↓', 'Next item'],
  ['k / ↑', 'Previous item'],
  ['a', 'Approve / answer — submits the reply box or the focused quick reply'],
  ['d', 'Deny / reject / dismiss'],
  ['r', 'Focus the reply box'],
  ['1 – 4', 'Focus a quick-reply chip (again to unfocus)'],
  ['o', "Open the agent's Home"],
  ['Enter', 'Open the item where it lives'],
  ['Ctrl/⌘ + Enter', 'Submit while typing in the reply box'],
  ['Esc', 'Leave the reply box / unfocus the chip'],
  ['?', 'Show these shortcuts'],
];

const NONE = { type: 'none' };
const MAX_CHIPS = 4;

// ─── state ───

/** `{ items, selectedId, chipIndex, help }`; keeps `prevSelectedId` when it still exists. */
export function initialState(items, prevSelectedId = null) {
  const list = Array.isArray(items) ? items.filter((i) => i && typeof i.id === 'string') : [];
  const keep = prevSelectedId && list.some((i) => i.id === prevSelectedId);
  return {
    items: list,
    selectedId: keep ? prevSelectedId : list.length > 0 ? list[0].id : null,
    chipIndex: -1,
    help: false,
  };
}

export function selectedItem(state) {
  if (!state?.selectedId) return null;
  return state.items.find((i) => i.id === state.selectedId) ?? null;
}

function selectedIndex(state) {
  return state.items.findIndex((i) => i.id === state.selectedId);
}

/** Move the selection by `delta`, clamped to the list; chip focus resets. */
export function moveSelection(state, delta) {
  if (state.items.length === 0) return { ...state, selectedId: null, chipIndex: -1 };
  const current = selectedIndex(state);
  const next = Math.max(0, Math.min(state.items.length - 1, (current < 0 ? 0 : current) + delta));
  return { ...state, selectedId: state.items[next].id, chipIndex: -1 };
}

/**
 * Drop `id` from the list. When it was selected, the item that slides into
 * its slot becomes selected (the previous one when it was last).
 */
export function removeItem(state, id) {
  const index = state.items.findIndex((i) => i.id === id);
  if (index < 0) return state;
  const items = state.items.filter((i) => i.id !== id);
  if (state.selectedId !== id) return { ...state, items };
  const next = items[Math.min(index, items.length - 1)] ?? null;
  return { ...state, items, selectedId: next ? next.id : null, chipIndex: -1 };
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
    case 'Escape':
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

export function listRow(item, selected, nowMs = Date.now()) {
  const cls = selected ? 'needs-row selected' : 'needs-row';
  return `<button type="button" class="${cls}" data-item-id="${esc(item.id)}" role="option" aria-selected="${
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
  </button>`;
}

export function listBody(items, selectedId, nowMs = Date.now()) {
  if (!Array.isArray(items) || items.length === 0) {
    return emptyState({
      icon: '✓',
      title: 'Nothing needs you',
      hint: 'Questions, permissions, proposals, unreviewed outputs and feedback replies land here.',
    });
  }
  return items.map((i) => listRow(i, i.id === selectedId, nowMs)).join('');
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
