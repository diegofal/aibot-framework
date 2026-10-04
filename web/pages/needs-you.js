/**
 * Needs You — the one queue for everything the fleet is waiting on
 * (session S5 of docs/plans/jarvis-fleet-plan.md; clearable in Phase 1 of
 * docs/plans/ux-overhaul-plan.md).
 *
 * Data: `GET /api/needs-you` (see src/web/routes/needs-you.ts for the item
 * shape). Every item carries its own `actions[]`, so a single action sends
 * the request the item describes. Bulk work goes through
 * `POST /api/needs-you/bulk` and `POST /api/needs-you/clear-stale`, always
 * behind a deferred-commit Undo toast.
 *
 * Layout: filter bar, bulk bar, list grouped Today / This week / Older on the
 * left, detail on the right (stacked under 900px).
 * Keyboard: j/k move, a approve/answer, d deny/dismiss, r reply, o agent home,
 * 1-4 quick-reply chips, Enter open, x select, Shift+j/k extend, * select all,
 * Esc clear selection, ? shortcuts. The reducer in needs-you-helpers.js is
 * pure; this file only owns the DOM and the network.
 */
import {
  closeSheet,
  confirmDialog,
  openSheet,
  promptDialog,
  showToast,
  undoable,
} from '../ui/index.js';
import { syncSelectAll } from '../ui/select-all.js';
import { registerPageShortcuts } from '../ui/shortcuts.js';
import {
  SHORTCUTS,
  ageGroupOf,
  buildRequest,
  bulkPlan,
  clearChecked,
  createLoadGate,
  detailPanel,
  filterBar,
  hideItems,
  initialState,
  listBody,
  listToolbar,
  neutralIds,
  queueSummary,
  reduceKey,
  removeItem,
  selectedItem,
  setFilter,
  shortcutsHelp,
  staleClearIds,
  summarizeBulk,
  toggleAllVisible,
  toggleChecked,
  unhideItems,
  visibleItems,
} from './needs-you-helpers.js';
import { api, escapeHtml } from './shared.js';

const POLL_MS = 15_000;
/** After an action the server may have follow-up state (bot reply, evaluation); re-read once. */
const SETTLE_MS = 1_500;
const DEFAULT_STALE_HOURS = 72;

let root = null;
let state = null;
let byKind = {};
let pollTimer = null;
let keyHandler = null;
let busy = false;
/** Ids hidden by bulk actions still inside their Undo window; survives reloads. */
const pendingHide = new Set();
/** Drops GET responses from loads started before the latest bulk commit (rows would flash back). */
const loadGate = createLoadGate();

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
  if (count) count.textContent = String(visibleItems({ ...state, filter: {} }).length);
  const summary = root?.querySelector('#needs-summary');
  if (summary) summary.textContent = queueSummary(byKind);
}

function redrawFilters() {
  const bar = root?.querySelector('#needs-filters');
  if (bar) bar.innerHTML = filterBar(state);
}

function redrawBulk() {
  const bar = root?.querySelector('#needs-toolbar');
  if (!bar) return;
  bar.innerHTML = listToolbar(state);
  syncSelectAll(bar);
}

function redrawList() {
  const list = root?.querySelector('#needs-list');
  if (!list) return;
  list.innerHTML = listBody(visibleItems(state), state.selectedId, Date.now(), state.checked);
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
  redrawFilters();
  redrawBulk();
  redrawList();
  redrawDetail();
}

function refreshBadges() {
  window.dispatchEvent(new CustomEvent('badges:refresh'));
}

async function load(prevSelectedId) {
  const token = loadGate.begin();
  const res = await api('/api/needs-you');
  if (!loadGate.accepts(token)) return { stale: true };
  if (!res || res.error || !Array.isArray(res.items)) {
    return { error: res?.error || 'Failed to load the queue' };
  }
  state = initialState(res.items, prevSelectedId, {
    nowMs: Date.now(),
    filter: state?.filter,
    checked: state?.checked,
    hidden: [...pendingHide],
  });
  byKind = res.byKind ?? {};
  return { ok: true };
}

async function refresh() {
  if (!root || busy) return;
  // Never yank the list out from under someone typing a reply.
  if (document.activeElement?.id === 'needs-reply' && replyText().trim()) return;
  const prev = state?.selectedId ?? null;
  const prevIds = (state?.items ?? []).map((i) => i.id).join('|');
  const r = await load(prev);
  if (!root || r.error || r.stale) return;
  const nextIds = state.items.map((i) => i.id).join('|');
  if (nextIds !== prevIds) redrawAll();
  else redrawHead();
}

