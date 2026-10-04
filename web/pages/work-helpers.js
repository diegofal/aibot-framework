/**
 * Work → Outputs pieces (session S3.5 of docs/plans/jarvis-fleet-plan.md).
 *
 * The Work landing shows what the agents produced, newest first, with the
 * review verdict inline — not a file tree. Pure string helpers over the
 * `GET /api/productions/all-entries` shape (`ProductionEntry`); the page
 * (`work.js`) fetches, filters and posts the evaluations.
 */
import { avatar, badge, cx, emptyState, esc } from '../ui/index.js';
import { ago } from './agent-home-helpers.js';

export const WORK_STATUSES = [
  { id: 'all', label: 'All' },
  { id: 'unreviewed', label: 'To review' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
];

const ACTION_TONE = { create: 'ok', edit: 'info', delete: 'danger', archive: 'muted' };
const STATUS_TONE = { unreviewed: 'warn', approved: 'ok', rejected: 'danger', archived: 'muted' };

/** 'unreviewed' | 'approved' | 'rejected' | 'archived'. */
export function entryStatus(entry) {
  if (entry?.action === 'archive' || entry?.action === 'delete') return 'archived';
  const s = entry?.evaluation?.status;
  return s === 'approved' || s === 'rejected' ? s : 'unreviewed';
}

export function filterEntries(entries, { status = 'all', botId = '' } = {}) {
  return (entries ?? []).filter((e) => {
    if (botId && String(e?.botId) !== String(botId)) return false;
    if (status && status !== 'all' && entryStatus(e) !== status) return false;
    return true;
  });
}

/** Newest first. Never mutates. */
export function sortEntries(entries) {
  const ts = (e) => Date.parse(e?.timestamp) || 0;
  return [...(entries ?? [])]
    .map((e, i) => ({ e, i, t: ts(e) }))
    .sort((x, y) => y.t - x.t || x.i - y.i)
    .map((x) => x.e);
}

export function workSummary(entries) {
  const s = { total: 0, unreviewed: 0, approved: 0, rejected: 0, archived: 0 };
  for (const e of entries ?? []) {
    s.total++;
    s[entryStatus(e)]++;
  }
  return s;
}

export function entryTitle(entry) {
  const path = String(entry?.path ?? '');
  const base = path.split(/[\\/]/).filter(Boolean).pop();
  return base || path || String(entry?.id ?? '');
}

/** Opens the file inside the productions explorer. */
export function fileHref(entry) {
  return `#/work/productions?bot=${encodeURIComponent(String(entry?.botId ?? ''))}&file=${encodeURIComponent(
    String(entry?.path ?? '')
  )}`;
}

function stars(rating) {
  const n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  if (!n) return '';
  return `<span class="work-stars" title="${n} of 5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;
}

function verdict(entry) {
  const status = entryStatus(entry);
  if (status === 'unreviewed') {
    return `<span class="work-review">
      <button class="btn btn-sm work-approve" data-action="approve" data-id="${esc(entry.id)}" data-bot-id="${esc(
        entry.botId
      )}" title="Approve (a)">Approve</button>
      <button class="btn btn-sm work-reject" data-action="reject" data-id="${esc(entry.id)}" data-bot-id="${esc(
        entry.botId
      )}" title="Reject (x)">Reject</button>
    </span>`;
  }
  return `<span class="work-verdict">${badge(status, STATUS_TONE[status])}${stars(
    entry?.evaluation?.rating
  )}</span>`;
}

export function entryRow(
  entry,
  { names = {}, nowMs = Date.now(), avatarSrc = (u) => u, selected = false, focused = false } = {}
) {
  const botId = String(entry?.botId ?? '');
  const name = names[botId] ?? botId;
  const status = entryStatus(entry);
  const action = String(entry?.action ?? 'create');
  const face = entry?.avatarUrl ? avatarSrc(entry.avatarUrl) : undefined;
  const desc = String(entry?.description ?? '').trim();
  const cls = cx(
    'work-item',
    `work-item-${esc(status)}`,
    selected && 'is-selected',
    focused && 'is-focused'
  );
  return `<li class="${cls}" data-id="${esc(entry.id)}" data-bot-id="${esc(botId)}" data-key="${esc(
    entryKey(entry)
  )}">
    <label class="work-select" title="Select (space)"><input type="checkbox" data-select aria-label="Select ${esc(
      entryTitle(entry)
    )}"${selected ? ' checked' : ''}></label>
    <a class="work-agent" href="#/agents/${encodeURIComponent(botId)}" title="${esc(name)}">${avatar(
      {
        seed: botId,
        name,
        src: face,
        size: 32,
      }
    )}</a>
    <div class="work-main">
      <div class="work-title-row">
        <a class="work-title" href="${fileHref(entry)}">${esc(entryTitle(entry))}</a>
        ${badge(action, ACTION_TONE[action] ?? 'muted')}
        ${entry?.trackOnly ? badge('tracked', 'muted', { title: 'Tracked only; the file lives outside the productions dir' }) : ''}
      </div>
      <div class="work-sub text-dim">
        <a href="#/agents/${encodeURIComponent(botId)}">${esc(name)}</a>
        <span>·</span>
        <span title="${esc(entry?.timestamp ?? '')}">${esc(ago(entry?.timestamp, nowMs))}</span>
        ${desc ? `<span>·</span><span class="work-desc">${esc(desc)}</span>` : ''}
      </div>
    </div>
    ${verdict(entry)}
  </li>`;
}

export function entriesList(
  entries,
  {
    names = {},
    nowMs = Date.now(),
    avatarSrc,
    filtered = false,
    selected = null,
    focusKey = '',
  } = {}
) {
  const list = entries ?? [];
  if (list.length === 0) {
    return filtered
      ? emptyState({ icon: '⌕', title: 'Nothing matches', hint: 'Try another status or agent.' })
      : emptyState({
          icon: '◫',
          title: 'No outputs yet',
          hint: 'Files the agents create or edit will show up here for review.',
        });
  }
  return `<ul class="work-list">${list
    .map((e) => {
      const key = entryKey(e);
      return entryRow(e, {
        names,
        nowMs,
        avatarSrc,
        selected: !!selected?.has?.(key),
        focused: !!focusKey && key === focusKey,
      });
    })
    .join('')}</ul>`;
}

/** Status chips (with counts) + agent select. */
export function workFilters({ status = 'all', botId = '', agents = [], counts = {} } = {}) {
  const chips = WORK_STATUSES.map((s) => {
    const n = s.id === 'all' ? counts.total : counts[s.id];
    const count = n != null ? `<span class="work-chip-count">${Number(n) || 0}</span>` : '';
    return `<button type="button" class="work-chip" data-status="${s.id}" aria-pressed="${
      s.id === status ? 'true' : 'false'
    }">${esc(s.label)}${count}</button>`;
  }).join('');
  const options = agents
    .map(
      (a) =>
        `<option value="${esc(a.id)}"${String(a.id) === String(botId) ? ' selected' : ''}>${esc(
          a.name ?? a.id
        )}</option>`
    )
    .join('');
  return `<div class="work-filters">
    <div class="work-chips" role="group" aria-label="Filter by status">${chips}</div>
    <select id="work-filter-agent" class="cron-filter" aria-label="Filter by agent">
      <option value="">All agents</option>
      ${options}
    </select>
  </div>`;
}

