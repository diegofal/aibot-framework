import { api, escapeHtml, timeAgo } from './shared.js';

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function statusBadge(status) {
  const cls =
    status === 'completed' ? 'badge-ok' : status === 'error' ? 'badge-error' : 'badge-disabled';
  return `<span class="badge ${cls}">${status}</span>`;
}

function modeBadge(mode) {
  if (mode === 'continuous') {
    return '<span class="badge badge-ok">continuous</span>';
  }
  return '<span class="badge badge-disabled">periodic</span>';
}

function renderToolCallsTable(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return '';
  return toolCalls
    .map((tc) => {
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
    })
    .join('');
}

function renderDetailRow(r, colspan) {
  const sections = [];

  if (r.strategistRan) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Strategist</div>
      ${r.focus ? `<div style="margin-bottom:6px"><strong>Focus:</strong> ${escapeHtml(r.focus)}</div>` : ''}
      ${r.strategistReflection ? `<pre>${escapeHtml(r.strategistReflection)}</pre>` : ''}
    </div>`);
  }

  if (r.plannerReasoning) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Planner Reasoning</div>
      <pre>${escapeHtml(r.plannerReasoning)}</pre>
    </div>`);
  }

  if (r.plan && r.plan.length > 0) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Plan</div>
      <ol style="margin:0;padding-left:20px;font-size:13px">${r.plan.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
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
      <thead><tr><th>Bot</th><th>Status</th><th>Time</th><th>Summary</th><th></th></tr></thead>
      <tbody>
        ${results
          .map(
            (r, i) => `
          <tr class="result-row" data-idx="${i}" data-bot-id="${escapeHtml(r.botId || '')}">
            <td>${escapeHtml(r.botName)}</td>
            <td>${statusBadge(r.status)}${r.retryAttempt > 0 ? ` <span class="badge badge-error" style="font-size:10px">retry #${r.retryAttempt}</span>` : ''}</td>
            <td class="text-dim">${formatDuration(r.durationMs)}</td>
            <td class="text-dim text-sm" style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.summary?.slice(0, 120) || '')}</td>
            <td>${r.status === 'error' ? '<button class="btn btn-sm btn-retry">Retry</button>' : ''}</td>
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function showRowError(row, message) {
  const errorTr = document.createElement('tr');
  errorTr.className = 'retry-error-row';
  errorTr.innerHTML = `<td colspan="5" style="padding:6px 12px;border-bottom:1px solid var(--border)"><span style="color:var(--red);font-size:12px">${escapeHtml(message)}</span></td>`;
  row.insertAdjacentElement('afterend', errorTr);
  setTimeout(() => errorTr.remove(), 5000);
}

function updateResultRow(tr, result, idx) {
  tr.dataset.idx = idx;
  tr.dataset.botId = result.botId || '';
  const cells = tr.querySelectorAll('td');
  cells[0].textContent = result.botName;
  cells[1].innerHTML = statusBadge(result.status);
  cells[2].textContent = formatDuration(result.durationMs);
  cells[3].textContent = result.summary?.slice(0, 120) || '';
  cells[4].innerHTML =
    result.status === 'error' ? '<button class="btn btn-sm btn-retry">Retry</button>' : '';
}

function attachResultRowListeners(container, results) {
  const rows = container.querySelectorAll('.result-row');
  rows.forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.btn-retry')) return;
      const idx = Number.parseInt(row.dataset.idx, 10);
      const existing = row.nextElementSibling;
      const isOpen = existing?.classList.contains('result-detail');

      // Collapse any open detail row
      container.querySelectorAll('.result-detail').forEach((el) => el.remove());

      // If clicking the same row that was open, just close it
      if (isOpen) return;

      // Insert detail row after clicked row
      row.insertAdjacentHTML('afterend', renderDetailRow(results[idx], 5));
    });
  });
}

