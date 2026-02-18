import { api, escapeHtml, timeAgo } from './shared.js';

const STATUS_BADGES = {
  pending: '<span class="badge badge-pending">Pending</span>',
  approved: '<span class="badge badge-running">Approved</span>',
  rejected: '<span class="badge badge-stopped">Rejected</span>',
};

export async function renderTools(el) {
  el.innerHTML = '<div class="page-title">Dynamic Tools</div><p class="text-dim">Loading...</p>';

  const tools = await api('/api/tools');

  if (tools.error) {
    el.innerHTML = `
      <div class="page-title">Dynamic Tools</div>
      <p class="text-dim">Dynamic tools are not enabled. Set <code>dynamicTools.enabled: true</code> in config.</p>
    `;
    return;
  }

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Dynamic Tools <span class="count">${tools.length}</span></div>
    </div>
    ${tools.length === 0
      ? '<p class="text-dim">No dynamic tools created yet. Bots can create tools using the <code>create_tool</code> tool during conversations or agent loop runs.</p>'
      : `<table>
          <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Created By</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody id="tools-tbody"></tbody>
        </table>`
    }
  `;

  if (tools.length === 0) return;

  const tbody = document.getElementById('tools-tbody');
  for (const tool of tools) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="#/tools/${encodeURIComponent(tool.id)}">${escapeHtml(tool.name)}</a></td>
      <td class="text-dim">${escapeHtml(tool.type)}</td>
      <td>${STATUS_BADGES[tool.status] || tool.status}</td>
      <td class="text-dim">${escapeHtml(tool.createdBy)}</td>
      <td class="text-dim">${timeAgo(tool.createdAt)}</td>
      <td class="actions">
        ${tool.status === 'pending' ? `
          <button class="btn btn-sm btn-primary" data-action="approve" data-id="${tool.id}">Approve</button>
          <button class="btn btn-sm btn-danger" data-action="reject" data-id="${tool.id}">Reject</button>
        ` : ''}
        <button class="btn btn-sm btn-danger" data-action="delete" data-id="${tool.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'approve') {
      btn.disabled = true;
      btn.textContent = 'Approving...';
      await api(`/api/tools/${id}/approve`, { method: 'POST' });
      renderTools(el);
    } else if (action === 'reject') {
      const note = prompt('Rejection note (optional):');
      btn.disabled = true;
      btn.textContent = 'Rejecting...';
      await api(`/api/tools/${id}/reject`, { method: 'POST', body: { note: note || undefined } });
      renderTools(el);
    } else if (action === 'delete') {
      if (confirm(`Delete tool "${id}"? This cannot be undone.`)) {
        await api(`/api/tools/${id}`, { method: 'DELETE' });
        renderTools(el);
      }
    }
  });
}

export async function renderToolDetail(el, toolId) {
  el.innerHTML = '<div class="page-title">Tool Detail</div><p class="text-dim">Loading...</p>';

  const data = await api(`/api/tools/${toolId}`);

  if (data.error) {
    el.innerHTML = `
      <div class="page-title">Tool Not Found</div>
      <p class="text-dim">${escapeHtml(data.error)}</p>
      <a href="#/tools" class="btn btn-sm">&larr; Back to Tools</a>
    `;
    return;
  }

  const { meta, source } = data;

  const paramsHtml = Object.keys(meta.parameters || {}).length > 0
    ? `<table class="params-table">
        <thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
        <tbody>
          ${Object.entries(meta.parameters).map(([name, p]) => `
            <tr>
              <td><code>${escapeHtml(name)}</code></td>
              <td class="text-dim">${escapeHtml(p.type)}</td>
              <td>${p.required ? 'Yes' : 'No'}</td>
              <td class="text-dim">${escapeHtml(p.description)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`
    : '<p class="text-dim">No parameters defined.</p>';

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">${escapeHtml(meta.name)}</div>
      <a href="#/tools" class="btn btn-sm">&larr; Back</a>
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
      ${meta.status === 'pending' ? `
        <button class="btn btn-primary" data-action="approve">Approve</button>
        <button class="btn btn-danger" data-action="reject">Reject</button>
      ` : ''}
      ${meta.status === 'approved' ? `
        <button class="btn btn-danger" data-action="reject">Revoke (Reject)</button>
      ` : ''}
      ${meta.status === 'rejected' ? `
        <button class="btn btn-primary" data-action="approve">Approve</button>
      ` : ''}
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
      await api(`/api/tools/${meta.id}/approve`, { method: 'POST' });
      renderToolDetail(el, toolId);
    } else if (action === 'reject') {
      const note = prompt('Rejection note (optional):');
      btn.disabled = true;
      btn.textContent = 'Rejecting...';
      await api(`/api/tools/${meta.id}/reject`, { method: 'POST', body: { note: note || undefined } });
      renderToolDetail(el, toolId);
    } else if (action === 'delete') {
      if (confirm('Delete this tool? This cannot be undone.')) {
        await api(`/api/tools/${meta.id}`, { method: 'DELETE' });
        location.hash = '#/tools';
      }
    }
  });
}
