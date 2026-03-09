import { api, closeModal, escapeHtml, getAuthContext, showModal, timeAgo } from './shared.js';

const VALID_PLANS = ['free', 'starter', 'pro', 'enterprise'];
const PLAN_RATE_LIMITS = { free: 30, starter: 60, pro: 200, enterprise: 500 };

function planBadge(plan) {
  const colors = {
    free: 'var(--text-dim)',
    starter: 'var(--green)',
    pro: 'var(--accent)',
    enterprise: 'var(--orange)',
  };
  const color = colors[plan] || 'var(--text-dim)';
  return `<span class="badge" style="background:${color}20;color:${color}">${escapeHtml(plan)}</span>`;
}

/**
 * #/baas/tenants — Admin tenant management
 */
export async function renderBaasTenants(el) {
  const { role } = getAuthContext();
  if (role === 'tenant') {
    el.innerHTML = '<p class="text-dim">Access denied.</p>';
    return;
  }

  el.innerHTML = '<div class="page-title">Tenants</div><p class="text-dim">Loading...</p>';

  const data = await api('/api/admin/tenants');
  const tenants = Array.isArray(data?.tenants) ? data.tenants : Array.isArray(data) ? data : [];

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Tenants <span class="count">${tenants.length}</span></div>
    </div>
    ${
      tenants.length === 0
        ? '<p class="text-dim">No tenants registered.</p>'
        : `<table>
        <thead><tr><th>Name</th><th>Email</th><th>Plan</th><th>Rate Limit</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody id="tenants-tbody"></tbody>
      </table>`
    }`;

  if (tenants.length === 0) return;

  const tbody = document.getElementById('tenants-tbody');

  for (const t of tenants) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td class="text-dim">${escapeHtml(t.email)}</td>
      <td>${planBadge(t.plan)}</td>
      <td class="text-dim">${t.rateLimitOverride ? `<strong>${t.rateLimitOverride}</strong> req/min (override)` : `${t.effectiveRateLimit || PLAN_RATE_LIMITS[t.plan] || '—'} req/min (plan)`}</td>
      <td class="text-dim">${timeAgo(t.createdAt)}</td>
      <td class="actions">
        <button class="btn btn-sm" data-action="detail" data-id="${escapeHtml(t.id)}">View</button>
        <button class="btn btn-sm" data-action="plan" data-id="${escapeHtml(t.id)}" data-plan="${escapeHtml(t.plan)}">Plan</button>
        <button class="btn btn-sm" data-action="rate-limit" data-id="${escapeHtml(t.id)}" data-plan="${escapeHtml(t.plan)}" data-override="${t.rateLimitOverride ?? ''}">Rate Limit</button>
        <button class="btn btn-danger btn-sm" data-action="delete" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name)}">Delete</button>
      </td>`;
    tbody.appendChild(tr);
  }

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'detail') {
      showDetailModal(id);
    } else if (action === 'plan') {
      showPlanModal(el, id, btn.dataset.plan);
    } else if (action === 'rate-limit') {
      showRateLimitModal(el, id, btn.dataset.plan, btn.dataset.override);
    } else if (action === 'delete') {
      if (!confirm(`Delete tenant "${btn.dataset.name}"? This cannot be undone.`)) return;
      await api(`/api/admin/tenants/${encodeURIComponent(id)}`, { method: 'DELETE' });
      renderBaasTenants(el);
    }
  });
}

async function showDetailModal(tenantId) {
  const data = await api(`/api/admin/tenants/${encodeURIComponent(tenantId)}`);
  const t = data.tenant || data;

  if (data.error) {
    showModal(
      `<div class="modal-title">Error</div><p>${escapeHtml(data.error)}</p><div class="modal-actions"><button class="btn" id="dm-close">Close</button></div>`
    );
    document.getElementById('dm-close').addEventListener('click', closeModal);
    return;
  }

  const usage = t.currentUsage || {};
  const quota = t.usageQuota || {};

  showModal(`
    <div class="modal-title">${escapeHtml(t.name)}</div>
    <table style="font-size:13px;margin-bottom:12px">
      <tr><td class="text-dim" style="padding:4px 12px 4px 0">ID</td><td style="padding:4px 0;font-family:monospace;font-size:12px">${escapeHtml(t.id)}</td></tr>
      <tr><td class="text-dim" style="padding:4px 12px 4px 0">Email</td><td style="padding:4px 0">${escapeHtml(t.email)}</td></tr>
      <tr><td class="text-dim" style="padding:4px 12px 4px 0">Plan</td><td style="padding:4px 0">${planBadge(t.plan)}</td></tr>
      <tr><td class="text-dim" style="padding:4px 12px 4px 0">Rate Limit</td><td style="padding:4px 0">${t.rateLimitOverride != null ? `<strong>${t.rateLimitOverride}</strong> req/min (override)` : `${t.effectiveRateLimit || '—'} req/min (plan default)`}</td></tr>
      <tr><td class="text-dim" style="padding:4px 12px 4px 0">Effective Rate</td><td style="padding:4px 0">${t.effectiveRateLimit || '—'} req/min</td></tr>
      <tr><td class="text-dim" style="padding:4px 12px 4px 0">Created</td><td style="padding:4px 0">${escapeHtml(t.createdAt)}</td></tr>
    </table>
    ${
      quota.messagesPerMonth
        ? `
    <div class="form-section-title">Usage (this month)</div>
    <table style="font-size:13px">
      <tr><td class="text-dim" style="padding:4px 12px 4px 0">Messages</td><td style="padding:4px 0">${usage.messages ?? 0} / ${quota.messagesPerMonth}</td></tr>
      <tr><td class="text-dim" style="padding:4px 12px 4px 0">API Calls</td><td style="padding:4px 0">${usage.apiCalls ?? 0} / ${quota.apiCallsPerMonth}</td></tr>
    </table>`
        : ''
    }
    <div class="modal-actions"><button class="btn" id="dm-close">Close</button></div>
  `);

  document.getElementById('dm-close').addEventListener('click', closeModal);
}