/** What the old pages treated as success; a proposal that was created but whose soul failed still counts. */
function succeeded(res) {
  if (!res) return false;
  if (res.proposal) return true;
  if (res.ok === false) return false;
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
  if (action.confirm) {
    const yes = await confirmDialog({
      title: action.label,
      message: action.confirm,
      confirmLabel: action.label,
      tone: action.tone === 'danger' ? 'danger' : undefined,
    });
    if (!yes || !root) return;
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

// ─── bulk ───

function restore(ids) {
  for (const id of ids) pendingHide.delete(id);
  if (!state) return;
  state = unhideItems(state, ids);
  if (root) redrawAll();
}

/**
 * Hide `ids` now, commit `request()` after the Undo window, restore on undo
 * and restore whatever failed. `request` resolves to the server response.
 */
function deferred(ids, label, verb, request) {
  if (ids.length === 0) return;
  for (const id of ids) pendingHide.add(id);
  state = hideItems(state, ids);
  redrawAll();
  undoable(label, { commit: request, undo: () => restore(ids) })
    .then(({ undone, result }) => {
      if (undone) return;
      if (!result || result.error || !Array.isArray(result.results)) {
        restore(ids);
        showToast(result?.error || `${verb} failed`, { tone: 'danger' });
        return;
      }
      const sum = summarizeBulk(result.results, verb);
      // Any GET already in flight carries pre-commit rows; ignore it.
      loadGate.invalidate();
      for (const id of ids) pendingHide.delete(id);
      if (sum.failed > 0) {
        restore(sum.failedIds);
        const firstError = result.results.find((r) => !r.ok)?.error;
        showToast(`${sum.text}${firstError ? ` — ${firstError}` : ''}`, {
          tone: 'warn',
          duration: 6000,
        });
      } else {
        showToast(sum.text, { tone: 'ok' });
      }
      refreshBadges();
      setTimeout(refresh, SETTLE_MS);
    })
    .catch((err) => {
      restore(ids);
      showToast(err?.message || `${verb} failed`, { tone: 'danger' });
    });
}

function bulk(ids, action, verb) {
  const n = ids.length;
  deferred(ids, `${verb} ${n} item${n === 1 ? '' : 's'}…`, verb, () =>
    api('/api/needs-you/bulk', { method: 'POST', body: { ids, action } })
  );
}

function onBulkClick(kind) {
  if (!state) return;
  const plan = bulkPlan(state.items, state.checked);
  if (kind === 'clear') {
    state = clearChecked(state);
    redrawBulk();
    redrawList();
    return;
  }
  if (plan.count === 0) return;
  // Each button sends exactly the ids its count showed (tools have no neutral action).
  if (kind === 'approve') bulk(plan.approveIds, 'approve', 'Approved');
  else if (kind === 'reject') bulk(plan.rejectIds, 'reject', 'Rejected');
  else if (kind === 'neutral') bulk(plan.neutralIds, 'neutral', 'Dismissed');
  else if (kind === 'archive') bulk(plan.productionIds, 'archive', 'Archived');
  else if (kind === 'delete') confirmDelete(plan.toolIds);
}

async function confirmDelete(ids) {
  if (ids.length === 0) return;
  const n = ids.length;
  const ok = await confirmDialog({
    title: `Delete ${n} tool${n === 1 ? '' : 's'}`,
    message:
      'Their code is removed from disk and unloaded from every agent. This cannot be undone.',
    confirmLabel: `Delete ${n}`,
    tone: 'danger',
  });
  if (ok) bulk(ids, 'delete', 'Deleted');
}

function clearGroup(groupId) {
  if (!state) return;
  const ids = neutralIds(
    visibleItems(state).filter((i) => ageGroupOf(i.createdAt, Date.now()) === groupId)
  );
  bulk(ids, 'neutral', 'Cleared');
}

async function clearStale() {
  if (!state) return;
  const raw = await promptDialog({
    title: 'Clear stale items',
    message:
      'Older than how many hours? Questions are dismissed, permissions denied, proposals rejected, outputs archived (no karma) and feedback replies closed. Nothing is approved; pending tools are left alone.',
    defaultValue: String(DEFAULT_STALE_HOURS),
    placeholder: 'Hours',
    confirmLabel: 'Next',
    required: true,
  });
  if (raw === null || !root) return;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 1) {
    showToast('Enter a number of hours (1 or more)', { tone: 'warn' });
    return;
  }
  const botId = state.filter?.botId || null;
  const ids = staleClearIds(state.items, {
    hours,
    botId,
    nowMs: Date.now(),
    hidden: [...pendingHide],
  });
  if (ids.length === 0) {
    showToast(`Nothing older than ${hours} h`, { tone: 'muted' });
    return;
  }
  const scope = botId ? ` for ${state.items.find((i) => i.botId === botId)?.botName ?? botId}` : '';
  const ok = await confirmDialog({
    title: `Clear ${ids.length} stale item${ids.length === 1 ? '' : 's'}?`,
    message: `Everything older than ${hours} h${scope} gets its neutral action. You can undo for 5 seconds.`,
    confirmLabel: `Clear ${ids.length}`,
  });
  if (!ok || !root) return;
  // Send exactly the confirmed rows; the server re-checks age/kind but never widens the set.
  const body = { olderThanHours: hours, ids, ...(botId ? { botId } : {}) };
  deferred(ids, `Clearing ${ids.length} stale item${ids.length === 1 ? '' : 's'}…`, 'Cleared', () =>
    api('/api/needs-you/clear-stale', { method: 'POST', body })
  );
}

// ─── keyboard ───

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
  if (e.altKey || e.defaultPrevented) return;
  const target = e.target;
  const inReply = target?.id === 'needs-reply';
  const tag = target?.tagName;
  const inOtherInput =
    !inReply &&
    (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable);
  // Row checkboxes are inputs too, but keys on them belong to the queue.
  if (inOtherInput && !target?.classList?.contains('needs-check')) return;
  if ((e.ctrlKey || e.metaKey) && e.key !== 'Enter') return;
  // Dialogs and the shortcuts sheet own the keyboard while open.
  if (document.querySelector('.ui-dialog')) return;
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
  } else if (next.checked !== before.checked) {
    redrawList();
  } else if (next.chipIndex !== before.chipIndex) {
    redrawChips();
  }
  if (next.checked !== before.checked) redrawBulk();
  applyEffect(effect);
}

