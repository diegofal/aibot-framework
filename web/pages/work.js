/**
 * Work → Outputs (session S3.5 of docs/plans/jarvis-fleet-plan.md; keys and
 * bulk from docs/plans/ux-overhaul-plan.md).
 *
 * The Work landing: every file the agents created or edited, newest first,
 * with the review verdict inline. Approve/Reject post the same
 * `POST /api/productions/:botId/:id/evaluate` the explorer uses, so karma and
 * the Needs You badge move exactly as before; Archive posts
 * `POST /api/productions/:botId/:id/archive`. Every verdict is deferred behind
 * an Undo toast (`undoable`) and bulk runs call the per-item endpoints one at
 * a time. Keys: j/k move, a approve, x reject, space select, Enter open, Esc
 * clears the selection. The file tree stays under the Productions tab.
 */
import { confirmDialog, showToast, skeleton, undoable } from '../ui/index.js';
import { syncSelectAll, toggleAll } from '../ui/select-all.js';
import { registerPageShortcuts } from '../ui/shortcuts.js';
import { authedAvatarSrc } from './agent-face.js';
import { prodRequest } from './productions-helpers.js';
import { api } from './shared.js';
import {
  WORK_KEYS,
  WORK_SHORTCUTS,
  bulkSummary,
  bulkTargets,
  entriesList,
  entryKey,
  entryStatus,
  entryTitle,
  fileHref,
  filterEntries,
  keyAction,
  moveIndex,
  pruneSelection,
  runSequential,
  sortEntries,
  toggleKey,
  workFilters,
  workSummary,
  workToolbar,
} from './work-helpers.js';

const ENTRIES_LIMIT = 200;
const VERB = { approve: 'Approved', reject: 'Rejected', archive: 'Archived' };

/** Filter survives navigation within the session so "To review" stays picked. */
const workFilter = { status: 'unreviewed', botId: '' };
/** Listeners sit on the page root / document, which outlive this page: abort them on leave. */
let listeners = null;

export function destroyWork() {
  listeners?.abort();
  listeners = null;
}

/** Local copy of an entry after `action` (optimistic; undo restores the original). */
function applyLocal(entry, action) {
  if (action === 'archive') return { ...entry, action: 'archive' };
  const status = action === 'approve' ? 'approved' : 'rejected';
  return { ...entry, evaluation: { ...entry.evaluation, status } };
}

