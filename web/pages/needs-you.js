/**
 * Needs You — the one queue for everything the fleet is waiting on
 * (session S5 of docs/plans/jarvis-fleet-plan.md).
 *
 * Data: `GET /api/needs-you` (see src/web/routes/needs-you.ts for the item
 * shape). Every item carries its own `actions[]`, so this page sends the
 * request the item describes and never learns the five underlying APIs.
 *
 * Layout: list on the left, detail on the right (stacked under 900px).
 * Keyboard: j/k move, a approve/answer, d deny/dismiss, r reply, o agent home,
 * 1-4 quick-reply chips, Enter open, ? shortcuts. The reducer in
 * needs-you-helpers.js is pure; this file only owns the DOM and the network.
 */
import { closeSheet, openSheet, showToast } from '../ui/index.js';
import {
  buildRequest,
  detailPanel,
  initialState,
  listBody,
  queueSummary,
  reduceKey,
  removeItem,
  selectedItem,
  shortcutsHelp,
} from './needs-you-helpers.js';
import { api, escapeHtml } from './shared.js';

const POLL_MS = 15_000;
/** After an action the server may have follow-up state (bot reply, evaluation); re-read once. */
const SETTLE_MS = 1_500;

let root = null;
let state = null;
let byKind = {};
let pollTimer = null;
let keyHandler = null;
let busy = false;

export function destroyNeedsYou() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = null;
  closeSheet();
  root = null;
  state = null;
  busy = false;
}

function replyBox() {
  return root?.querySelector('#needs-reply') ?? null;
}

function replyText() {
  return replyBox()?.value ?? '';
}

