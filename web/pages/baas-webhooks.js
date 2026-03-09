import {
  api,
  closeModal,
  escapeHtml,
  getAuthContext,
  resolveTenantId,
  showModal,
  timeAgo,
} from './shared.js';

const VALID_EVENTS = [
  'message.received',
  'message.sent',
  'bot.started',
  'bot.stopped',
  'bot.error',
  'usage.threshold',
];

function healthBadge(failCount) {
  if (failCount === 0) return '<span class="badge badge-ok">Healthy</span>';
  if (failCount <= 3)
    return '<span class="badge" style="background:rgba(251,191,36,0.15);color:var(--orange)">Degraded</span>';
  return '<span class="badge badge-error">Failing</span>';
}

/**
 * #/baas/webhooks — Webhook management
 */
export async function renderBaasWebhooks(el) {
  el.innerHTML =
    '<div class="page-title">Webhooks</div><div id="wh-tenant-picker"></div><p class="text-dim">Loading...</p>';

  const tenantId = await resolveTenantId(el.querySelector('#wh-tenant-picker'), () =>
    renderBaasWebhooks(el)
  );
  if (!tenantId) return;

  const data = await api(`/api/baas/webhooks/${encodeURIComponent(tenantId)}`);
  if (data.error) {
    el.innerHTML = `<div class="page-title">Webhooks</div><p class="text-dim">${escapeHtml(data.error)}</p>`;
    return;
  }

  const hooks = Array.isArray(data) ? data : [];

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Webhooks <span class="count">${hooks.length}</span></div>
      <button class="btn btn-primary" id="wh-create-btn">+ New Webhook</button>
    </div>
    ${
      hooks.length === 0
        ? '<p class="text-dim">No webhooks configured.</p>'
        : `<table>
        <thead><tr><th>URL</th><th>Events</th><th>Enabled</th><th>Health</th><th>Last Success</th><th>Last Fail</th><th>Actions</th></tr></thead>
        <tbody id="wh-tbody"></tbody>
      </table>`
    }`;

  document
    .getElementById('wh-create-btn')
    .addEventListener('click', () => showCreateModal(el, tenantId));

  if (hooks.length === 0) return;

  const tbody = document.getElementById('wh-tbody');
  for (const h of hooks) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(h.url)}">${escapeHtml(h.url)}</td>
      <td>${(h.events || []).map((e) => `<span class="badge badge-mcp">${escapeHtml(e)}</span>`).join(' ')}</td>
      <td>
        <label class="toggle">
          <input type="checkbox" ${h.enabled !== false ? 'checked' : ''} data-action="toggle" data-id="${escapeHtml(h.id)}">
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td>${healthBadge(h.failCount || 0)}</td>
      <td class="text-dim">${h.lastSuccess ? timeAgo(h.lastSuccess) : '—'}</td>
      <td class="text-dim">${h.lastFailure ? timeAgo(h.lastFailure) : '—'}</td>
      <td class="actions">
        <button class="btn btn-sm" data-action="edit" data-id="${escapeHtml(h.id)}">Edit</button>
        <button class="btn btn-danger btn-sm" data-action="delete" data-id="${escapeHtml(h.id)}" data-url="${escapeHtml(h.url)}">Delete</button>
      </td>`;
    tbody.appendChild(tr);
  }

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'toggle') {
      const enabled = btn.checked;
      await api(`/api/baas/webhooks/${encodeURIComponent(tenantId)}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: { enabled },
      });
    } else if (action === 'edit') {
      const hook = hooks.find((h) => h.id === id);
      if (hook) showEditModal(el, tenantId, hook);
    } else if (action === 'delete') {
      if (!confirm(`Delete webhook "${btn.dataset.url}"?`)) return;
      await api(`/api/baas/webhooks/${encodeURIComponent(tenantId)}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      renderBaasWebhooks(el);
    }
  });

  // Handle toggle change events separately (input change, not click)
  tbody.addEventListener('change', async (e) => {
    if (e.target.dataset.action === 'toggle') {
      const id = e.target.dataset.id;
      const enabled = e.target.checked;
      await api(`/api/baas/webhooks/${encodeURIComponent(tenantId)}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: { enabled },
      });
    }
  });
}

function eventsCheckboxes(selected = []) {
  return `<div class="checkbox-group" id="wh-events">${VALID_EVENTS.map((e) => {
    const checked = selected.includes(e);
    return `<label class="${checked ? 'checked' : ''}"><input type="checkbox" value="${e}" ${checked ? 'checked' : ''}>${e}</label>`;
  }).join('')}</div>`;
}

function wireCheckboxGroup() {
  for (const label of document.querySelectorAll('#wh-events label')) {
    const cb = label.querySelector('input');
    cb.addEventListener('change', () => label.classList.toggle('checked', cb.checked));
  }
}

function getSelectedEvents() {
  return Array.from(document.querySelectorAll('#wh-events input:checked')).map((cb) => cb.value);
}

function showCreateModal(el, tenantId) {
  showModal(`
    <div class="modal-title">New Webhook</div>
    <div class="form-group"><label>URL</label><input type="text" id="wh-url" placeholder="https://example.com/webhook"></div>
    <div class="form-group"><label>Events</label>${eventsCheckboxes()}</div>
    <div class="modal-actions">
      <button class="btn" id="wh-cancel">Cancel</button>
      <button class="btn btn-primary" id="wh-save">Create</button>
    </div>
  `);

  wireCheckboxGroup();
  document.getElementById('wh-cancel').addEventListener('click', closeModal);
  document.getElementById('wh-save').addEventListener('click', async () => {
    const url = document.getElementById('wh-url').value.trim();
    const events = getSelectedEvents();
    if (!url) return alert('URL is required');
    if (events.length === 0) return alert('Select at least one event');

    await api(`/api/baas/webhooks/${encodeURIComponent(tenantId)}`, {
      method: 'POST',
      body: { url, events },
    });
    closeModal();
    renderBaasWebhooks(el);
  });
}

function showEditModal(el, tenantId, hook) {
  showModal(`
    <div class="modal-title">Edit Webhook</div>
    <div class="form-group"><label>URL</label><input type="text" id="wh-url" value="${escapeHtml(hook.url)}"></div>
    <div class="form-group"><label>Events</label>${eventsCheckboxes(hook.events || [])}</div>
    <div class="modal-actions">
      <button class="btn" id="wh-cancel">Cancel</button>
      <button class="btn btn-primary" id="wh-save">Save</button>
    </div>
  `);

  wireCheckboxGroup();
  document.getElementById('wh-cancel').addEventListener('click', closeModal);
  document.getElementById('wh-save').addEventListener('click', async () => {
    const url = document.getElementById('wh-url').value.trim();
    const events = getSelectedEvents();
    if (!url) return alert('URL is required');
    if (events.length === 0) return alert('Select at least one event');

    await api(`/api/baas/webhooks/${encodeURIComponent(tenantId)}/${encodeURIComponent(hook.id)}`, {
      method: 'PUT',
      body: { url, events },
    });
    closeModal();
    renderBaasWebhooks(el);
  });
}
