import { confirmDialog, showToast } from '../ui/index.js';
import { rememberTenant, restoreTenant } from './baas-helpers.js';
import {
  api,
  closeModal,
  escapeHtml,
  getAuthContext,
  resolveTenantId,
  showModal,
  timeAgo,
} from './shared.js';

/** Toast + focus for a modal field that failed validation. */
function invalid(inputId, message) {
  showToast(message, { tone: 'warn' });
  if (inputId) document.getElementById(inputId)?.focus();
}

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
 * #/settings/baas/webhooks — Webhook management
 */
export async function renderBaasWebhooks(el) {
  el.innerHTML =
    '<div class="page-title">Webhooks</div><div id="wh-tenant-picker"></div><p class="text-dim">Loading...</p>';

  restoreTenant(); // admin's tenant pick survives reloads and is shared by every BaaS page
  const tenantId = await resolveTenantId(el.querySelector('#wh-tenant-picker'), () =>
    renderBaasWebhooks(el)
  );
  if (!tenantId) return;
  rememberTenant(tenantId);

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

    // The enable toggle is handled by the 'change' listener below; handling it
    // here too sent every PUT twice.
    if (action === 'edit') {
      const hook = hooks.find((h) => h.id === id);
      if (hook) showEditModal(el, tenantId, hook);
    } else if (action === 'delete') {
      const ok = await confirmDialog({
        title: 'Delete webhook?',
        message: `Delete webhook "${btn.dataset.url}"? Deliveries to it stop immediately.`,
        confirmLabel: 'Delete',
      });
      if (!ok) return;
      const res = await api(
        `/api/baas/webhooks/${encodeURIComponent(tenantId)}/${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      if (res?.error) return showToast(`Delete failed: ${res.error}`, { tone: 'danger' });
      showToast('Webhook deleted', { tone: 'ok' });
      renderBaasWebhooks(el);
    }
  });

  // Handle toggle change events separately (input change, not click)
  tbody.addEventListener('change', async (e) => {
    if (e.target.dataset.action === 'toggle') {
      const id = e.target.dataset.id;
      const enabled = e.target.checked;
      const res = await api(
        `/api/baas/webhooks/${encodeURIComponent(tenantId)}/${encodeURIComponent(id)}`,
        { method: 'PUT', body: { enabled } }
      );
      if (res?.error) {
        e.target.checked = !enabled;
        showToast(`Update failed: ${res.error}`, { tone: 'danger' });
      }
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
    if (!url) return invalid('wh-url', 'URL is required.');
    if (events.length === 0) return invalid(null, 'Select at least one event.');

    const res = await api(`/api/baas/webhooks/${encodeURIComponent(tenantId)}`, {
      method: 'POST',
      body: { url, events },
    });
    if (res?.error) return showToast(`Create failed: ${res.error}`, { tone: 'danger' });
    closeModal();
    showToast('Webhook created', { tone: 'ok' });
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
    if (!url) return invalid('wh-url', 'URL is required.');
    if (events.length === 0) return invalid(null, 'Select at least one event.');

    const res = await api(
      `/api/baas/webhooks/${encodeURIComponent(tenantId)}/${encodeURIComponent(hook.id)}`,
      { method: 'PUT', body: { url, events } }
    );
    if (res?.error) return showToast(`Save failed: ${res.error}`, { tone: 'danger' });
    closeModal();
    showToast('Webhook saved', { tone: 'ok' });
    renderBaasWebhooks(el);
  });
}
