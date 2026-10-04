/**
 * Work → Productions: the file explorer (all-bots view and per-bot view).
 *
 * Shared logic lives in `productions-helpers.js` (tree filtering, visible
 * items, range selection, request builders, bulk bar markup) and in the
 * module-level `mountFileViewer` / `runProdBulk` below, so the two views only
 * differ in how they build and key their tree. Review is one click (Approve /
 * Reject post at once; the optional note goes to the Discussion thread).
 * Archive and single-file delete are deferred behind an Undo toast.
 * The hash accepts `?file=` and the legacy `?path=` alias.
 */
import { confirmDialog, showToast, undoable } from '../ui/index.js';
import { syncSelectAll, toggleAll } from '../ui/select-all.js';
import {
  closeFullscreenViewer,
  copyTextToClipboard,
  downloadTextFile,
  flashButtonLabel,
  openFullscreenViewer,
} from './file-actions.js';
import {
  bulkPlan,
  collectVisibleItems,
  deleteLabel,
  matchesProductionFilters,
  prodHash,
  prodRequest,
  productionsBulkBar,
  rangeKeys,
  readFileParam,
  selKey,
} from './productions-helpers.js';
import { api, escapeHtml, renderContent, renderThread, timeAgo } from './shared.js';
import { bulkSummary, runSequential } from './work-helpers.js';

function attachFileActions(panel, { path, name, content }) {
  if (!panel) return;
  const copyBtn = panel.querySelector('#viewer-copy');
  const downloadBtn = panel.querySelector('#viewer-download');
  const fullscreenBtn = panel.querySelector('#viewer-fullscreen');
  const enabled = content != null;
  if (copyBtn) copyBtn.disabled = !enabled;
  if (downloadBtn) downloadBtn.disabled = !enabled;
  if (fullscreenBtn) fullscreenBtn.disabled = !enabled;
  if (!enabled) return;

  copyBtn?.addEventListener('click', async () => {
    const ok = await copyTextToClipboard(content);
    flashButtonLabel(copyBtn, ok ? 'Copied' : 'Failed');
  });
  downloadBtn?.addEventListener('click', () => {
    downloadTextFile(path || name, content);
  });
  fullscreenBtn?.addEventListener('click', () => {
    openFullscreenViewer({
      titleHtml: escapeHtml(path || name),
      bodyHtml: renderContent(content, name),
      path: path || name,
      content,
    });
  });
}

const call = (req) => api(req.url, { method: req.method, body: req.body });

// --- Shared context menu & multi-select helpers ---
let _activeContextMenu = null;

function dismissContextMenu() {
  if (_activeContextMenu) {
    _activeContextMenu.remove();
    _activeContextMenu = null;
  }
}

document.addEventListener('click', () => dismissContextMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') dismissContextMenu();
});

/**
 * Handle click for multi-select. Returns true if the click was consumed (shift/ctrl).
 * @param {MouseEvent} e
 * @param {{ botId: string, path: string, type: string }} item
 * @param {Set} selection - Set of selKey strings
 * @param {{ value: {botId,path,type}|null }} lastClicked - mutable ref
 * @param {() => Array} getVisibleItems - lazy getter for ordered visible items
 * @param {() => void} rerender - re-render tree to update visual state
 */
function handleMultiSelectClick(e, item, selection, lastClicked, getVisibleItems, rerender) {
  const key = selKey(item.botId, item.path);

  if (e.shiftKey && lastClicked.value) {
    const range = rangeKeys(
      getVisibleItems(),
      selKey(lastClicked.value.botId, lastClicked.value.path),
      key
    );
    if (range.length) {
      if (!e.ctrlKey && !e.metaKey) selection.clear();
      for (const k of range) selection.add(k);
    }
    rerender();
    return true;
  }

  if (e.ctrlKey || e.metaKey) {
    if (selection.has(key)) selection.delete(key);
    else selection.add(key);
    lastClicked.value = item;
    rerender();
    return true;
  }

  // Plain click — clear multi-selection, let normal handler proceed
  selection.clear();
  lastClicked.value = item;
  return false;
}

const TOAST_VERB = {
  approve: 'Approved',
  reject: 'Rejected',
  archive: 'Archived',
  delete: 'Deleted',
};

/**
 * Run a bulk action over selected tree items. Approve / reject / archive are
 * deferred behind an Undo toast; deleting folders or several items asks first
 * (the API has no undelete), a single file is deferred like the rest.
 */
async function runProdBulk(action, items, { reload }) {
  const { targets, skipped } = bulkPlan(items, action);
  if (!targets.length) {
    showToast(`Nothing to ${action}: none of the selected items is tracked in the changelog`, {
      tone: 'warn',
    });
    return;
  }
  const exec = (t) =>
    action === 'delete'
      ? call(prodRequest('delete', { botId: t.botId, path: t.path }))
      : call(prodRequest(action, { botId: t.botId, entryId: t.entryId }));
  const finish = (result) => {
    const s = bulkSummary(TOAST_VERB[action], result);
    const extra = skipped ? ` · ${skipped} skipped (not tracked)` : '';
    showToast(`${s.text}${extra}`, { tone: s.tone });
    window.dispatchEvent(new CustomEvent('badges:refresh'));
    reload();
  };

  const needsConfirm = action === 'delete' && (targets.length > 1 || targets[0].type === 'dir');
  if (needsConfirm) {
    const ok = await confirmDialog({
      title: 'Delete',
      message: `Delete ${deleteLabel(targets)}? This cannot be undone.`,
      confirmLabel: `Delete ${targets.length === 1 ? '' : targets.length}`.trim(),
      tone: 'danger',
    });
    if (!ok) return;
    finish(await runSequential(targets, exec));
    return;
  }
  const what = targets.length === 1 ? targets[0].path : `${targets.length} files`;
  undoable(`${TOAST_VERB[action]} ${what}`, {
    tone: action === 'approve' ? 'ok' : action === 'delete' ? 'danger' : 'muted',
    commit: () => runSequential(targets, exec),
  })
    .then(({ undone, result }) => {
      if (!undone) finish(result);
    })
    .catch((err) => showToast(`Could not ${action}: ${err?.message ?? err}`, { tone: 'danger' }));
}

