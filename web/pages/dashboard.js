import { api, escapeHtml, timeAgo } from './shared.js';

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function statusBadge(status) {
  const cls = status === 'completed' ? 'badge-ok'
    : status === 'error' ? 'badge-error'
    : 'badge-disabled';
  return `<span class="badge ${cls}">${status}</span>`;
}

function renderToolCallsTable(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return '';
  return toolCalls.map(tc => {
    const badge = tc.success
      ? '<span class="badge badge-ok">OK</span>'
      : '<span class="badge badge-error">FAIL</span>';
    const argsStr = JSON.stringify(tc.args || {}, null, 2);
    return `<div class="tool-call-item">
      <div class="tool-call-header">
        <span style="font-family:monospace;font-weight:600">${escapeHtml(tc.name)}</span> ${badge}
      </div>
      <details class="tool-call-details">
        <summary class="text-dim text-sm">Args</summary>
        <pre>${escapeHtml(argsStr)}</pre>
      </details>
      <details class="tool-call-details" ${!tc.success ? 'open' : ''}>
        <summary class="text-dim text-sm">Result</summary>
        <pre>${escapeHtml(tc.result || '')}</pre>
      </details>
    </div>`;
  }).join('');
}

function renderDetailRow(r, colspan) {
  const sections = [];

  if (r.plannerReasoning) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Planner Reasoning</div>
      <pre>${escapeHtml(r.plannerReasoning)}</pre>
    </div>`);
  }

  if (r.plan && r.plan.length > 0) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Plan</div>
      <ol style="margin:0;padding-left:20px;font-size:13px">${r.plan.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
    </div>`);
  }

  if (r.toolCalls && r.toolCalls.length > 0) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Tool Calls (${r.toolCalls.length})</div>
      ${renderToolCallsTable(r.toolCalls)}
    </div>`);
  }

  sections.push(`<div class="result-section">
    <div class="result-section-title">Full Summary</div>
    <pre>${escapeHtml(r.summary || '')}</pre>
  </div>`);

  return `<tr class="result-detail"><td colspan="${colspan}">${sections.join('')}</td></tr>`;
}

function renderResultsTable(results) {
  if (!results || results.length === 0) {
    return '<p class="text-dim text-sm mt-8">No results yet</p>';
  }
  return `
    <table class="results-table">
      <thead><tr><th>Bot</th><th>Status</th><th>Time</th><th>Summary</th></tr></thead>
      <tbody>
        ${results.map((r, i) => `
          <tr class="result-row" data-idx="${i}">
            <td>${escapeHtml(r.botName)}</td>
            <td>${statusBadge(r.status)}</td>
            <td class="text-dim">${formatDuration(r.durationMs)}</td>
            <td class="text-dim text-sm" style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.summary?.slice(0, 120) || '')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function attachResultRowListeners(container, results) {
  const rows = container.querySelectorAll('.result-row');
  rows.forEach(row => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.idx, 10);
      const existing = row.nextElementSibling;
      const isOpen = existing && existing.classList.contains('result-detail');

      // Collapse any open detail row
      container.querySelectorAll('.result-detail').forEach(el => el.remove());

      // If clicking the same row that was open, just close it
      if (isOpen) return;

      // Insert detail row after clicked row
      row.insertAdjacentHTML('afterend', renderDetailRow(results[idx], 4));
    });
  });
}

export async function renderDashboard(el) {
  el.innerHTML = '<div class="page-title">Dashboard</div><p class="text-dim">Loading...</p>';

  const [loopState, statusData] = await Promise.all([
    api('/api/agent-loop'),
    api('/api/status'),
  ]);

  const enabledBadge = loopState.enabled
    ? '<span class="badge badge-running">Enabled</span>'
    : '<span class="badge badge-stopped">Disabled</span>';

  const nextRunText = loopState.nextRunAt
    ? timeAgo(loopState.nextRunAt, true)
    : '--';

  const lastRunText = loopState.lastRunAt
    ? new Date(loopState.lastRunAt).toLocaleString()
    : 'Never';

  const runningBadge = loopState.running
    ? '<span class="badge badge-ok" style="margin-left:8px">Running</span>'
    : '';

  el.innerHTML = `
    <div class="page-title">Dashboard</div>

    <div class="detail-card">
      <div class="flex-between mb-16">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-weight:600;font-size:16px">Agent Loop</span>
          ${enabledBadge}
          ${runningBadge}
        </div>
        <button class="btn btn-primary" id="btn-run-now" ${loopState.running ? 'disabled' : ''}>Run Now</button>
      </div>
      <div style="display:flex;gap:24px;font-size:13px;color:var(--text-dim);margin-bottom:16px">
        <span>Every: <strong style="color:var(--text)">${escapeHtml(loopState.every || '--')}</strong></span>
        <span>Next run: <strong style="color:var(--text)">${nextRunText}</strong></span>
        <span>Last run: <strong style="color:var(--text)">${lastRunText}</strong></span>
      </div>

      <div id="loop-results">
        ${loopState.lastResults?.length
          ? `<div class="text-dim text-sm mb-16" style="font-weight:500">Last Results</div>${renderResultsTable(loopState.lastResults)}`
          : '<p class="text-dim text-sm">No runs recorded yet</p>'
        }
      </div>
    </div>

    <div class="detail-card">
      <div style="font-weight:600;font-size:16px;margin-bottom:12px">System</div>
      <div style="display:flex;gap:24px;font-size:13px;color:var(--text-dim)">
        <span>Bots: <strong style="color:var(--text)">${statusData.bots?.running ?? 0}/${statusData.bots?.configured ?? 0} running</strong></span>
        <span>Skills: <strong style="color:var(--text)">${statusData.skills?.loaded ?? 0}</strong></span>
      </div>
    </div>
  `;

  // Attach expand listeners for initial results
  if (loopState.lastResults?.length) {
    attachResultRowListeners(document.getElementById('loop-results'), loopState.lastResults);
  }

  // Run Now button
  const runBtn = document.getElementById('btn-run-now');
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    runBtn.textContent = 'Running...';
    const resultsDiv = document.getElementById('loop-results');
    resultsDiv.innerHTML = '<p class="text-dim text-sm">Executing agent loop for all bots...</p>';

    try {
      const res = await api('/api/agent-loop/run', { method: 'POST' });
      if (res.error) {
        resultsDiv.innerHTML = `<p class="text-dim text-sm" style="color:var(--red)">Error: ${escapeHtml(res.error)}</p>`;
      } else {
        resultsDiv.innerHTML =
          `<div class="text-dim text-sm mb-16" style="font-weight:500">Last Results</div>` +
          renderResultsTable(res.results);
        attachResultRowListeners(resultsDiv, res.results);
      }
    } catch (err) {
      resultsDiv.innerHTML = `<p class="text-dim text-sm" style="color:var(--red)">Failed: ${escapeHtml(err.message)}</p>`;
    }

    runBtn.disabled = false;
    runBtn.textContent = 'Run Now';
  });
}