function showPlanModal(el, tenantId, currentPlan) {
  showModal(`
    <div class="modal-title">Change Plan</div>
    <div class="form-group">
      <label>Plan</label>
      <select id="plan-select">
        ${VALID_PLANS.map((p) => `<option value="${p}"${p === currentPlan ? ' selected' : ''}>${p}</option>`).join('')}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn" id="plan-cancel">Cancel</button>
      <button class="btn btn-primary" id="plan-save">Save</button>
    </div>
  `);

  document.getElementById('plan-cancel').addEventListener('click', closeModal);
  document.getElementById('plan-save').addEventListener('click', async () => {
    const plan = document.getElementById('plan-select').value;
    const res = await api(`/api/admin/tenants/${encodeURIComponent(tenantId)}/plan`, {
      method: 'PATCH',
      body: { plan },
    });
    if (res.error) return alert(res.error);
    closeModal();
    renderBaasTenants(el);
  });
}

function showRateLimitModal(el, tenantId, plan, currentOverride) {
  const planDefault = PLAN_RATE_LIMITS[plan] || 30;
  const presets = [60, 100, 200, 500].filter((v) => v !== planDefault);
  const overrideVal = currentOverride ? Number.parseInt(currentOverride, 10) : null;
  const isCustom = overrideVal && !presets.includes(overrideVal);

  // Determine initial selected value
  let selectedValue = '';
  if (!overrideVal) {
    selectedValue = 'default';
  } else if (presets.includes(overrideVal)) {
    selectedValue = String(overrideVal);
  } else {
    selectedValue = 'custom';
  }

  showModal(`
    <div class="modal-title">Rate Limit Override</div>
    <p class="text-dim text-sm" style="margin-bottom:12px">Set a custom rate limit for this tenant, or use the plan default.</p>
    <div class="form-group">
      <label>Max Requests / Minute</label>
      <select id="rl-select" style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px">
        <option value="default"${selectedValue === 'default' ? ' selected' : ''}>Plan default (${planDefault} req/min)</option>
        ${presets.map((v) => `<option value="${v}"${selectedValue === String(v) ? ' selected' : ''}>${v} req/min</option>`).join('')}
        <option value="custom"${selectedValue === 'custom' ? ' selected' : ''}>Custom...</option>
      </select>
    </div>
    <div class="form-group" id="rl-custom-group" style="display:${selectedValue === 'custom' ? 'block' : 'none'}">
      <label>Custom Value</label>
      <input type="number" id="rl-custom-value" min="1" step="1" placeholder="e.g. 150" value="${isCustom ? overrideVal : ''}">
    </div>
    <div class="modal-actions">
      ${overrideVal ? '<button class="btn btn-danger btn-sm" id="rl-clear" style="margin-right:auto">Clear Override</button>' : ''}
      <button class="btn" id="rl-cancel">Cancel</button>
      <button class="btn btn-primary" id="rl-save">Save</button>
    </div>
  `);

  const select = document.getElementById('rl-select');
  const customGroup = document.getElementById('rl-custom-group');

  select.addEventListener('change', () => {
    customGroup.style.display = select.value === 'custom' ? 'block' : 'none';
  });

  document.getElementById('rl-cancel').addEventListener('click', closeModal);

  document.getElementById('rl-clear')?.addEventListener('click', async () => {
    const res = await api(`/api/admin/tenants/${encodeURIComponent(tenantId)}/rate-limit`, {
      method: 'PATCH',
      body: { maxRequestsPerMinute: null },
    });
    if (res.error) return alert(res.error);
    closeModal();
    renderBaasTenants(el);
  });

  document.getElementById('rl-save').addEventListener('click', async () => {
    const choice = select.value;

    if (choice === 'default') {
      // Clear override — use plan default
      const res = await api(`/api/admin/tenants/${encodeURIComponent(tenantId)}/rate-limit`, {
        method: 'PATCH',
        body: { maxRequestsPerMinute: null },
      });
      if (res.error) return alert(res.error);
      closeModal();
      renderBaasTenants(el);
      return;
    }

    let val;
    if (choice === 'custom') {
      const raw = document.getElementById('rl-custom-value').value.trim();
      if (!raw) return alert('Enter a custom value.');
      val = Number.parseInt(raw, 10);
      if (Number.isNaN(val) || val <= 0) return alert('Must be a positive integer.');
    } else {
      val = Number.parseInt(choice, 10);
    }

    const res = await api(`/api/admin/tenants/${encodeURIComponent(tenantId)}/rate-limit`, {
      method: 'PATCH',
      body: { maxRequestsPerMinute: val },
    });
    if (res.error) return alert(res.error);
    closeModal();
    renderBaasTenants(el);
  });
}