/** Bulk bar wiring shared by both views. Returns the `update()` to call after each tree render. */
function wireBulkBar(wrap, { getSelectedItems, getVisibleItems, selection, rerender, reload }) {
  if (!wrap) return () => {};
  const visibleKeys = () =>
    getVisibleItems()
      .filter((v) => v.type === 'file')
      .map((v) => selKey(v.botId, v.path));
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-bulk]');
    if (!btn) return;
    const action = btn.dataset.bulk;
    if (action === 'clear') {
      selection.clear();
      rerender();
      return;
    }
    runProdBulk(action, getSelectedItems(), { reload });
  });
  wrap.addEventListener('change', (e) => {
    if (e.target.id !== 'prod-select-all') return;
    const next = toggleAll(visibleKeys(), selection);
    selection.clear();
    for (const k of next) selection.add(k);
    rerender();
  });
  return () => {
    const items = getSelectedItems();
    wrap.innerHTML = productionsBulkBar({
      visibleIds: visibleKeys(),
      selected: selection,
      tracked: bulkPlan(items, 'approve').targets.length,
    });
    syncSelectAll(wrap);
  };
}

/**
 * Show context menu for one or more selected items.
 * @param {MouseEvent} e
 * @param {{ items: Array<{botId,path,type}>, isTopLevel?: boolean, onDeleted: () => void }} opts
 */
function showTreeContextMenu(e, opts) {
  e.preventDefault();
  e.stopPropagation();
  dismissContextMenu();

  if (opts.isTopLevel) return;
  const items = opts.items.filter((i) => !i.isTopLevel);
  if (items.length === 0) return;

  const menu = document.createElement('div');
  menu.className = 'tree-context-menu';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  const count = items.length;
  const deleteItem = document.createElement('div');
  deleteItem.className = 'tree-context-menu-item danger';
  deleteItem.textContent = count > 1 ? `Delete ${count} items` : 'Delete';
  deleteItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    dismissContextMenu();
    runProdBulk('delete', items, { reload: opts.onDeleted });
  });

  menu.appendChild(deleteItem);
  document.body.appendChild(menu);
  _activeContextMenu = menu;

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight)
    menu.style.top = `${window.innerHeight - rect.height - 4}px`;
}

function statusBadge(entry) {
  if (!entry.evaluation?.status)
    return '<span class="badge eval-badge-unreviewed">Unreviewed</span>';
  if (entry.evaluation.status === 'approved')
    return '<span class="badge eval-badge-approved">Approved</span>';
  return '<span class="badge eval-badge-rejected">Rejected</span>';
}

function starsHtml(rating, interactive = false) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const cls = i <= (rating || 0) ? 'star-filled' : 'star-empty';
    html += `<span class="star ${cls}" data-star="${i}">${i <= (rating || 0) ? '★' : '☆'}</span>`;
  }
  return `<span class="star-rating${interactive ? ' star-interactive' : ''}">${html}</span>`;
}

function getHashParams() {
  const idx = location.hash.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(location.hash.slice(idx + 1)));
}

function findNodeInTree(nodes, targetPath, botId, parentKeys, getExpandKey) {
  for (const node of nodes || []) {
    if (node.type === 'dir') {
      const key = getExpandKey(node, botId);
      const found = findNodeInTree(
        node.children,
        targetPath,
        botId,
        [...parentKeys, key],
        getExpandKey
      );
      if (found) return found;
    } else if (node.path === targetPath) {
      return { node, botId, parentKeys };
    }
  }
  return null;
}

function treeDots(node) {
  let html = '';
  if (node.evaluation?.status === 'approved')
    html = '<span class="tree-dot tree-dot-approved"></span>';
  else if (node.evaluation?.status === 'rejected')
    html = '<span class="tree-dot tree-dot-rejected"></span>';
  else if (node.entryId) html = '<span class="tree-dot tree-dot-unreviewed"></span>';
  if (node.coherenceCheck) {
    html += node.coherenceCheck.coherent
      ? '<span class="tree-dot tree-dot-coherent" title="Coherent"></span>'
      : '<span class="tree-dot tree-dot-incoherent" title="Incoherent"></span>';
  }
  return html;
}

const TREE_PANEL_CONTROLS = `
  <input type="text" class="prod-tree-search" id="prod-tree-search" data-page-filter placeholder="Filter files...">
  <select id="prod-status-filter" class="log-agent-filter" style="width:100%;margin-bottom:8px">
    <option value="">All Status</option>
    <option value="approved">Approved</option>
    <option value="rejected">Rejected</option>
    <option value="unreviewed">Unreviewed</option>
    <option value="checked">Checked</option>
  </select>
  <div class="prod-tree-toolbar">
    <button class="btn btn-sm" id="prod-expand-all">Expand all</button>
    <button class="btn btn-sm" id="prod-collapse-all">Collapse all</button>
  </div>
  <div id="prod-bulk-wrap" class="prod-bulk-wrap"></div>
  <div class="text-dim prod-select-hint">Ctrl/Shift-click to select several</div>
  <div id="prod-tree-container"></div>`;

function coherenceBadgeHtml(r) {
  if (!r) return '';
  if (r.coherent) {
    const tip = r.explanation ? ` title="${escapeHtml(r.explanation)}"` : '';
    return `<span class="badge eval-badge-checked"${tip}>Checked</span>`;
  }
  return `<span class="badge eval-badge-rejected" title="${escapeHtml((r.issues || []).join('; '))}">Incoherent</span>`;
}

/**
 * The file viewer both views share.
 * ctx = { botId, node, botLabel? (all-bots view links the bot), onTreeChanged(), onRemoved(message) }
 */
