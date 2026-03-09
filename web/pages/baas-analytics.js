import { api, escapeHtml, getAuthContext, resolveTenantId } from './shared.js';

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function today() {
  return new Date();
}

function formatPct(n) {
  if (n == null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function renderBarChart(data, labelKey, valueKey) {
  if (!data) return '<p class="text-dim text-sm">No data</p>';

  // Normalize: backend returns Record<string, number>, convert to array
  let rows;
  if (Array.isArray(data)) {
    rows = data;
  } else if (typeof data === 'object') {
    rows = Object.entries(data)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => ({ [labelKey]: k, [valueKey]: v }));
  } else {
    return '<p class="text-dim text-sm">No data</p>';
  }

  if (rows.length === 0) return '<p class="text-dim text-sm">No data</p>';
  const max = Math.max(...rows.map((d) => d[valueKey] || 0), 1);
  return `<div class="bar-chart">${rows
    .map((d) => {
      const val = d[valueKey] || 0;
      const height = Math.max((val / max) * 200, 2);
      const label = (d[labelKey] || '').slice(5); // MM-DD from YYYY-MM-DD
      return `<div class="bar-col">
      <div class="bar-value">${val}</div>
      <div class="bar-fill" style="height:${height}px"></div>
      <div class="bar-label">${escapeHtml(label)}</div>
    </div>`;
    })
    .join('')}</div>`;
}

function renderBreakdownTable(data, keyLabel, valueLabel) {
  if (!data || Object.keys(data).length === 0) return '<p class="text-dim text-sm">No data</p>';
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  return `<table>
    <thead><tr><th>${escapeHtml(keyLabel)}</th><th>${escapeHtml(valueLabel)}</th></tr></thead>
    <tbody>${entries.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join('')}</tbody>
  </table>`;
}

/**
 * #/baas/analytics — Analytics dashboard
 */
export async function renderBaasAnalytics(el) {
  el.innerHTML =
    '<div class="page-title">Analytics</div><div id="an-tenant-picker"></div><p class="text-dim">Loading...</p>';

  const tenantId = await resolveTenantId(el.querySelector('#an-tenant-picker'), () =>
    renderBaasAnalytics(el)
  );
  if (!tenantId) return;

  let startDate = formatDate(monthStart());
  let endDate = formatDate(today());
  let selectedBotId = '';
  let metrics = null;

  // Load bot list for filter
  const agents = await api('/api/agents');
  const bots = Array.isArray(agents) ? agents : agents?.bots || [];

  async function loadMetrics() {
    if (selectedBotId) {
      metrics = await api(
        `/api/baas/analytics/${encodeURIComponent(tenantId)}/${encodeURIComponent(selectedBotId)}?start=${startDate}&end=${endDate}`
      );
    } else {
      metrics = await api(
        `/api/baas/analytics/${encodeURIComponent(tenantId)}?start=${startDate}&end=${endDate}`
      );
    }
  }

  async function loadCurrentMonth() {
    startDate = formatDate(monthStart());
    endDate = formatDate(today());
    selectedBotId = '';
    metrics = await api(`/api/baas/analytics/${encodeURIComponent(tenantId)}/current-month`);
    render();
  }

  function render() {
    let html = `
      <div class="page-title">Analytics</div>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:20px;flex-wrap:wrap">
        <div class="form-group" style="margin-bottom:0"><label>Start</label><input type="date" id="an-start" value="${startDate}"></div>
        <div class="form-group" style="margin-bottom:0"><label>End</label><input type="date" id="an-end" value="${endDate}"></div>
        <select id="an-bot-select" style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);margin-top:16px">
          <option value="">All Bots</option>
          ${bots.map((b) => `<option value="${escapeHtml(b.id)}"${b.id === selectedBotId ? ' selected' : ''}>${escapeHtml(b.name || b.id)}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-sm" id="an-apply" style="margin-top:16px">Apply</button>
        <button class="btn btn-sm" id="an-this-month" style="margin-top:16px">This Month</button>
      </div>`;

    if (!metrics || metrics.error) {
      html += `<p class="text-dim">${metrics?.error ? escapeHtml(metrics.error) : 'Loading...'}</p>`;
      el.innerHTML = html;
      wireControls();
      return;
    }

    const m = metrics;

    // Overview cards
    html += `<div class="analytics-cards">
      <div class="analytics-card">
        <div class="analytics-card-value">${m.totalConversations ?? 0}</div>
        <div class="analytics-card-label">Conversations</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${m.totalMessages ?? 0}</div>
        <div class="analytics-card-label">Messages</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${m.uniqueUsers ?? 0}</div>
        <div class="analytics-card-label">Unique Users</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-card-value">${formatPct(m.resolutionRate)}</div>
        <div class="analytics-card-label">Resolution Rate</div>
      </div>
    </div>`;

    // Bar charts
    if (m.messagesPerDay || m.conversationsPerDay) {
      html += '<div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:24px">';
      if (m.messagesPerDay) {
        html += `<div style="flex:1;min-width:300px">
          <div class="form-section-title">Messages per Day</div>
          ${renderBarChart(m.messagesPerDay, 'date', 'count')}
        </div>`;
      }
      if (m.conversationsPerDay) {
        html += `<div style="flex:1;min-width:300px">
          <div class="form-section-title">Conversations per Day</div>
          ${renderBarChart(m.conversationsPerDay, 'date', 'count')}
        </div>`;
      }
      html += '</div>';
    }

    // Breakdown tables
    if (m.messagesByChannel || m.toolUsage || m.errorsByType) {
      html += '<div style="display:flex;gap:24px;flex-wrap:wrap">';
      if (m.messagesByChannel) {
        html += `<div style="flex:1;min-width:250px">
          <div class="form-section-title">Messages by Channel</div>
          ${renderBreakdownTable(m.messagesByChannel, 'Channel', 'Count')}
        </div>`;
      }
      if (m.toolUsage) {
        html += `<div style="flex:1;min-width:250px">
          <div class="form-section-title">Tool Usage</div>
          ${renderBreakdownTable(m.toolUsage, 'Tool', 'Count')}
        </div>`;
      }
      if (m.errorsByType) {
        html += `<div style="flex:1;min-width:250px">
          <div class="form-section-title">Errors by Type</div>
          ${renderBreakdownTable(m.errorsByType, 'Error', 'Count')}
        </div>`;
      }
      html += '</div>';
    }

    el.innerHTML = html;
    wireControls();
  }

  function wireControls() {
    document.getElementById('an-apply')?.addEventListener('click', async () => {
      startDate = document.getElementById('an-start').value;
      endDate = document.getElementById('an-end').value;
      selectedBotId = document.getElementById('an-bot-select').value;
      await loadMetrics();
      render();
    });

    document.getElementById('an-this-month')?.addEventListener('click', () => loadCurrentMonth());

    document.getElementById('an-bot-select')?.addEventListener('change', async (e) => {
      selectedBotId = e.target.value;
      await loadMetrics();
      render();
    });
  }

  // Initial load: current month
  await loadCurrentMonth();
}