// ── Keyboard, selection and bulk (UX overhaul) ──────────────────────────

/** Outputs keys. `r` is deliberately absent: it means "reply" in Needs You. */
export const WORK_KEYS = {
  j: 'next',
  ArrowDown: 'next',
  k: 'prev',
  ArrowUp: 'prev',
  a: 'approve',
  x: 'reject',
  Enter: 'open',
  o: 'open',
  ' ': 'toggle',
};

/** Dispatches keys: j/k move, + (or =) thumbs up, - thumbs down. */
export const DISPATCH_KEYS = {
  j: 'next',
  ArrowDown: 'next',
  k: 'prev',
  ArrowUp: 'prev',
  '+': 'up',
  '=': 'up',
  '-': 'down',
};

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const ACTIVATING_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);

/**
 * The page action for a keydown, or null when the page must not consume it:
 * typing in a field, a ctrl/meta/alt chord, or Enter/space on a control that
 * already activates on its own. Shift is allowed (`+` needs it).
 */
export function keyAction(e, keymap) {
  if (!e || !keymap) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const t = e.target ?? {};
  const tag = String(t.tagName ?? '').toUpperCase();
  if (TYPING_TAGS.has(tag) || t.isContentEditable) return null;
  if ((e.key === 'Enter' || e.key === ' ') && ACTIVATING_TAGS.has(tag)) return null;
  return Object.hasOwn(keymap, e.key) ? keymap[e.key] : null;
}

/** Next focus index, clamped to the list. Nothing focused + any move → first row. */
export function moveIndex(index, delta, length) {
  if (!length || length <= 0) return -1;
  if (index == null || index < 0) return 0;
  return Math.max(0, Math.min(length - 1, index + delta));
}

/** Selection key: entry ids are only unique per bot. */
export function entryKey(entry) {
  return `${String(entry?.botId ?? '')}\u0000${String(entry?.id ?? '')}`;
}