async function mountFileViewer(panel, { botId, node, botLabel = '', onTreeChanged, onRemoved }) {
  if (!panel) return;
  panel.innerHTML = '<p class="text-dim">Loading...</p>';

  let content = null;
  let entry = null;
  if (node.entryId) {
    const data = await api(`/api/productions/${encodeURIComponent(botId)}/${node.entryId}`);
    if (!data.error) {
      content = data.content;
      entry = data.entry;
    }
  }
  if (content == null) {
    const data = await api(
      `/api/productions/${encodeURIComponent(botId)}/file-content?path=${encodeURIComponent(node.path)}`
    );
    if (!data.error) content = data.content;
  }

  let currentRating = entry?.evaluation?.rating || 0;
  let currentStatus = entry?.evaluation?.status || '';
  let threadGenerating = false;
  let threadErrorMsg = null;
  let coherenceResult = null;
  let coherencePolling = false;
  let busy = false;
  const VIEWER_MAX_POLLS = 90;
  const entryUrl = () => `/api/productions/${encodeURIComponent(botId)}/${entry.id}`;

  function updateCoherence(r) {
    const b = document.getElementById('viewer-coherence-badge');
    if (b) b.innerHTML = coherenceBadgeHtml(r);
    node.coherenceCheck = { coherent: r.coherent };
    onTreeChanged?.();
  }

  // Coherence check runs in the background (LLM-based, may need polling)
  function fetchCoherence() {
    if (!entry) return;
    api(`${entryUrl()}/coherence`).then((res) => {
      if (res.error) return;
      if (res.status !== 'checking') {
        coherenceResult = res;
        if (!node.coherenceCheck) updateCoherence(res);
        else {
          const b = document.getElementById('viewer-coherence-badge');
          if (b) b.innerHTML = coherenceBadgeHtml(res);
        }
        return;
      }
      const badge = document.getElementById('viewer-coherence-badge');
      if (badge) badge.innerHTML = '<span class="badge badge-disabled">Checking…</span>';
      if (coherencePolling) return;
      coherencePolling = true;
      const pollId = setInterval(() => {
        api(`${entryUrl()}/coherence`).then((r) => {
          if (r.status === 'checking') return;
          clearInterval(pollId);
          coherencePolling = false;
          if (r.status === 'error') {
            const b = document.getElementById('viewer-coherence-badge');
            if (b)
              b.innerHTML =
                '<span class="badge badge-disabled" title="Coherence check failed">Error</span>';
            return;
          }
          coherenceResult = r;
          updateCoherence(r);
        });
      }, 3000);
      _prodIntervals.push(pollId);
    });
  }
  fetchCoherence();

  async function evaluate(status, { quiet = false } = {}) {
    if (busy) return;
    busy = true;
    const note = document.getElementById('viewer-note')?.value?.trim() || '';
    for (const b of panel.querySelectorAll('.eval-controls button')) b.disabled = true;
    const res = await call(
      prodRequest(status === 'approved' ? 'approve' : 'reject', {
        botId,
        entryId: entry.id,
        rating: currentRating || undefined,
      })
    );
    busy = false;
    if (res?.error) {
      showToast(`Could not save: ${res.error}`, { tone: 'danger' });
      renderViewer();
      return;
    }
    currentStatus = status;
    entry.evaluation = {
      ...(entry.evaluation || {}),
      status,
      evaluatedAt: new Date().toISOString(),
    };
    if (currentRating) entry.evaluation.rating = currentRating;
    if (node.entryId) {
      node.evaluation = { status, rating: currentRating || undefined };
      onTreeChanged?.();
    }
    window.dispatchEvent(new CustomEvent('badges:refresh'));
    if (!quiet)
      showToast(status === 'approved' ? 'Approved' : 'Rejected', {
        tone: status === 'approved' ? 'ok' : 'warn',
      });
    renderViewer();
    if (note) sendThreadMessage(note);
  }

  function removeWith(action) {
    const isArchive = action === 'archive';
    const req = isArchive
      ? prodRequest('archive', { botId, entryId: entry.id })
      : prodRequest('delete-entry', { botId, entryId: entry.id });
    panel.innerHTML = `<div class="prod-empty-state">${isArchive ? 'Archiving' : 'Deleting'} ${escapeHtml(node.path)}…</div>`;
    undoable(`${isArchive ? 'Archived' : 'Deleted'} ${node.name || node.path}`, {
      tone: isArchive ? 'muted' : 'danger',
      commit: () => call(req),
      undo: () => {
        if (panel.isConnected) renderViewer();
      },
    })
      .then(({ undone, result }) => {
        if (undone) return;
        if (result?.error) {
          showToast(`Could not ${action}: ${result.error}`, { tone: 'danger' });
          if (panel.isConnected) renderViewer();
          return;
        }
        window.dispatchEvent(new CustomEvent('badges:refresh'));
        onRemoved?.(`File ${isArchive ? 'archived' : 'deleted'}. Select another file.`);
      })
      .catch((err) => showToast(`Could not ${action}: ${err?.message ?? err}`, { tone: 'danger' }));
  }

  let threadContainer = null;

  function startViewerThreadPolling() {
    let pollCount = 0;
    const interval = setInterval(async () => {
      if (!document.getElementById('viewer-thread-container')) {
        clearInterval(interval);
        return;
      }
      pollCount++;
      if (pollCount >= VIEWER_MAX_POLLS) {
        clearInterval(interval);
        threadGenerating = false;
        threadErrorMsg = 'Response timed out (3 minutes).';
        renderViewerThread();
        return;
      }
      const statusRes = await api(`${entryUrl()}/thread-status`);
      if (statusRes.status === 'error') {
        clearInterval(interval);
        threadGenerating = false;
        threadErrorMsg = statusRes.error || 'Generation failed';
        renderViewerThread();
        return;
      }
      if (statusRes.status === 'idle') {
        clearInterval(interval);
        if (statusRes.lastBotMessage) {
          if (!entry.evaluation?.thread?.find((m) => m.id === statusRes.lastBotMessage.id)) {
            if (!entry.evaluation) entry.evaluation = { evaluatedAt: new Date().toISOString() };
            if (!entry.evaluation.thread) entry.evaluation.thread = [];
            entry.evaluation.thread.push(statusRes.lastBotMessage);
          }
        }
        threadGenerating = false;
        threadErrorMsg = null;
        renderViewerThread();
      }
    }, 2000);
    _prodIntervals.push(interval);
  }

  async function sendThreadMessage(text) {
    if (!entry.evaluation) entry.evaluation = { evaluatedAt: new Date().toISOString() };
    if (!entry.evaluation.thread) entry.evaluation.thread = [];
    entry.evaluation.thread.push({
      id: 'temp',
      role: 'human',
      content: text,
      createdAt: new Date().toISOString(),
    });
    threadGenerating = true;
    threadErrorMsg = null;
    renderViewerThread();

    const res = await api(`${entryUrl()}/thread`, { method: 'POST', body: { message: text } });
    if (res.error) {
      threadGenerating = false;
      showToast(`Could not send: ${res.error}`, { tone: 'danger' });
      renderViewerThread();
      return;
    }
    if (res.entry?.evaluation) entry.evaluation = res.entry.evaluation;
    startViewerThreadPolling();
  }

  function renderViewerThread() {
    if (!threadContainer?.isConnected) return;
    renderThread(threadContainer, {
      thread: entry.evaluation?.thread ?? [],
      legacyFeedback: entry.evaluation?.feedback || null,
      legacyResponse: entry.evaluation?.aiResponse || null,
      generating: threadGenerating,
      error: threadErrorMsg,
      botId,
      onRetry: async () => {
        threadErrorMsg = null;
        threadGenerating = true;
        renderViewerThread();
        await api(`${entryUrl()}/retry-thread`, { method: 'POST' });
        startViewerThreadPolling();
      },
      onSend: (text) => sendThreadMessage(text),
    });
  }

  function renderViewer() {
    const title = botLabel
      ? `<a href="${prodHash({ botId, single: true })}" style="font-size:13px;font-weight:400">${escapeHtml(botLabel)}</a> / ${escapeHtml(node.path)}`
      : escapeHtml(node.path);
    panel.innerHTML = `
      <div class="prod-file-viewer-title">
        ${title}
        <div class="prod-file-actions">
          <button class="btn btn-sm" id="viewer-copy" title="Copy contents">Copy</button>
          <button class="btn btn-sm" id="viewer-download" title="Download file">Download</button>
          <button class="btn btn-sm" id="viewer-fullscreen" title="View fullscreen">Fullscreen</button>
        </div>
      </div>
      ${
        entry
          ? `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;font-size:12px;align-items:center">
        <span class="text-dim">${new Date(entry.timestamp).toLocaleString()}</span>
        <span class="text-dim">${escapeHtml(entry.tool)} / ${escapeHtml(entry.action)}</span>
        ${entry.trackOnly ? '<span class="badge badge-disabled">track-only</span>' : ''}
        ${statusBadge(entry)}
        ${entry.coherenceCheck ? `<span class="badge eval-badge-checked"${entry.coherenceCheck.explanation ? ` title="${escapeHtml(entry.coherenceCheck.explanation)}"` : ''}>Checked</span>` : ''}
        <span id="viewer-coherence-badge">${coherencePolling ? '<span class="badge badge-disabled">Checking…</span>' : coherenceBadgeHtml(coherenceResult)}</span>
      </div>`
          : ''
      }

      <div class="production-content">${content != null ? renderContent(content, node.name) : '<p class="text-dim" style="padding:12px">File not found or empty</p>'}</div>

      ${
        entry
          ? `
        <div class="eval-controls" style="margin-top:16px">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
            <button class="btn btn-sm${currentStatus === 'approved' ? ' btn-primary' : ''}" id="viewer-approve" aria-pressed="${currentStatus === 'approved'}">Approve</button>
            <button class="btn btn-sm${currentStatus === 'rejected' ? ' btn-danger' : ''}" id="viewer-reject" aria-pressed="${currentStatus === 'rejected'}">Reject</button>
            <span style="margin-left:12px" title="${currentStatus ? 'Click a star to rate' : 'Pick a rating, then Approve or Reject'}">${starsHtml(currentRating, true)}</span>
            <span style="margin-left:auto"></span>
            <button class="btn btn-sm" id="viewer-archive" title="Move to archived/">Archive</button>
            <button class="btn btn-danger btn-sm" id="viewer-delete">Delete</button>
          </div>
          <details class="prod-eval-note">
            <summary class="text-dim text-sm">Add a note (sent to the agent with your verdict)</summary>
            <textarea id="viewer-note" class="form-input" rows="2" placeholder="Optional: what was good, what to change"></textarea>
          </details>
        </div>

        <div class="form-separator"></div>
        <div class="form-section-title">Discussion</div>
        <div id="viewer-thread-container"></div>
      `
          : `<div style="margin-top:12px"><span class="text-dim text-sm">This file is not tracked in the changelog.</span></div>`
      }
    `;

    attachFileActions(panel, { path: node.path, name: node.name, content });

    if (!entry) return;

    for (const star of panel.querySelectorAll('.star-interactive .star')) {
      star.style.cursor = 'pointer';
      star.addEventListener('click', () => {
        currentRating = Number.parseInt(star.dataset.star);
        // A rating rides on a verdict: with one already given, save at once.
        if (currentStatus) evaluate(currentStatus, { quiet: true });
        else renderViewer();
      });
    }

    panel.querySelector('#viewer-approve')?.addEventListener('click', () => evaluate('approved'));
    panel.querySelector('#viewer-reject')?.addEventListener('click', () => evaluate('rejected'));
    panel.querySelector('#viewer-archive')?.addEventListener('click', () => removeWith('archive'));
    panel.querySelector('#viewer-delete')?.addEventListener('click', () => removeWith('delete'));

    threadContainer = panel.querySelector('#viewer-thread-container');
    renderViewerThread();
  }

  renderViewer();
}

