import { confirmDialog, openSheet, promptDialog, showToast } from '../ui/index.js';
import { api, escapeHtml } from './shared.js';
import { mountToolRunForm } from './tool-runner.js';
import {
  TOOL_SOURCES,
  filterTools,
  groupTools,
  mergeTools,
  pendingIds,
  toolsBulkBar,
  toolsTable,
} from './tools-helpers.js';

const STATUS_BADGES = {
  pending: '<span class="badge badge-pending">Pending</span>',
  approved: '<span class="badge badge-running">Approved</span>',
  rejected: '<span class="badge badge-stopped">Rejected</span>',
};

// Search + source filter of the merged list; survives re-renders.
const toolsFilter = { query: '', source: '' };

/** Reject with an optional note. Resolves false when the dialog is cancelled. */
async function rejectTool(id) {
  const note = await promptDialog({
    title: 'Reject this tool?',
    message: 'Optional note for the bot that created it.',
    placeholder: 'Rejection note (optional)',
    confirmLabel: 'Reject',
  });
  if (note === null) return false;
  const res = await api(`/api/tools/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: { note: note.trim() || undefined },
  });
  if (res?.error) {
    showToast(`Reject failed: ${res.error}`, { tone: 'danger' });
    return false;
  }
  return true;
}

/**
 * Merged Tools page (UX overhaul phase 4): every tool — built-in, MCP and
 * dynamic — with a Run action per row (opens the runner form in a sheet),
 * plus approve / reject / delete for dynamic tools and bulk approve/reject of
 * the pending ones.
 */
export async function renderTools(el) {
  el.innerHTML = '<div class="page-title">Tools</div><p class="text-dim">Loading...</p>';

  const [allRes, dynRes] = await Promise.all([api('/api/tools/all'), api('/api/tools')]);

  if (!Array.isArray(allRes)) {
    el.innerHTML = `
      <div class="page-title">Tools</div>
      <p class="text-dim">${
        allRes?.error && !/not found/i.test(allRes.error)
          ? escapeHtml(allRes.error)
          : 'The tools API is not available. Set <code>dynamicTools.enabled: true</code> in config.'
      }</p>
      <button class="btn btn-sm" data-action="retry">Retry</button>
    `;
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () => renderTools(el));
    return;
  }

  let tools = mergeTools(allRes, dynRes);
  const selected = new Set();

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Tools <span class="count" id="tools-count">${tools.length}</span></div>
    </div>
    <p class="text-dim text-sm mb-16">Every tool the agents can call. <strong>Run</strong> executes one directly, without an LLM. Bots create dynamic tools with <code>create_tool</code>; those need approval before they load.</p>
    <div class="ops-toolbar">
      <input type="search" id="tools-filter-query" class="ops-filter-query" placeholder="Filter tools…" data-page-filter aria-label="Filter tools" value="${escapeHtml(toolsFilter.query)}">
      <select id="tools-filter-source" class="ops-filter" aria-label="Filter by source">
        ${TOOL_SOURCES.map(
          (s) =>
            `<option value="${s.id}"${s.id === toolsFilter.source ? ' selected' : ''}>${escapeHtml(s.label)}</option>`
        ).join('')}
      </select>
      <span id="tools-pending-slot"></span>
    </div>
    <div id="tools-bulk-slot"></div>
    <div id="tools-table-wrap"></div>
  `;

  const wrap = document.getElementById('tools-table-wrap');
  const bulkSlot = document.getElementById('tools-bulk-slot');
  const pendingSlot = document.getElementById('tools-pending-slot');

  const draw = () => {
    const visible = filterTools(tools, toolsFilter);
    const visiblePending = new Set(pendingIds(visible));
    for (const id of [...selected]) if (!visiblePending.has(id)) selected.delete(id);
    wrap.innerHTML = toolsTable(groupTools(visible), {
      selected,
      filtered: visible.length !== tools.length,
    });
    bulkSlot.innerHTML = toolsBulkBar(selected.size);
    const pending = pendingIds(tools);
    pendingSlot.innerHTML = pending.length
      ? `<button class="btn btn-sm" id="tools-select-pending">Select pending (${pending.length})</button>`
      : '';
    document.getElementById('tools-count').textContent = String(tools.length);
  };
  const reload = async () => {
    const [a, d] = await Promise.all([api('/api/tools/all'), api('/api/tools')]);
    if (Array.isArray(a)) tools = mergeTools(a, d);
    if (wrap.isConnected) draw();
  };
  draw();

  document.getElementById('tools-filter-query').addEventListener('input', (e) => {
    toolsFilter.query = e.target.value;
    draw();
  });
  document.getElementById('tools-filter-source').addEventListener('change', (e) => {
    toolsFilter.source = e.target.value;
    draw();
  });
  pendingSlot.addEventListener('click', (e) => {
    if (!e.target.closest('#tools-select-pending')) return;
    toolsFilter.source = 'pending';
    document.getElementById('tools-filter-source').value = 'pending';
    for (const id of pendingIds(tools)) selected.add(id);
    draw();
  });

  wrap.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-select]');
    if (!box) return;
    if (box.checked) selected.add(box.dataset.select);
    else selected.delete(box.dataset.select);
    bulkSlot.innerHTML = toolsBulkBar(selected.size);
  });

  wrap.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === 'run') {
      const tool = tools.find((t) => t.name === btn.dataset.name);
      if (!tool) return;
      const body = openSheet({ title: `Run ${tool.name}`, wide: true });
      if (body) {
        mountToolRunForm(body, tool);
        body.querySelector('[data-param]')?.focus();
      }
      return;
    }
    if (action === 'approve') {
      btn.disabled = true;
      btn.textContent = 'Approving...';
      const res = await api(`/api/tools/${encodeURIComponent(id)}/approve`, { method: 'POST' });
      if (res?.error) showToast(`Approve failed: ${res.error}`, { tone: 'danger' });
      else showToast('Tool approved', { tone: 'ok' });
      await reload();
      return;
    }
    if (action === 'reject') {
      if (await rejectTool(id)) {
        showToast('Tool rejected', { tone: 'ok' });
        await reload();
      }
      return;
    }
    if (action === 'delete') {
      const ok = await confirmDialog({
        title: `Delete tool "${btn.dataset.name || id}"?`,
        message: 'Its source and metadata are removed. This cannot be undone.',
        confirmLabel: 'Delete',
      });
      if (!ok) return;
      const res = await api(`/api/tools/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res?.error) showToast(`Delete failed: ${res.error}`, { tone: 'danger' });
      else showToast('Tool deleted', { tone: 'ok' });
      await reload();
    }
  });

  bulkSlot.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-bulk]');
    if (!btn) return;
    const action = btn.dataset.bulk;
    if (action === 'clear') {
      selected.clear();
      draw();
      return;
    }
    const ids = [...selected];
    if (ids.length === 0) return;
    let note = '';
    if (action === 'reject') {
      note = await promptDialog({
        title: `Reject ${ids.length} tool${ids.length === 1 ? '' : 's'}?`,
        message: 'Optional note, sent with every rejection.',
        placeholder: 'Rejection note (optional)',
        confirmLabel: 'Reject',
      });
      if (note === null) return;
    }
    for (const b of bulkSlot.querySelectorAll('button')) b.disabled = true;
    const results = await Promise.all(
      ids.map((id) =>
        api(`/api/tools/${encodeURIComponent(id)}/${action}`, {
          method: 'POST',
          ...(action === 'reject' ? { body: { note: note.trim() || undefined } } : {}),
        }).catch((err) => ({ error: err?.message || 'error' }))
      )
    );
    const failed = results.filter((r) => !r || r.error).length;
    const verb = action === 'approve' ? 'Approved' : 'Rejected';
    showToast(
      failed
        ? `${verb} ${ids.length - failed} of ${ids.length} — ${failed} failed`
        : `${verb} ${ids.length} tool${ids.length === 1 ? '' : 's'}`,
      { tone: failed ? 'danger' : 'ok' }
    );
    selected.clear();
    await reload();
  });
}

export async function renderToolDetail(el, toolId) {
  el.innerHTML = '<div class="page-title">Tool Detail</div><p class="text-dim">Loading...</p>';

  const data = await api(`/api/tools/${encodeURIComponent(toolId)}`);

  if (!data || data.error) {
    el.innerHTML = `
      <div class="page-title">Tool Not Found</div>
      <p class="text-dim">${escapeHtml(data?.error || 'Unexpected response')}</p>
      <a href="#/automations/tools" class="btn btn-sm">&larr; Back to Tools</a>
    `;
    return;
  }

  const { meta, source } = data;

  const paramsHtml =
    Object.keys(meta.parameters || {}).length > 0
      ? `<table class="params-table">
        <thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
        <tbody>
          ${Object.entries(meta.parameters)
            .map(
              ([name, p]) => `
            <tr>
              <td><code>${escapeHtml(name)}</code></td>
              <td class="text-dim">${escapeHtml(p.type)}</td>
              <td>${p.required ? 'Yes' : 'No'}</td>
              <td class="text-dim">${escapeHtml(p.description)}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>`
      : '<p class="text-dim">No parameters defined.</p>';

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">${escapeHtml(meta.name)}</div>
      <a href="#/automations/tools" class="btn btn-sm">&larr; Back</a>
    </div>

    <div class="detail-grid">
      <div class="detail-row"><span class="detail-label">ID</span><span>${escapeHtml(meta.id)}</span></div>
      <div class="detail-row"><span class="detail-label">Type</span><span>${escapeHtml(meta.type)}</span></div>
      <div class="detail-row"><span class="detail-label">Status</span><span>${STATUS_BADGES[meta.status] || meta.status}</span></div>
      <div class="detail-row"><span class="detail-label">Created By</span><span>${escapeHtml(meta.createdBy)}</span></div>
      <div class="detail-row"><span class="detail-label">Scope</span><span>${escapeHtml(meta.scope)}</span></div>
      <div class="detail-row"><span class="detail-label">Created</span><span>${new Date(meta.createdAt).toLocaleString()}</span></div>
      <div class="detail-row"><span class="detail-label">Updated</span><span>${new Date(meta.updatedAt).toLocaleString()}</span></div>
      ${meta.rejectionNote ? `<div class="detail-row"><span class="detail-label">Rejection Note</span><span class="text-dim">${escapeHtml(meta.rejectionNote)}</span></div>` : ''}
    </div>

    <h3>Description</h3>
    <p>${escapeHtml(meta.description)}</p>

    <h3>Parameters</h3>
    ${paramsHtml}

    <h3>Source Code</h3>
    <pre class="code-block">${escapeHtml(source)}</pre>

    <div class="actions mt-16" id="tool-actions">
      ${
        meta.status === 'pending'
          ? `
        <button class="btn btn-primary" data-action="approve">Approve</button>
        <button class="btn btn-danger" data-action="reject">Reject</button>
      `
          : ''
      }
      ${
        meta.status === 'approved'
          ? `
        <button class="btn btn-danger" data-action="reject">Revoke (Reject)</button>
      `
          : ''
      }
      ${
        meta.status === 'rejected'
          ? `
        <button class="btn btn-primary" data-action="approve">Approve</button>
      `
          : ''
      }
      <button class="btn btn-danger" data-action="delete">Delete</button>
    </div>
  `;

  document.getElementById('tool-actions').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'approve') {
      btn.disabled = true;
      btn.textContent = 'Approving...';
      const res = await api(`/api/tools/${encodeURIComponent(meta.id)}/approve`, {
        method: 'POST',
      });
      if (res?.error) showToast(`Approve failed: ${res.error}`, { tone: 'danger' });
      renderToolDetail(el, toolId);
    } else if (action === 'reject') {
      // Cancelling the note dialog aborts the rejection.
      if (await rejectTool(meta.id)) renderToolDetail(el, toolId);
    } else if (action === 'delete') {
      const ok = await confirmDialog({
        title: 'Delete this tool?',
        message: 'Its source and metadata are removed. This cannot be undone.',
        confirmLabel: 'Delete',
      });
      if (!ok) return;
      const res = await api(`/api/tools/${encodeURIComponent(meta.id)}`, { method: 'DELETE' });
      if (res?.error) {
        showToast(`Delete failed: ${res.error}`, { tone: 'danger' });
        return;
      }
      showToast('Tool deleted', { tone: 'ok' });
      location.hash = '#/automations/tools';
    }
  });
}