function attachRetryListeners(container, results) {
  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-retry');
    if (!btn) return;
    const row = btn.closest('tr.result-row');
    if (!row) return;
    const idx = Number.parseInt(row.dataset.idx, 10);
    const botId = row.dataset.botId;
    if (!botId) return;

    btn.disabled = true;
    btn.textContent = 'Running...';

    // Remove any existing error rows for this row
    const nextEl = row.nextElementSibling;
    if (nextEl?.classList.contains('retry-error-row')) nextEl.remove();

    try {
      const res = await api(`/api/agent-loop/run/${encodeURIComponent(botId)}`, { method: 'POST' });
      if (res.error) {
        btn.disabled = false;
        btn.textContent = 'Retry';
        showRowError(row, res.error);
        return;
      }
      // Update the results array so expanded details reflect new data
      results[idx] = res.result;
      updateResultRow(row, res.result, idx);

      // Collapse any open detail row for this result
      const detail = row.nextElementSibling;
      if (detail?.classList.contains('result-detail')) detail.remove();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Retry';
      showRowError(row, err.message || 'Request failed');
    }
  });
}

export async function renderDashboard(el) {
  el.innerHTML = '<div class="page-title">Dashboard</div><p class="text-dim">Loading...</p>';

  const [loopState, statusData, inboxData] = await Promise.all([
    api('/api/agent-loop'),
    api('/api/status'),
    api('/api/ask-human/count'),
  ]);

  const enabledBadge = loopState.enabled
    ? '<span class="badge badge-running">Enabled</span>'
    : '<span class="badge badge-stopped">Disabled</span>';

  const nextRunText = loopState.nextRunAt ? timeAgo(loopState.nextRunAt, true) : '--';

  const lastRunText = loopState.lastRunAt
    ? new Date(loopState.lastRunAt).toLocaleString()
    : 'Never';

  const runningBadge = loopState.running
    ? '<span class="badge badge-ok" style="margin-left:8px">Running</span>'
    : '';

  const drainingBadge = loopState.draining
    ? '<span class="badge badge-draining"><span class="processing-pulse"></span> Draining...</span>'
    : '';

  const inboxCount = inboxData.count ?? 0;
  const inboxBanner =
    inboxCount > 0
      ? `<div class="inbox-pending-banner">
        <span>Pending Input (${inboxCount}) — Bots are waiting for your input.</span>
        <a href="#/inbox" class="btn btn-sm">View Inbox</a>
      </div>`
      : '';

  el.innerHTML = `
    <div class="page-title">Dashboard</div>

    ${inboxBanner}

    <div class="detail-card">
      <div class="flex-between mb-16">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-weight:600;font-size:16px">Agent Loop</span>
          ${enabledBadge}
          ${runningBadge}
          ${drainingBadge}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" id="btn-run-now" ${loopState.running ? 'disabled' : ''}>Run Now</button>
          ${loopState.enabled || loopState.draining ? `<button class="btn btn-danger" id="btn-stop-safe" ${loopState.draining ? 'disabled' : ''}>${loopState.draining ? 'Draining...' : 'Stop All Safe'}</button>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:24px;font-size:13px;color:var(--text-dim);margin-bottom:16px">
        <span>Default Interval: <strong style="color:var(--text)">${escapeHtml(loopState.defaultInterval || '--')}</strong></span>
        <span>Next run: <strong style="color:var(--text)">${nextRunText}</strong></span>
        <span>Last run: <strong style="color:var(--text)">${lastRunText}</strong></span>
      </div>

      ${
        loopState.botSchedules?.length
          ? `
        <div class="text-dim text-sm mb-16" style="font-weight:500">Bot Schedules</div>
        <table class="results-table" style="margin-bottom:16px">
          <thead><tr><th>Bot</th><th>Mode</th><th>Activity</th><th>Next Run</th><th>Last Run</th><th>Next Check-In</th><th>Last Status</th><th>Retries</th><th>Strategist</th></tr></thead>
          <tbody>
            ${loopState.botSchedules
              .map((s) => {
                const isContinuous = s.mode === 'continuous';
                const stratInfo = s.lastFocus
                  ? `<span class="text-dim text-sm" title="${escapeHtml(s.lastFocus)}" style="cursor:help;max-width:180px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.lastFocus.slice(0, 60))}</span>`
                  : '<span class="text-dim">--</span>';
                const cyclesLeft =
                  s.strategistCyclesUntilNext != null
                    ? `<span class="text-dim text-sm" style="margin-left:4px">(${s.strategistCyclesUntilNext} cycles left)</span>`
                    : '';
                const nextRunCell = isContinuous
                  ? `<span class="text-dim text-sm">Cycle #${s.continuousCycleCount || 0}</span>`
                  : s.nextRunAt
                    ? timeAgo(s.nextRunAt, true)
                    : '--';
                const activityCell = s.isExecutingLoop
                  ? '<span style="display:inline-flex;align-items:center;gap:6px"><span class="processing-pulse"></span> Executing</span>'
                  : '<span class="text-dim">Idle</span>';
                return `
              <tr>
                <td>${escapeHtml(s.botName)}</td>
                <td>${modeBadge(s.mode || 'periodic')}</td>
                <td>${activityCell}</td>
                <td class="text-dim">${nextRunCell}</td>
                <td class="text-dim">${s.lastRunAt ? timeAgo(s.lastRunAt) : 'Never'}</td>
                <td class="text-dim">${s.nextCheckIn ? escapeHtml(s.nextCheckIn) : '--'}</td>
                <td>${s.lastStatus ? statusBadge(s.lastStatus) : '<span class="text-dim">--</span>'}</td>
                <td>${s.retryCount > 0 ? `<span class="badge badge-error">${s.retryCount} retries</span>` : '<span class="text-dim">0</span>'}</td>
                <td>${stratInfo}${cyclesLeft}</td>
              </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      `
          : ''
      }

      <div id="loop-results">
        ${
          loopState.lastResults?.length
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

  // Attach expand and retry listeners for initial results
  if (loopState.lastResults?.length) {
    const resultsContainer = document.getElementById('loop-results');
    attachResultRowListeners(resultsContainer, loopState.lastResults);
    attachRetryListeners(resultsContainer, loopState.lastResults);
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
        resultsDiv.innerHTML = `<div class="text-dim text-sm mb-16" style="font-weight:500">Last Results</div>${renderResultsTable(res.results)}`;
        attachResultRowListeners(resultsDiv, res.results);
        attachRetryListeners(resultsDiv, res.results);
      }
    } catch (err) {
      resultsDiv.innerHTML = `<p class="text-dim text-sm" style="color:var(--red)">Failed: ${escapeHtml(err.message)}</p>`;
    }

    runBtn.disabled = false;
    runBtn.textContent = 'Run Now';
  });

  // Stop All Safe button
  const stopSafeBtn = document.getElementById('btn-stop-safe');
  if (stopSafeBtn) {
    stopSafeBtn.addEventListener('click', async () => {
      if (!confirm('Gracefully stop all bots? Running cycles will finish before stopping.')) return;
      stopSafeBtn.disabled = true;
      stopSafeBtn.textContent = 'Draining...';
      try {
        const res = await api('/api/agent-loop/stop-safe', { method: 'POST' });
        if (res.error) alert(`Graceful stop failed: ${res.error}`);
      } catch (err) {
        alert(`Graceful stop failed: ${err.message}`);
      }
      renderDashboard(el);
    });
  }

  // Auto-refresh polling: refresh bot schedules + badges every 5s while running or draining
  let refreshTimer = null;
  function startAutoRefresh() {
    if (refreshTimer) return;
    refreshTimer = setInterval(async () => {
      try {
        const fresh = await api('/api/agent-loop');
        if (!fresh.running && !fresh.draining) {
          clearInterval(refreshTimer);
          refreshTimer = null;
          renderDashboard(el);
          return;
        }
        // Update schedules table in-place
        const tbody = el.querySelector('.results-table:first-of-type tbody');
        if (tbody && fresh.botSchedules) {
          for (const s of fresh.botSchedules) {
            // Find matching row by bot name (first cell)
            for (const row of tbody.querySelectorAll('tr')) {
              const cells = row.querySelectorAll('td');
              if (cells.length > 2 && cells[0].textContent === s.botName) {
                cells[2].innerHTML = s.isExecutingLoop
                  ? '<span style="display:inline-flex;align-items:center;gap:6px"><span class="processing-pulse"></span> Executing</span>'
                  : '<span class="text-dim">Idle</span>';
                break;
              }
            }
          }
        }
      } catch (_) {
        /* ignore refresh errors */
      }
    }, 5000);
  }
  if (loopState.running || loopState.draining) startAutoRefresh();

  // Cleanup on navigation (el gets replaced, timer becomes orphan)
  el._dashboardCleanup = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };
}