export async function renderProductions(el) {
  destroyProductions();
  el.innerHTML = '<div class="page-title">Productions</div><p class="text-dim">Loading...</p>';

  const [stats, treeData] = await Promise.all([
    api('/api/productions'),
    api('/api/productions/all-trees'),
  ]);

  if (!Array.isArray(stats)) {
    el.innerHTML = `
      <div class="page-title">Productions</div>
      <p class="text-dim">Productions are not enabled. Set <code>productions.enabled: true</code> in config.</p>
    `;
    return;
  }

  if (stats.length === 0) {
    el.innerHTML = `
      <div class="page-title">Productions</div>
      <p class="text-dim">No productions yet. Bots will log file operations here when they create or edit files.</p>
    `;
    return;
  }

  const total = stats.reduce((s, b) => s + b.total, 0);
  let tree = Array.isArray(treeData.tree) ? treeData.tree : [];

  const botNameMap = {};
  for (const bot of stats) botNameMap[bot.botId] = bot.name;

  // Explorer state — restore from localStorage if available
  const STORAGE_KEY = 'prod-expanded-all';
  const expandedDirs = new Set();
  let selectedFile = null;
  const multiSelection = new Set(); // Set of selKey strings
  const lastClicked = { value: null }; // { botId, path, type }
  let searchFilter = '';
  let statusFilter = '';

  function saveExpandState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...expandedDirs]));
    } catch {}
  }

  function collectAllDirKeys(nodes, botId) {
    const keys = [];
    for (const node of nodes || []) {
      if (node.type === 'dir') {
        const isTopLevel = tree.includes(node);
        const key = isTopLevel ? node.path : `${botId}/${node.path}`;
        keys.push(key);
        keys.push(...collectAllDirKeys(node.children, isTopLevel ? node.path : botId));
      }
    }
    return keys;
  }

  el.innerHTML = `
    <div class="productions-explorer">
      <div class="prod-topbar">
        <div style="display:flex;gap:12px;align-items:center">
          <div class="page-title" style="margin-bottom:0">Productions <span class="count">${total}</span></div>
        </div>
        <div class="prod-topbar-stats">
          ${stats.map((b) => `<div class="stat-item"><a href="${prodHash({ botId: b.botId, single: true })}">${escapeHtml(b.name)}</a> <span class="text-dim">${b.total}</span> <a href="/productions-view/${encodeURIComponent(b.botId)}/" target="_blank" class="btn btn-sm" style="font-size:10px;padding:2px 6px;margin-left:4px" title="Open production index page">Index</a></div>`).join('')}
        </div>
      </div>

      <div class="prod-explorer-body">
        <div class="prod-tree-panel">${TREE_PANEL_CONTROLS}</div>
        <div class="prod-content-panel" id="prod-content-panel">
          <div class="prod-empty-state">Select a file to view its content</div>
        </div>
      </div>
    </div>
  `;

  const matchesFilters = (node) =>
    matchesProductionFilters(node, { search: searchFilter, status: statusFilter });
  const getVisibleItems = () =>
    collectVisibleItems(tree, { botId: null, expandedDirs, matchesFilters, topLevel: tree });
  const getSelectedItems = () =>
    getVisibleItems().filter((v) => multiSelection.has(selKey(v.botId, v.path)));

  async function reloadTree() {
    const fresh = await api('/api/productions/all-trees');
    tree = Array.isArray(fresh.tree) ? fresh.tree : [];
    selectedFile = null;
    multiSelection.clear();
    lastClicked.value = null;
    rerenderTree();
    const panel = document.getElementById('prod-content-panel');
    if (panel) panel.innerHTML = '<p class="text-dim">Select a file from the tree</p>';
  }

  const updateBulkBar = wireBulkBar(document.getElementById('prod-bulk-wrap'), {
    getSelectedItems,
    getVisibleItems,
    selection: multiSelection,
    rerender: () => rerenderTree(),
    reload: reloadTree,
  });

  function renderTree(container, nodes) {
    if (!container) return;
    container.innerHTML = '';
    for (const node of nodes) {
      if (!matchesFilters(node)) continue;
      renderTreeNode(container, node, null);
    }
    if (container.childElementCount === 0) {
      container.innerHTML =
        '<p class="text-dim" style="padding:8px;font-size:12px">No files match filters</p>';
    }
    updateBulkBar();
  }

  function rerenderTree() {
    renderTree(document.getElementById('prod-tree-container'), tree);
  }

  function renderTreeNode(parent, node, botId) {
    if (node.type === 'dir') {
      // Top-level dirs are bot folders (path = botId)
      const isTopLevel = tree.includes(node);
      const resolvedBotId = isTopLevel ? node.path : botId;
      const expandKey = isTopLevel ? node.path : `${resolvedBotId}/${node.path}`;
      const isExpanded = expandedDirs.has(expandKey);
      const isMultiSel = !isTopLevel && multiSelection.has(selKey(resolvedBotId, node.path));
      const item = document.createElement('div');
      item.className = `tree-item${isMultiSel ? ' multi-selected' : ''}`;
      item.innerHTML = `<span class="tree-chevron${isExpanded ? ' expanded' : ''}">&#9654;</span> ${escapeHtml(node.name)}/`;
      if (isTopLevel) item.style.fontWeight = '600';
      item.addEventListener('click', (e) => {
        if (!isTopLevel) {
          const consumed = handleMultiSelectClick(
            e,
            { botId: resolvedBotId, path: node.path, type: 'dir' },
            multiSelection,
            lastClicked,
            getVisibleItems,
            rerenderTree
          );
          if (consumed) return;
        }
        if (expandedDirs.has(expandKey)) expandedDirs.delete(expandKey);
        else expandedDirs.add(expandKey);
        saveExpandState();
        rerenderTree();
      });
      item.addEventListener('contextmenu', (e) => {
        const thisItem = { botId: resolvedBotId, path: node.path, type: 'dir', isTopLevel };
        const key = selKey(resolvedBotId, node.path);
        if (!multiSelection.has(key) && !isTopLevel) {
          multiSelection.clear();
          multiSelection.add(key);
          lastClicked.value = thisItem;
          rerenderTree();
        }
        const items = multiSelection.size > 0 ? getSelectedItems() : [thisItem];
        showTreeContextMenu(e, { items, isTopLevel, onDeleted: () => reloadTree() });
      });
      parent.appendChild(item);

      if (isExpanded && node.children) {
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        for (const child of node.children) {
          if (!matchesFilters(child)) continue;
          renderTreeNode(childContainer, child, resolvedBotId);
        }
        parent.appendChild(childContainer);
      }
    } else {
      if (!matchesFilters(node)) return;
      const item = document.createElement('div');
      const key = selKey(botId, node.path);
      const isFileSelected = selectedFile?.path === node.path && selectedFile?._botId === botId;
      const isMultiSel = multiSelection.has(key);
      item.className = `tree-item${isFileSelected ? ' selected' : ''}${isMultiSel ? ' multi-selected' : ''}`;
      item.innerHTML = `<span style="width:14px;flex-shrink:0"></span>${treeDots(node)} ${escapeHtml(node.name)}`;
      item.title = node.description || node.path;
      item.addEventListener('click', (e) => {
        const consumed = handleMultiSelectClick(
          e,
          { botId, path: node.path, type: 'file', entryId: node.entryId },
          multiSelection,
          lastClicked,
          getVisibleItems,
          rerenderTree
        );
        if (consumed) return;
        selectedFile = { ...node, _botId: botId };
        history.replaceState(null, '', prodHash({ botId, file: node.path }));
        rerenderTree();
        openViewer(botId, node);
      });
      item.addEventListener('contextmenu', (e) => {
        const thisItem = { botId, path: node.path, type: 'file', entryId: node.entryId };
        if (!multiSelection.has(key)) {
          multiSelection.clear();
          multiSelection.add(key);
          lastClicked.value = thisItem;
          rerenderTree();
        }
        const items = multiSelection.size > 0 ? getSelectedItems() : [thisItem];
        showTreeContextMenu(e, { items, onDeleted: () => reloadTree() });
      });
      parent.appendChild(item);
    }
  }

  function openViewer(botId, node) {
    mountFileViewer(document.getElementById('prod-content-panel'), {
      botId,
      node,
      botLabel: botNameMap[botId] || botId,
      onTreeChanged: rerenderTree,
      onRemoved: async (message) => {
        history.replaceState(null, '', prodHash({}));
        await reloadTree();
        const panel = document.getElementById('prod-content-panel');
        if (panel) panel.innerHTML = `<div class="prod-empty-state">${escapeHtml(message)}</div>`;
      },
    });
  }

  // --- Filters ---
  document.getElementById('prod-tree-search')?.addEventListener('input', (e) => {
    searchFilter = e.target.value;
    rerenderTree();
  });
  document.getElementById('prod-status-filter')?.addEventListener('change', (e) => {
    statusFilter = e.target.value;
    rerenderTree();
  });

  // --- Expand / Collapse buttons ---
  document.getElementById('prod-expand-all')?.addEventListener('click', () => {
    for (const key of collectAllDirKeys(tree, null)) expandedDirs.add(key);
    saveExpandState();
    rerenderTree();
  });
  document.getElementById('prod-collapse-all')?.addEventListener('click', () => {
    expandedDirs.clear();
    saveExpandState();
    rerenderTree();
  });

  // Restore expand state from localStorage, or auto-expand everything as default
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) {
      for (const key of saved) expandedDirs.add(key);
    }
  } catch {}
  if (expandedDirs.size === 0) {
    for (const key of collectAllDirKeys(tree, null)) expandedDirs.add(key);
    saveExpandState();
  }
  rerenderTree();

  // Restore selected file from URL hash params (?file=, or the legacy ?path=)
  const hashParams = getHashParams();
  const wantedFile = readFileParam(hashParams);
  if (hashParams.bot && wantedFile) {
    const targetBotId = hashParams.bot;
    const botNode = tree.find((n) => n.path === targetBotId);
    if (botNode) {
      const expandKeyFn = (dirNode, bId) =>
        tree.includes(dirNode) ? dirNode.path : `${bId}/${dirNode.path}`;
      const result = findNodeInTree(
        botNode.children,
        wantedFile,
        targetBotId,
        [botNode.path],
        expandKeyFn
      );
      if (result) {
        for (const key of result.parentKeys) expandedDirs.add(key);
        saveExpandState();
        selectedFile = { ...result.node, _botId: targetBotId };
        rerenderTree();
        openViewer(targetBotId, result.node);
      }
    }
  }
}

