import { api, closeModal, escapeHtml, getAuthContext, showModal, timeAgo } from './shared.js';

/**
 * #/baas/templates — Template list
 */
export async function renderBaasTemplates(el) {
  const { role } = getAuthContext();
  if (role === 'tenant') {
    el.innerHTML = '<p class="text-dim">Access denied.</p>';
    return;
  }

  el.innerHTML = '<div class="page-title">Bot Templates</div><p class="text-dim">Loading...</p>';

  const data = await api('/api/baas/templates');
  if (data.error) {
    el.innerHTML = `<div class="page-title">Bot Templates</div><p class="text-dim">${escapeHtml(data.error)}</p>`;
    return;
  }

  const templates = Array.isArray(data) ? data : [];

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Bot Templates <span class="count">${templates.length}</span></div>
      <button class="btn btn-primary" id="tpl-create-btn">+ New Template</button>
    </div>
    ${
      templates.length === 0
        ? '<p class="text-dim">No templates yet. Create one to get started.</p>'
        : `<table>
        <thead><tr><th>Name</th><th>Description</th><th>Version</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody id="tpl-tbody"></tbody>
      </table>`
    }`;

  document.getElementById('tpl-create-btn').addEventListener('click', () => showCreateModal(el));

  if (templates.length === 0) return;

  const tbody = document.getElementById('tpl-tbody');
  for (const t of templates) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td><a href="#/baas/templates/${encodeURIComponent(t.id)}">${escapeHtml(t.name)}</a></td>
      <td class="text-dim">${escapeHtml(t.description || '—')}</td>
      <td>${t.version || 1}</td>
      <td class="text-dim">${t.createdAt ? timeAgo(t.createdAt) : '—'}</td>
      <td class="actions">
        <button class="btn btn-sm" data-action="edit" data-id="${escapeHtml(t.id)}">Edit</button>
        <button class="btn btn-sm" data-action="instantiate" data-id="${escapeHtml(t.id)}">Instantiate</button>
        <button class="btn btn-danger btn-sm" data-action="delete" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name)}">Delete</button>
      </td>`;
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON') return;
      location.hash = `#/baas/templates/${encodeURIComponent(t.id)}`;
    });
    tbody.appendChild(tr);
  }

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'edit') {
      const tpl = await api(`/api/baas/templates/${encodeURIComponent(id)}`);
      if (!tpl.error) showEditModal(el, tpl);
    } else if (action === 'instantiate') {
      showInstantiateModal(el, id);
    } else if (action === 'delete') {
      if (!confirm(`Delete template "${btn.dataset.name}"? This cannot be undone.`)) return;
      await api(`/api/baas/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
      renderBaasTemplates(el);
    }
  });
}

function showCreateModal(el) {
  showModal(`
    <div class="modal-title">New Template</div>
    <div class="form-group"><label>Name</label><input type="text" id="tpl-name"></div>
    <div class="form-group"><label>Description</label><input type="text" id="tpl-desc"></div>
    <div class="form-group"><label>System Prompt</label><textarea id="tpl-prompt" rows="4"></textarea></div>
    <div class="form-group"><label>Model</label><input type="text" id="tpl-model" placeholder="e.g. gpt-4o"></div>
    <div class="form-group"><label>Skills (comma-separated)</label><input type="text" id="tpl-skills"></div>
    <div class="form-group"><label>Temperature</label><input type="number" id="tpl-temp" step="0.1" min="0" max="2" value="0.7"></div>
    <div class="modal-actions">
      <button class="btn" id="tpl-cancel">Cancel</button>
      <button class="btn btn-primary" id="tpl-save">Create</button>
    </div>
  `);

  document.getElementById('tpl-cancel').addEventListener('click', closeModal);
  document.getElementById('tpl-save').addEventListener('click', async () => {
    const name = document.getElementById('tpl-name').value.trim();
    if (!name) return alert('Name is required');

    const config = {
      conversation: { systemPrompt: document.getElementById('tpl-prompt').value },
      model: document.getElementById('tpl-model').value.trim() || undefined,
      skills: document
        .getElementById('tpl-skills')
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      temperature: Number.parseFloat(document.getElementById('tpl-temp').value) || 0.7,
    };

    await api('/api/baas/templates', {
      method: 'POST',
      body: { name, description: document.getElementById('tpl-desc').value.trim(), config },
    });
    closeModal();
    renderBaasTemplates(el);
  });
}

function showEditModal(el, tpl) {
  const cfg = tpl.config || {};
  showModal(`
    <div class="modal-title">Edit Template</div>
    <div class="form-group"><label>Name</label><input type="text" id="tpl-name" value="${escapeHtml(tpl.name)}"></div>
    <div class="form-group"><label>Description</label><input type="text" id="tpl-desc" value="${escapeHtml(tpl.description || '')}"></div>
    <div class="form-group"><label>System Prompt</label><textarea id="tpl-prompt" rows="4">${escapeHtml(cfg.conversation?.systemPrompt || '')}</textarea></div>
    <div class="form-group"><label>Model</label><input type="text" id="tpl-model" value="${escapeHtml(cfg.model || '')}"></div>
    <div class="form-group"><label>Skills (comma-separated)</label><input type="text" id="tpl-skills" value="${escapeHtml((cfg.skills || []).join(', '))}"></div>
    <div class="form-group"><label>Temperature</label><input type="number" id="tpl-temp" step="0.1" min="0" max="2" value="${cfg.temperature ?? 0.7}"></div>
    <div class="modal-actions">
      <button class="btn" id="tpl-cancel">Cancel</button>
      <button class="btn btn-primary" id="tpl-save">Save</button>
    </div>
  `);

  document.getElementById('tpl-cancel').addEventListener('click', closeModal);
  document.getElementById('tpl-save').addEventListener('click', async () => {
    const name = document.getElementById('tpl-name').value.trim();
    if (!name) return alert('Name is required');

    const config = {
      conversation: { systemPrompt: document.getElementById('tpl-prompt').value },
      model: document.getElementById('tpl-model').value.trim() || undefined,
      skills: document
        .getElementById('tpl-skills')
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      temperature: Number.parseFloat(document.getElementById('tpl-temp').value) || 0.7,
    };

    await api(`/api/baas/templates/${encodeURIComponent(tpl.id)}`, {
      method: 'PUT',
      body: { name, description: document.getElementById('tpl-desc').value.trim(), config },
    });
    closeModal();
    renderBaasTemplates(el);
  });
}

function showInstantiateModal(el, templateId) {
  const ctx = import('./shared.js').then ? null : null; // avoid top-level await
  const tenantId = sessionStorage.getItem('auth_tenant_id') || '';

  showModal(`
    <div class="modal-title">Instantiate Template</div>
    <div class="form-group"><label>Tenant ID</label><input type="text" id="inst-tenant" value="${escapeHtml(tenantId)}"></div>
    <div class="form-group"><label>Bot ID</label><input type="text" id="inst-bot" placeholder="my-new-bot"></div>
    <div class="form-group"><label>Token</label><input type="text" id="inst-token" placeholder="Bot API token"></div>
    <div class="form-group"><label>Overrides (JSON, optional)</label><textarea id="inst-overrides" rows="3">{}</textarea></div>
    <div class="modal-actions">
      <button class="btn" id="inst-cancel">Cancel</button>
      <button class="btn btn-primary" id="inst-save">Instantiate</button>
    </div>
  `);

  document.getElementById('inst-cancel').addEventListener('click', closeModal);
  document.getElementById('inst-save').addEventListener('click', async () => {
    const botId = document.getElementById('inst-bot').value.trim();
    const token = document.getElementById('inst-token').value.trim();
    if (!botId || !token) return alert('Bot ID and Token are required');

    let overrides = {};
    try {
      overrides = JSON.parse(document.getElementById('inst-overrides').value || '{}');
    } catch {
      return alert('Invalid JSON in overrides');
    }

    const res = await api(`/api/baas/templates/${encodeURIComponent(templateId)}/instantiate`, {
      method: 'POST',
      body: {
        tenantId: document.getElementById('inst-tenant').value.trim(),
        botId,
        token,
        overrides,
      },
    });

    if (res.error) {
      alert(`Error: ${res.error}`);
    } else {
      closeModal();
      alert('Bot created successfully!');
      renderBaasTemplates(el);
    }
  });
}

/**
 * #/baas/templates/:id — Template detail
 */
export async function renderBaasTemplateDetail(el, id) {
  el.innerHTML = '<p class="text-dim">Loading...</p>';

  const tpl = await api(`/api/baas/templates/${encodeURIComponent(id)}`);
  if (tpl.error) {
    el.innerHTML = `<div class="detail-header"><a href="#/baas/templates" class="back">&larr;</a><span>Template not found</span></div><p class="text-dim">${escapeHtml(tpl.error)}</p>`;
    return;
  }

  const cfg = tpl.config || {};

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/baas/templates" class="back">&larr;</a>
      <span class="page-title" style="margin-bottom:0">${escapeHtml(tpl.name)}</span>
    </div>
    <div class="detail-card">
      <table>
        <tr><td class="text-dim" style="width:140px">ID</td><td>${escapeHtml(tpl.id)}</td></tr>
        <tr><td class="text-dim">Description</td><td>${escapeHtml(tpl.description || '—')}</td></tr>
        <tr><td class="text-dim">Version</td><td>${tpl.version || 1}</td></tr>
        <tr><td class="text-dim">Created By</td><td>${escapeHtml(tpl.createdBy || '—')}</td></tr>
        <tr><td class="text-dim">Created</td><td>${tpl.createdAt ? new Date(tpl.createdAt).toLocaleString() : '—'}</td></tr>
        <tr><td class="text-dim">Updated</td><td>${tpl.updatedAt ? new Date(tpl.updatedAt).toLocaleString() : '—'}</td></tr>
      </table>
    </div>
    <div class="detail-card">
      <div class="form-section-title">Configuration</div>
      <table>
        <tr><td class="text-dim" style="width:140px">Model</td><td>${escapeHtml(cfg.model || '—')}</td></tr>
        <tr><td class="text-dim">Temperature</td><td>${cfg.temperature ?? '—'}</td></tr>
        <tr><td class="text-dim">Skills</td><td>${(cfg.skills || []).map((s) => `<span class="badge badge-mcp">${escapeHtml(s)}</span>`).join(' ') || '—'}</td></tr>
        <tr><td class="text-dim">System Prompt</td><td style="white-space:pre-wrap">${escapeHtml(cfg.conversation?.systemPrompt || '—')}</td></tr>
      </table>
    </div>
    <div class="actions">
      <button class="btn" id="tpl-detail-edit">Edit</button>
      <button class="btn" id="tpl-detail-inst">Instantiate</button>
      <button class="btn btn-danger" id="tpl-detail-del">Delete</button>
    </div>`;

  document
    .getElementById('tpl-detail-edit')
    .addEventListener('click', () => showEditModal(el, tpl));
  document
    .getElementById('tpl-detail-inst')
    .addEventListener('click', () => showInstantiateModal(el, tpl.id));
  document.getElementById('tpl-detail-del').addEventListener('click', async () => {
    if (!confirm(`Delete template "${tpl.name}"?`)) return;
    await api(`/api/baas/templates/${encodeURIComponent(tpl.id)}`, { method: 'DELETE' });
    location.hash = '#/baas/templates';
  });
}