export function toggleKey(set, key) {
  const next = new Set(set ?? []);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Drop selected keys whose entry is no longer listed. */
export function pruneSelection(selected, entries) {
  const live = new Set((entries ?? []).map(entryKey));
  return new Set([...(selected ?? [])].filter((k) => live.has(k)));
}

/**
 * Entries a bulk action applies to. `selected = null` means every entry
 * given (the "approve all shown" path). approve/reject only touch
 * unreviewed entries; archive touches anything not already archived.
 */
export function bulkTargets(entries, selected, action) {
  const pick = (entries ?? []).filter((e) => !selected || selected.has(entryKey(e)));
  if (action === 'approve' || action === 'reject') {
    return pick.filter((e) => entryStatus(e) === 'unreviewed');
  }
  if (action === 'archive') return pick.filter((e) => entryStatus(e) !== 'archived');
  return [];
}

/**
 * Run `fn` over `items` one at a time (the per-item endpoints are not
 * built for a burst). A result with an `error` field or a throw is a failure.
 */
export async function runSequential(items, fn, onProgress) {
  const ok = [];
  const failed = [];
  const list = items ?? [];
  let done = 0;
  for (const item of list) {
    try {
      const res = await fn(item);
      if (res?.error) failed.push({ item, error: String(res.error) });
      else ok.push(item);
    } catch (err) {
      failed.push({ item, error: String(err?.message ?? err) });
    }
    done++;
    onProgress?.(done, list.length);
  }
  return { ok, failed };
}

/** One toast line for a finished bulk run. */
export function bulkSummary(verb, { ok = [], failed = [] } = {}) {
  if (failed.length === 0) return { text: `${verb} ${ok.length}`, tone: 'ok' };
  const text = `${verb} ${ok.length}, ${failed.length} failed (${failed[0].error})`;
  return { text, tone: ok.length === 0 ? 'danger' : 'warn' };
}

/**
 * Bulk bar over the list. With a selection: per-action counts. Without one
 * but with unreviewed entries in the current filter: "Approve all N shown".
 */
export function workBulkBar({
  selected = 0,
  approvable = 0,
  archivable = 0,
  filteredUnreviewed = 0,
} = {}) {
  if (selected > 0) {
    const dis = (n) => (n > 0 ? '' : ' disabled');
    return `<div class="work-bulk-bar" role="toolbar" aria-label="Bulk actions">
      <span class="work-bulk-count">${Number(selected)} selected</span>
      <button type="button" class="btn btn-sm work-approve" data-bulk="approve"${dis(approvable)}>Approve ${Number(approvable)}</button>
      <button type="button" class="btn btn-sm work-reject" data-bulk="reject"${dis(approvable)}>Reject ${Number(approvable)}</button>
      <button type="button" class="btn btn-sm" data-bulk="archive"${dis(archivable)}>Archive ${Number(archivable)}</button>
      <button type="button" class="btn btn-sm" data-bulk="clear">Clear selection</button>
    </div>`;
  }
  if (filteredUnreviewed > 0) {
    return `<div class="work-bulk-bar work-bulk-bar-idle">
      <span class="text-dim text-sm work-keys-hint">j/k move · a approve · x reject · space select · Enter open</span>
      <button type="button" class="btn btn-sm" data-bulk="approve-filtered">Approve all ${Number(
        filteredUnreviewed
      )} shown</button>
    </div>`;
  }
  return '';
}

export const DISPATCH_PAGE = 100;

/**
 * The `before` cursor for "Load more" from a `GET /api/curiosity/dispatches`
 * answer, or null when there is nothing older to ask for.
 */
export function nextDispatchCursor(res) {
  return res?.hasMore && res.nextBefore ? res.nextBefore : null;
}

/** Shown dispatches followed by an older page, minus any already shown (same bot and id). */
export function mergeDispatchPage(shown, page) {
  const seen = new Set(shown.map((d) => `${d.botId}\u0000${d.id}`));
  return [...shown, ...page.filter((d) => !seen.has(`${d.botId}\u0000${d.id}`))];
}

/** Keys Outputs binds, for the `?` help sheet (registerPageShortcuts). */
export const WORK_SHORTCUTS = [
  ['j / ↓', 'Next output'],
  ['k / ↑', 'Previous output'],
  ['a', 'Approve'],
  ['x', 'Reject'],
  ['Space', 'Select / unselect'],
  ['Enter / o', 'Open the file'],
  ['Esc', 'Clear the selection'],
];

/** Keys Dispatches binds, for the `?` help sheet (registerPageShortcuts). */
export const DISPATCH_SHORTCUTS = [
  ['j / ↓', 'Next dispatch'],
  ['k / ↑', 'Previous dispatch'],
  ['+ / =', 'Thumbs up'],
  ['-', 'Thumbs down'],
];