// --- Polling intervals to clean up on navigation ---
let _prodIntervals = [];

export function destroyProductions() {
  for (const id of _prodIntervals) clearInterval(id);
  _prodIntervals = [];
  closeFullscreenViewer();
}

export async function renderBotProductions(el, botId) {
  destroyProductions();
  el.innerHTML = '<div class="page-title">Productions</div><p class="text-dim">Loading...</p>';

  // Load tree + stats + bot list in parallel
  const [treeData, statsData, allBots] = await Promise.all([
    api(`/api/productions/${encodeURIComponent(botId)}/tree`),
    api(`/api/productions/${encodeURIComponent(botId)}`),
    api('/api/productions'),
  ]);

  if (statsData.error) {
    el.innerHTML = `
      <div class="page-title">Productions</div>
      <p class="text-dim">${escapeHtml(statsData.error)}</p>
      <a href="#/work/productions" class="btn btn-sm">&larr; Back</a>
    `;
    return;
  }

  const { stats } = statsData;
  let tree = Array.isArray(treeData.tree) ? treeData.tree : [];
  const botList = Array.isArray(allBots) ? allBots : [];

  // Explorer state — restore from localStorage if available
  const BOT_STORAGE_KEY = `prod-expanded-${botId}`;
  const expandedDirs = new Set();
  let selectedFile = null;
  const multiSelection = new Set();
  const lastClicked = { value: null };
  let searchFilter = '';
  let statusFilter = '';

  function saveExpandState() {
    try {
      localStorage.setItem(BOT_STORAGE_KEY, JSON.stringify([...expandedDirs]));
    } catch {}
  }

  function collectAllDirKeys(nodes) {
    const keys = [];
    for (const node of nodes || []) {
      if (node.type === 'dir') {
        keys.push(node.path);
        keys.push(...collectAllDirKeys(node.children));
      }
    }
    return keys;
  }

  el.innerHTML = `
    <div class="productions-explorer">
      <div class="prod-topbar">
        <div style="display:flex;gap:12px;align-items:center">
          <a href="#/work/productions" class="btn btn-sm">&larr; Back</a>
          <select id="prod-bot-selector" class="log-agent-filter">
            ${botList.map((b) => `<option value="${escapeHtml(b.botId)}"${b.botId === botId ? ' selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}
          </select>
        </div>
        <div class="prod-topbar-stats">
          <div class="stat-item"><strong>${stats.total}</strong> <span class="text-dim">Total</span></div>
          <div class="stat-item"><span style="color:var(--green)">${stats.approved}</span> <span class="text-dim">Approved</span></div>
          <div class="stat-item"><span style="color:var(--red)">${stats.rejected}</span> <span class="text-dim">Rejected</span></div>
          <div class="stat-item"><span style="color:var(--orange)">${stats.unreviewed}</span> <span class="text-dim">Unreviewed</span></div>
          ${stats.avgRating != null ? `<div class="stat-item">${starsHtml(Math.round(stats.avgRating))} <span class="text-dim">${stats.avgRating}</span></div>` : ''}
          <a href="/productions-view/${encodeURIComponent(botId)}/" target="_blank" class="btn btn-sm" title="Open production index page">Index</a>
          <button class="btn btn-sm" id="generate-summary-btn">Summary</button>
        </div>
      </div>

      <div class="prod-explorer-body">
        <div class="prod-tree-panel">${TREE_PANEL_CONTROLS}</div>
        <div class="prod-content-panel" id="prod-content-panel">
          <div class="prod-empty-state">Select a file to view its content</div>
        </div>
      </div>

      <div id="prod-bottom-section"></div>
    </div>
  `;

  document.getElementById('prod-bot-selector')?.addEventListener('change', (e) => {
    location.hash = prodHash({ botId: e.target.value, single: true });
  });

  const matchesFilters = (node) =>
    matchesProductionFilters(node, { search: searchFilter, status: statusFilter });
  const getVisibleItems = () => collectVisibleItems(tree, { botId, expandedDirs, matchesFilters });
  const getSelectedItems = () =>
    getVisibleItems().filter((v) => multiSelection.has(selKey(v.botId, v.path)));

  async function reloadTree() {
    const fresh = await api(`/api/productions/${encodeURIComponent(botId)}/tree`);
    tree = Array.isArray(fresh.tree) ? fresh.tree : [];
    selectedFile = null;
    multiSelection.clear();
    lastClicked.value = null;
    rerenderTree();
    const panel = document.getElementById('prod-content-panel');
    if (panel) panel.innerHTML = '<p class="text-dim">Select a file from the tree</p>';
  }

  const updateBulkBar = wireBulkBar(document.getElementById('prod-bulk-wrap'), {
    getSelectedItems,
    getVisibleItems,
    selection: multiSelection,
    rerender: () => rerenderTree(),
    reload: reloadTree,
  });

  function renderTree(container, nodes) {
    if (!container) return;
    container.innerHTML = '';
    for (const node of nodes) {
      if (!matchesFilters(node)) continue;
      renderTreeNode(container, node);
    }
    if (container.childElementCount === 0) {
      container.innerHTML =
        '<p class="text-dim" style="padding:8px;font-size:12px">No files match filters</p>';
    }
    updateBulkBar();
  }

  function rerenderTree() {
    renderTree(document.getElementById('prod-tree-container'), tree);
  }

  function renderTreeNode(parent, node) {
    if (node.type === 'dir') {
      const isExpanded = expandedDirs.has(node.path);
      const isMultiSel = multiSelection.has(selKey(botId, node.path));
      const item = document.createElement('div');
      item.className = `tree-item${isMultiSel ? ' multi-selected' : ''}`;
      item.innerHTML = `<span class="tree-chevron${isExpanded ? ' expanded' : ''}">&#9654;</span> ${escapeHtml(node.name)}/`;
      item.addEventListener('click', (e) => {
        const consumed = handleMultiSelectClick(
          e,
          { botId, path: node.path, type: 'dir' },
          multiSelection,
          lastClicked,
          getVisibleItems,
          rerenderTree
        );
        if (consumed) return;
        if (expandedDirs.has(node.path)) expandedDirs.delete(node.path);
        else expandedDirs.add(node.path);
        saveExpandState();
        rerenderTree();
      });
      item.addEventListener('contextmenu', (e) => {
        const thisItem = { botId, path: node.path, type: 'dir' };
        const key = selKey(botId, node.path);
        if (!multiSelection.has(key)) {
          multiSelection.clear();
          multiSelection.add(key);
          lastClicked.value = thisItem;
          rerenderTree();
        }
        const items = multiSelection.size > 0 ? getSelectedItems() : [thisItem];
        showTreeContextMenu(e, { items, onDeleted: () => reloadTree() });
      });
      parent.appendChild(item);

      if (isExpanded && node.children) {
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        for (const child of node.children) {
          if (!matchesFilters(child)) continue;
          renderTreeNode(childContainer, child);
        }
        parent.appendChild(childContainer);
      }
    } else {
      if (!matchesFilters(node)) return;
      const item = document.createElement('div');
      const key = selKey(botId, node.path);
      const isFileSelected = selectedFile?.path === node.path;
      const isMultiSel = multiSelection.has(key);
      item.className = `tree-item${isFileSelected ? ' selected' : ''}${isMultiSel ? ' multi-selected' : ''}`;
      item.innerHTML = `<span style="width:14px;flex-shrink:0"></span>${treeDots(node)} ${escapeHtml(node.name)}`;
      item.title = node.description || node.path;
      item.addEventListener('click', (e) => {
        const consumed = handleMultiSelectClick(
          e,
          { botId, path: node.path, type: 'file', entryId: node.entryId },
          multiSelection,
          lastClicked,
          getVisibleItems,
          rerenderTree
        );
        if (consumed) return;
        selectedFile = node;
        history.replaceState(null, '', prodHash({ botId, file: node.path, single: true }));
        rerenderTree();
        openViewer(node);
      });
      item.addEventListener('contextmenu', (e) => {
        const thisItem = { botId, path: node.path, type: 'file', entryId: node.entryId };
        if (!multiSelection.has(key)) {
          multiSelection.clear();
          multiSelection.add(key);
          lastClicked.value = thisItem;
          rerenderTree();
        }
        const items = multiSelection.size > 0 ? getSelectedItems() : [thisItem];
        showTreeContextMenu(e, { items, onDeleted: () => reloadTree() });
      });
      parent.appendChild(item);
    }
  }

  function openViewer(node) {
    mountFileViewer(document.getElementById('prod-content-panel'), {
      botId,
      node,
      onTreeChanged: rerenderTree,
      onRemoved: async (message) => {
        history.replaceState(null, '', prodHash({ botId, single: true }));
        await reloadTree();
        const panel = document.getElementById('prod-content-panel');
        if (panel) panel.innerHTML = `<div class="prod-empty-state">${escapeHtml(message)}</div>`;
      },
    });
  }

  // --- Filters ---
  document.getElementById('prod-tree-search')?.addEventListener('input', (e) => {
    searchFilter = e.target.value;
    rerenderTree();
  });
  document.getElementById('prod-status-filter')?.addEventListener('change', (e) => {
    statusFilter = e.target.value;
    rerenderTree();
  });

  // --- Expand / Collapse buttons ---
  document.getElementById('prod-expand-all')?.addEventListener('click', () => {
    for (const key of collectAllDirKeys(tree)) expandedDirs.add(key);
    saveExpandState();
    rerenderTree();
  });
  document.getElementById('prod-collapse-all')?.addEventListener('click', () => {
    expandedDirs.clear();
    saveExpandState();
    rerenderTree();
  });

  // Restore expand state from localStorage, or auto-expand if few dirs
  try {
    const saved = JSON.parse(localStorage.getItem(BOT_STORAGE_KEY));
    if (Array.isArray(saved)) {
      for (const key of saved) expandedDirs.add(key);
    }
  } catch {}
  if (expandedDirs.size === 0) {
    const allDirs = collectAllDirKeys(tree);
    if (allDirs.length <= 20) {
      for (const key of allDirs) expandedDirs.add(key);
    }
    saveExpandState();
  }
  rerenderTree();

  // Restore selected file from URL hash params (?file=, or the legacy ?path=)
  const wantedFile = readFileParam(getHashParams());
  if (wantedFile) {
    const result = findNodeInTree(tree, wantedFile, botId, [], (dirNode) => dirNode.path);
    if (result) {
      for (const key of result.parentKeys) expandedDirs.add(key);
      saveExpandState();
      selectedFile = result.node;
      rerenderTree();
      openViewer(result.node);
    }
  }

  // --- Summary (collapsible at bottom) ---
  const bottomSection = document.getElementById('prod-bottom-section');
  if (bottomSection) {
    bottomSection.innerHTML = `
      <div class="form-separator"></div>
      <div id="summary-container" class="mb-16"></div>
      <div id="productions-chat-section" class="mb-16"></div>
    `;
  }

  // Summary polling
  function checkSummaryStatus(id) {
    const btn = document.getElementById('generate-summary-btn');
    const container = document.getElementById('summary-container');
    if (!btn || !container) return Promise.resolve('gone');

    return api(`/api/productions/${encodeURIComponent(id)}/summary-status`).then((res) => {
      if (!document.getElementById('generate-summary-btn')) return 'gone';
      if (res.status === 'generating') {
        btn.disabled = true;
        btn.textContent = 'Generating...';
        container.innerHTML = '<p class="text-dim">Analyzing productions...</p>';
      } else if (res.status === 'done') {
        btn.disabled = false;
        btn.textContent = 'Summary';
        container.innerHTML = `<div class="detail-card" style="white-space:pre-wrap">${escapeHtml(res.summary)}</div>`;
      } else if (res.status === 'error') {
        btn.disabled = false;
        btn.textContent = 'Summary';
        container.innerHTML = `<div class="detail-card" style="border-color:var(--red)"><p class="text-dim">${escapeHtml(res.error)}</p></div>`;
      } else {
        btn.disabled = false;
        btn.textContent = 'Summary';
      }
      return res.status;
    });
  }

  function startSummaryPolling(id) {
    const interval = setInterval(async () => {
      const status = await checkSummaryStatus(id);
      if (status !== 'generating') clearInterval(interval);
    }, 3000);
    _prodIntervals.push(interval);
  }

  const summaryBtn = document.getElementById('generate-summary-btn');
  if (summaryBtn) {
    checkSummaryStatus(botId).then((status) => {
      if (status === 'generating') startSummaryPolling(botId);
    });
    summaryBtn.addEventListener('click', async () => {
      summaryBtn.disabled = true;
      summaryBtn.textContent = 'Generating...';
      const container = document.getElementById('summary-container');
      if (container) container.innerHTML = '<p class="text-dim">Analyzing productions...</p>';
      try {
        await api(`/api/productions/${encodeURIComponent(botId)}/generate-summary`, {
          method: 'POST',
        });
        startSummaryPolling(botId);
      } catch (err) {
        if (container)
          container.innerHTML = `<div class="detail-card" style="border-color:var(--red)"><p class="text-dim">Request failed: ${escapeHtml(String(err))}</p></div>`;
        summaryBtn.disabled = false;
        summaryBtn.textContent = 'Summary';
      }
    });
  }

  // --- Productions Chat section ---
  let chatConvos = [];
  let activeChat = null;
  let chatMessages = [];
  let chatGenerating = false;
  let chatErrorMsg = null;
  const MAX_POLLS = 90;

  async function loadProductionsChats() {
    const data = await api(`/api/conversations/${encodeURIComponent(botId)}?type=productions`);
    if (!data.error) chatConvos = data;
    renderProductionsChat();
  }

  function renderProductionsChat() {
    const section = document.getElementById('productions-chat-section');
    if (!section) return;

    section.innerHTML = `
      <div class="flex-between mb-16">
        <div class="form-section-title">Productions Chat</div>
        <button class="btn btn-primary btn-sm" id="new-prod-chat-btn">New Chat</button>
      </div>
      ${
        chatConvos.length > 0 && !activeChat
          ? `<div id="prod-chat-list" class="mb-16">
        ${chatConvos
          .map(
            (c) => `
          <div class="detail-card mb-8 prod-chat-item" data-id="${c.id}" style="cursor:pointer;padding:10px 14px;display:flex;justify-content:space-between;align-items:center">
            <div><strong>${escapeHtml(c.title)}</strong> <span class="text-dim text-sm" style="margin-left:8px">${c.messageCount} messages</span></div>
            <span class="text-dim text-sm">${timeAgo(c.updatedAt)}</span>
          </div>
        `
          )
          .join('')}
      </div>`
          : ''
      }
      ${
        activeChat
          ? `<div class="detail-card mb-16">
        <div class="flex-between mb-8">
          <strong>${escapeHtml(activeChat.title)}</strong>
          <div style="display:flex;gap:8px;align-items:center">
            <a href="#/work/conversations/${encodeURIComponent(botId)}/${activeChat.id}" class="text-dim text-sm">Open in Conversations &rarr;</a>
            <button class="btn btn-sm" id="prod-chat-back-btn">Back to list</button>
          </div>
        </div>
        <div id="prod-chat-thread"></div>
      </div>`
          : ''
      }
      ${!activeChat && chatConvos.length === 0 ? '<p class="text-dim">No productions chats yet. Start a conversation about this bot\'s work.</p>' : ''}`;

    document.getElementById('new-prod-chat-btn')?.addEventListener('click', async () => {
      const res = await api(`/api/conversations/${encodeURIComponent(botId)}`, {
        method: 'POST',
        body: { type: 'productions' },
      });
      if (res.id) {
        activeChat = res;
        chatMessages = [];
        chatGenerating = false;
        renderProductionsChat();
      }
    });
    document.getElementById('prod-chat-back-btn')?.addEventListener('click', () => {
      activeChat = null;
      loadProductionsChats();
    });
    document.querySelectorAll('.prod-chat-item').forEach((item) => {
      item.addEventListener('click', async () => {
        const data = await api(
          `/api/conversations/${encodeURIComponent(botId)}/${item.dataset.id}`
        );
        if (data.conversation) {
          activeChat = data.conversation;
          chatMessages = data.messages || [];
          chatGenerating = false;
          renderProductionsChat();
        }
      });
    });
    if (activeChat) renderProdChatThread();
  }

  function startProdChatPolling() {
    let pollCount = 0;
    const pollInterval = setInterval(async () => {
      if (!document.getElementById('prod-chat-thread')) {
        clearInterval(pollInterval);
        return;
      }
      pollCount++;
      if (pollCount >= MAX_POLLS) {
        clearInterval(pollInterval);
        chatGenerating = false;
        chatErrorMsg = 'Response timed out (3 minutes).';
        renderProdChatThread();
        return;
      }
      const statusRes = await api(
        `/api/conversations/${encodeURIComponent(botId)}/${activeChat.id}/status`
      );
      if (statusRes.status === 'error') {
        clearInterval(pollInterval);
        chatGenerating = false;
        chatErrorMsg = statusRes.error || 'Generation failed';
        renderProdChatThread();
        return;
      }
      if (statusRes.status === 'idle') {
        clearInterval(pollInterval);
        if (
          statusRes.lastBotMessage &&
          !chatMessages.find((m) => m.id === statusRes.lastBotMessage.id)
        )
          chatMessages.push(statusRes.lastBotMessage);
        chatGenerating = false;
        chatErrorMsg = null;
        renderProdChatThread();
        const convData = await api(
          `/api/conversations/${encodeURIComponent(botId)}/${activeChat.id}`
        );
        if (convData.conversation) {
          activeChat.title = convData.conversation.title;
          loadProductionsChats();
        }
      }
    }, 2000);
    _prodIntervals.push(pollInterval);
  }

  function renderProdChatThread() {
    const container = document.getElementById('prod-chat-thread');
    if (!container || !activeChat) return;
    renderThread(container, {
      thread: chatMessages,
      generating: chatGenerating,
      error: chatErrorMsg,
      botId,
      onRetry: async () => {
        chatErrorMsg = null;
        chatGenerating = true;
        renderProdChatThread();
        await api(`/api/conversations/${encodeURIComponent(botId)}/${activeChat.id}/retry`, {
          method: 'POST',
        });
        startProdChatPolling();
      },
      onSend: async (text) => {
        chatMessages.push({
          id: `temp-${Date.now()}`,
          role: 'human',
          content: text,
          createdAt: new Date().toISOString(),
        });
        chatGenerating = true;
        chatErrorMsg = null;
        renderProdChatThread();
        const res = await api(
          `/api/conversations/${encodeURIComponent(botId)}/${activeChat.id}/messages`,
          { method: 'POST', body: { message: text } }
        );
        if (res.error) {
          chatGenerating = false;
          renderProdChatThread();
          return;
        }
        if (res.message) {
          const tempIdx = chatMessages.findIndex((m) => m.id.startsWith('temp-'));
          if (tempIdx !== -1) chatMessages[tempIdx] = res.message;
        }
        startProdChatPolling();
      },
    });
  }

  await loadProductionsChats();
}