function focusReply() {
  const box = replyBox();
  if (!box) return;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

function redrawHead() {
  const count = root?.querySelector('#needs-count');
  if (count) count.textContent = String(state.items.length);
  const summary = root?.querySelector('#needs-summary');
  if (summary) summary.textContent = queueSummary(byKind);
}

function redrawList() {
  const list = root?.querySelector('#needs-list');
  if (!list) return;
  list.innerHTML = listBody(state.items, state.selectedId, Date.now());
  const selected = list.querySelector('.needs-row.selected');
  selected?.scrollIntoView?.({ block: 'nearest' });
}

function redrawChips() {
  for (const chip of root?.querySelectorAll('.needs-chip') ?? []) {
    chip.classList.toggle('focus', Number(chip.dataset.chip) === state.chipIndex);
  }
}

function redrawDetail() {
  const detail = root?.querySelector('#needs-detail');
  if (!detail) return;
  const item = selectedItem(state);
  const draft = replyText();
  detail.innerHTML = detailPanel(item, state, Date.now());
  if (!item) return;
  const box = replyBox();
  if (box && draft) box.value = draft;

  for (const btn of detail.querySelectorAll('.needs-action')) {
    btn.addEventListener('click', () => {
      const action = item.actions.find((a) => a.id === btn.dataset.action);
      if (action) runAction(action, replyText());
    });
  }
  // A click on a chip sends it (the way the Inbox page does); digits only focus it.
  for (const chip of detail.querySelectorAll('.needs-chip')) {
    chip.addEventListener('click', () => {
      const idx = Number(chip.dataset.chip);
      const action = item.actions.find((a) => a.hotkey === 'a');
      const text = item.options?.[idx];
      if (action && text !== undefined) runAction(action, text);
    });
  }
}

function redrawAll() {
  redrawHead();
  redrawList();
  redrawDetail();
}

function refreshBadges() {
  window.dispatchEvent(new CustomEvent('badges:refresh'));
}

async function load(prevSelectedId) {
  const res = await api('/api/needs-you');
  if (!res || res.error) return { error: res?.error || 'Failed to load the queue' };
  state = initialState(res.items, prevSelectedId);
  byKind = res.byKind ?? {};
  return { ok: true };
}

async function refresh() {
  if (!root || busy) return;
  // Never yank the list out from under someone typing a reply.
  if (document.activeElement?.id === 'needs-reply' && replyText().trim()) return;
  const prev = state?.selectedId ?? null;
  const prevCount = state?.items.length ?? 0;
  const prevIds = (state?.items ?? []).map((i) => i.id).join('|');
  const r = await load(prev);
  if (!root || r.error) return;
  const nextIds = state.items.map((i) => i.id).join('|');
  if (nextIds !== prevIds || state.items.length !== prevCount) redrawAll();
}

/** What the old pages treated as success; a proposal that was created but whose soul failed still counts. */
function succeeded(res) {
  if (!res) return false;
  if (res.proposal) return true;
  return !res.error;
}

async function runAction(action, text) {
  if (busy || !state) return;
  const item = selectedItem(state);
  if (!item) return;
  const req = buildRequest(action, text);
  if (req.error) {
    showToast(req.error, { tone: 'warn' });
    focusReply();
    return;
  }
  busy = true;
  for (const btn of root.querySelectorAll('.needs-action')) btn.disabled = true;
  let res;
  try {
    res = await api(
      req.path,
      req.method === 'DELETE' ? { method: 'DELETE' } : { method: req.method, body: req.body }
    );
  } catch (err) {
    res = { error: err?.message || 'Request failed' };
  }
  busy = false;
  if (!root) return;
  if (!succeeded(res)) {
    showToast(res?.error || `${action.label} failed`, { tone: 'danger' });
    redrawDetail();
    return;
  }
  if (res.proposal && res.error) {
    showToast(`Agent created, soul generation failed: ${res.error}`, {
      tone: 'warn',
      duration: 6000,
    });
  } else {
    showToast(`${action.label} · ${item.botName}`, {
      tone: action.tone === 'danger' ? 'warn' : action.tone === 'ok' ? 'ok' : 'muted',
    });
  }
  const box = replyBox();
  if (box) box.value = '';
  state = removeItem(state, item.id);
  byKind = { ...byKind, [item.kind]: Math.max(0, (Number(byKind[item.kind]) || 0) - 1) };
  redrawAll();
  refreshBadges();
  setTimeout(refresh, SETTLE_MS);
}

function toggleHelp() {
  if (state?.help) {
    openSheet({ title: 'Keyboard shortcuts', body: shortcutsHelp() });
  } else {
    closeSheet();
  }
}

function applyEffect(effect) {
  switch (effect.type) {
    case 'act':
      runAction(effect.action, effect.text);
      break;
    case 'focusReply':
      focusReply();
      break;
    case 'blurReply':
      replyBox()?.blur();
      break;
    case 'open':
      location.hash = effect.href;
      break;
    case 'help':
      toggleHelp();
      break;
    default:
      break;
  }
}

function onKey(e) {
  if (!state || !root) return;
  if (e.altKey) return;
  const target = e.target;
  const inReply = target?.id === 'needs-reply';
  const tag = target?.tagName;
  const inOtherInput =
    !inReply &&
    (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable);
  if (inOtherInput) return;
  if ((e.ctrlKey || e.metaKey) && e.key !== 'Enter') return;
  // The shortcuts sheet has its own Escape; let it close before we act on keys again.
  if (document.body.classList.contains('ui-sheet-open') && e.key !== '?') {
    if (e.key === 'Escape') state = { ...state, help: false };
    return;
  }
  const before = state;
  const { state: next, effect } = reduceKey(state, e.key, {
    inInput: inReply,
    mod: e.ctrlKey || e.metaKey,
    replyText: replyText(),
  });
  if (next === before && effect.type === 'none') return;
  e.preventDefault();
  state = next;
  if (next.selectedId !== before.selectedId) {
    const box = replyBox();
    if (box) box.value = '';
    redrawList();
    redrawDetail();
  } else if (next.chipIndex !== before.chipIndex) {
    redrawChips();
  }
  applyEffect(effect);
}

export async function renderNeedsYou(el) {
  destroyNeedsYou();
  root = el;
  el.innerHTML = '<div class="page-title">Needs You</div><p class="text-dim">Loading…</p>';

  const r = await load(null);
  if (!root) return;
  if (r.error) {
    el.innerHTML = `<div class="page-title">Needs You</div><p class="text-dim">Failed to load: ${escapeHtml(r.error)}</p>`;
    return;
  }

  el.innerHTML = `
    <div class="needs-head">
      <div>
        <div class="page-title">Needs You <span class="count" id="needs-count">${state.items.length}</span></div>
        <div class="text-dim needs-summary" id="needs-summary">${escapeHtml(queueSummary(byKind))}</div>
      </div>
      <div class="needs-head-actions">
        <button type="button" class="btn btn-sm" id="needs-help-btn">Shortcuts <kbd>?</kbd></button>
      </div>
    </div>
    <div class="needs-layout">
      <div class="needs-list" id="needs-list" role="listbox" aria-label="Everything waiting on you"></div>
      <section class="needs-detail" id="needs-detail" aria-live="polite"></section>
    </div>`;

  el.querySelector('#needs-list').addEventListener('click', (e) => {
    const row = e.target.closest('.needs-row');
    if (!row || !state) return;
    if (row.dataset.itemId === state.selectedId) return;
    state = { ...state, selectedId: row.dataset.itemId, chipIndex: -1 };
    redrawList();
    redrawDetail();
  });
  el.querySelector('#needs-help-btn').addEventListener('click', () => {
    state = { ...state, help: !state.help };
    toggleHelp();
  });

  redrawList();
  redrawDetail();

  keyHandler = onKey;
  document.addEventListener('keydown', keyHandler);
  pollTimer = setInterval(refresh, POLL_MS);
}