export async function renderWork(el) {
  registerPageShortcuts(WORK_SHORTCUTS);
  destroyWork();
  listeners = new AbortController();
  const { signal } = listeners;
  el.innerHTML = `<div class="page-title">Work</div>${skeleton({ lines: 6 })}`;

  const [entriesRes, agentsRes] = await Promise.all([
    api(`/api/productions/all-entries?limit=${ENTRIES_LIMIT}`).catch(() => null),
    api('/api/agents').catch(() => []),
  ]);
  if (signal.aborted) return;
  const agents = Array.isArray(agentsRes) ? agentsRes : [];
  const names = Object.fromEntries(agents.map((a) => [a.id, a.name || a.id]));

  if (!entriesRes || entriesRes.error) {
    el.innerHTML = `
      <div class="page-title">Work</div>
      <p class="text-dim">Productions are not enabled. Set <code>productions.enabled: true</code> in config.</p>
    `;
    return;
  }

  let entries = sortEntries(Array.isArray(entriesRes.entries) ? entriesRes.entries : []);
  let selected = new Set();
  let focusKey = '';
  // Nothing to review yet: open on everything instead of an empty "To review".
  if (workFilter.status === 'unreviewed' && workSummary(entries).unreviewed === 0) {
    workFilter.status = 'all';
  }

  const visibleEntries = () => filterEntries(entries, workFilter);

  const draw = () => {
    const counts = workSummary(filterEntries(entries, { botId: workFilter.botId }));
    const visible = visibleEntries();
    selected = pruneSelection(selected, visible);
    if (focusKey && !visible.some((e) => entryKey(e) === focusKey)) focusKey = '';
    const filtered = visible.length !== entries.length;
    el.innerHTML = `
      <div class="flex-between mb-16 work-head">
        <div>
          <div class="page-title" style="margin-bottom:2px">Work <span class="count">${entries.length}</span></div>
          <div class="text-dim work-sub">${counts.unreviewed} to review · ${counts.approved} approved · ${counts.rejected} rejected</div>
        </div>
        <div class="work-head-actions">
          <a class="btn btn-sm" href="#/work/productions">Browse files</a>
          <a class="btn btn-sm btn-primary" href="#/needs">Needs You</a>
        </div>
      </div>
      ${workFilters({ ...workFilter, agents, counts })}
      <div class="work-toolbar">${workToolbar({
        visibleKeys: visible.map(entryKey),
        selected,
        approvable: bulkTargets(visible, selected, 'approve').length,
        archivable: bulkTargets(visible, selected, 'archive').length,
        filteredUnreviewed: bulkTargets(visible, null, 'approve').length,
      })}</div>
      <div id="work-list-wrap">${entriesList(visible, {
        names,
        nowMs: Date.now(),
        avatarSrc: authedAvatarSrc,
        filtered,
        selected,
        focusKey,
      })}</div>
    `;
    syncSelectAll(el);
  };

  /** Move the focus ring without a full redraw. */
  const paintFocus = (scroll = false) => {
    for (const li of el.querySelectorAll('.work-item')) {
      const on = li.dataset.key === focusKey;
      li.classList.toggle('is-focused', on);
      if (on && scroll) li.scrollIntoView?.({ block: 'nearest' });
    }
  };

  /**
   * Optimistically apply `action` to `targets`, then commit after the Undo
   * window by calling the per-item endpoint for each. Failures are rolled back.
   */
  const review = (targets, action) => {
    if (!targets.length) return;
    const originals = new Map(targets.map((t) => [entryKey(t), t]));
    const swap = (fn) => {
      entries = entries.map((e) => (originals.has(entryKey(e)) ? fn(e) : e));
    };
    swap((e) => applyLocal(e, action));
    for (const k of originals.keys()) selected.delete(k);
    draw();

    const label =
      targets.length === 1
        ? `${VERB[action]} ${entryTitle(targets[0])}`
        : `${VERB[action]} ${targets.length} outputs`;
    undoable(label, {
      tone: action === 'approve' ? 'ok' : action === 'reject' ? 'warn' : 'muted',
      commit: () =>
        runSequential(targets, (t) => {
          const req = prodRequest(action, { botId: t.botId, entryId: t.id });
          return api(req.url, { method: req.method, body: req.body });
        }),
      undo: () => {
        swap((e) => originals.get(entryKey(e)) ?? e);
        if (!signal.aborted) draw();
      },
    })
      .then(({ undone, result }) => {
        if (undone) return;
        window.dispatchEvent(new CustomEvent('badges:refresh'));
        if (result.failed.length) {
          const bad = new Set(result.failed.map((f) => entryKey(f.item)));
          entries = entries.map((e) => (bad.has(entryKey(e)) ? originals.get(entryKey(e)) : e));
          if (!signal.aborted) draw();
        }
        if (result.failed.length || targets.length > 1) {
          const s = bulkSummary(VERB[action], result);
          showToast(s.text, { tone: s.tone });
        }
      })
      .catch((err) => showToast(`Could not ${action}: ${err?.message ?? err}`, { tone: 'danger' }));
  };

  const entryFor = (key) => entries.find((e) => entryKey(e) === key);

  draw();

  el.addEventListener(
    'click',
    async (e) => {
      const chip = e.target.closest('.work-chip[data-status]');
      if (chip) {
        workFilter.status = chip.dataset.status;
        draw();
        return;
      }
      const bulk = e.target.closest('button[data-bulk]');
      if (bulk) {
        const kind = bulk.dataset.bulk;
        const visible = visibleEntries();
        if (kind === 'clear') {
          selected = new Set();
          draw();
        } else if (kind === 'approve-filtered') {
          const targets = bulkTargets(visible, null, 'approve');
          const ok = await confirmDialog({
            title: 'Approve all shown',
            message: `Approve ${targets.length} output${targets.length === 1 ? '' : 's'} in the current filter? Each agent earns karma for its approved work.`,
            confirmLabel: `Approve ${targets.length}`,
            tone: 'primary',
          });
          if (ok) review(targets, 'approve');
        } else {
          review(bulkTargets(visible, selected, kind), kind);
        }
        return;
      }
      if (e.target.closest('[data-select]')) return; // handled on change
      const btn = e.target.closest('button[data-action]');
      if (btn) {
        const action = btn.dataset.action;
        if (action !== 'approve' && action !== 'reject') return;
        const entry = entries.find(
          (en) => en.id === btn.dataset.id && en.botId === btn.dataset.botId
        );
        if (entry) review([entry], action);
        return;
      }
      const li = e.target.closest('.work-item');
      if (li && !e.target.closest('a')) {
        focusKey = li.dataset.key;
        paintFocus();
      }
    },
    { signal }
  );

  el.addEventListener(
    'change',
    (e) => {
      if (e.target.id === 'work-select-all') {
        selected = toggleAll(visibleEntries().map(entryKey), selected);
        draw();
        return;
      }
      if (e.target.matches?.('[data-select]')) {
        const key = e.target.closest('.work-item')?.dataset.key;
        if (key) {
          selected = toggleKey(selected, key);
          focusKey = key;
          draw();
        }
        return;
      }
      if (e.target.id !== 'work-filter-agent') return;
      workFilter.botId = e.target.value;
      draw();
    },
    { signal }
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (!el.querySelector('#work-list-wrap')) {
        destroyWork();
        return;
      }
      if (document.getElementById('ui-dialog-root')) return;
      if (e.key === 'Escape' && selected.size && !e.target?.closest?.('input, textarea, select')) {
        e.preventDefault();
        selected = new Set();
        draw();
        return;
      }
      const action = keyAction(e, WORK_KEYS);
      if (!action) return;
      const visible = visibleEntries();
      if (!visible.length) return;
      const idx = visible.findIndex((en) => entryKey(en) === focusKey);
      if (action === 'next' || action === 'prev') {
        e.preventDefault();
        focusKey = entryKey(visible[moveIndex(idx, action === 'next' ? 1 : -1, visible.length)]);
        paintFocus(true);
        return;
      }
      const entry = focusKey ? entryFor(focusKey) : null;
      if (!entry) return;
      e.preventDefault();
      if (action === 'open') {
        location.hash = fileHref(entry);
      } else if (action === 'toggle') {
        selected = toggleKey(selected, focusKey);
        draw();
      } else if (
        (action === 'approve' || action === 'reject') &&
        entryStatus(entry) === 'unreviewed'
      ) {
        // Keep the reader's place: focus moves to the row that takes this one's slot.
        const next = visible[idx + 1] ?? visible[idx - 1];
        review([entry], action);
        if (!visibleEntries().some((en) => entryKey(en) === focusKey) && next) {
          focusKey = entryKey(next);
          paintFocus(true);
        }
      }
    },
    { signal }
  );
}