/**
 * `opts.bot` (from `#/needs?bot=<id>`, e.g. a fleet card's "N asks") pre-applies
 * the agent filter.
 */
export async function renderNeedsYou(el, { bot = null } = {}) {
  registerPageShortcuts(SHORTCUTS);
  destroyNeedsYou();
  root = el;
  el.innerHTML = '<div class="page-title">Needs You</div><p class="text-dim">Loading…</p>';

  let r = await load(null);
  if (r.stale) r = await load(null);
  if (!root) return;
  if (r.stale) r = { error: 'The queue changed while loading — refresh' };
  if (r.error) {
    el.innerHTML = `<div class="page-title">Needs You</div><p class="text-dim">Failed to load: ${escapeHtml(r.error)}</p>`;
    return;
  }
  if (bot) state = setFilter(state, { botId: bot });

  el.innerHTML = `
    <div class="needs-head">
      <div>
        <div class="page-title">Needs You <span class="count" id="needs-count">${state.items.length}</span></div>
        <div class="text-dim needs-summary" id="needs-summary">${escapeHtml(queueSummary(byKind))}</div>
      </div>
      <div class="needs-head-actions">
        <button type="button" class="btn btn-sm" id="needs-stale-btn" title="Neutral action on everything older than N hours">Clear stale…</button>
        <button type="button" class="btn btn-sm" id="needs-help-btn">Shortcuts <kbd>?</kbd></button>
      </div>
    </div>
    <div id="needs-filters"></div>
    <div class="needs-layout">
      <div class="needs-list-col">
        <div id="needs-toolbar"></div>
        <div class="needs-list" id="needs-list" role="listbox" aria-label="Everything waiting on you" aria-multiselectable="true"></div>
      </div>
      <section class="needs-detail" id="needs-detail" aria-live="polite"></section>
    </div>`;

  el.querySelector('#needs-list').addEventListener('click', (e) => {
    if (!state) return;
    const check = e.target.closest('.needs-check');
    if (check) {
      state = toggleChecked(state, check.dataset.checkId);
      redrawList();
      redrawBulk();
      return;
    }
    const clear = e.target.closest('[data-clear-group]');
    if (clear) {
      clearGroup(clear.dataset.clearGroup);
      return;
    }
    const row = e.target.closest('.needs-row');
    if (!row || row.dataset.itemId === state.selectedId) return;
    state = { ...state, selectedId: row.dataset.itemId, chipIndex: -1 };
    redrawList();
    redrawDetail();
  });
  el.querySelector('#needs-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter-kind]');
    if (!chip || !state) return;
    state = setFilter(state, { kind: chip.dataset.filterKind || null });
    redrawAll();
  });
  el.querySelector('#needs-filters').addEventListener('change', (e) => {
    if (e.target?.id !== 'needs-filter-agent' || !state) return;
    state = setFilter(state, { botId: e.target.value || null });
    redrawAll();
  });
  const toolbar = el.querySelector('#needs-toolbar');
  toolbar.addEventListener('change', (e) => {
    if (e.target?.id !== 'needs-select-all' || !state) return;
    state = toggleAllVisible(state);
    redrawList();
    redrawBulk();
  });
  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (btn) onBulkClick(btn.dataset.bulk);
  });
  el.querySelector('#needs-stale-btn').addEventListener('click', clearStale);
  el.querySelector('#needs-help-btn').addEventListener('click', () => {
    state = { ...state, help: !state.help };
    toggleHelp();
  });

  redrawAll();

  keyHandler = onKey;
  document.addEventListener('keydown', keyHandler);
  pollTimer = setInterval(refresh, POLL_MS);
}
