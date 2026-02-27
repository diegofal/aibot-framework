import { api, escapeHtml } from './shared.js';

let refreshTimer = null;
let pollTimers = new Map();

function formatRemaining(ms) {
  if (ms <= 0) return 'Expired';
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s left`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s left`;
  return `${Math.floor(ms / 3600_000)}h ${Math.floor((ms % 3600_000) / 60_000)}m left`;
}

function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(ts).toLocaleString();
}

function timeoutPercent(createdAt, timeoutMs) {
  const elapsed = Date.now() - createdAt;
  return Math.max(0, Math.min(100, (1 - elapsed / timeoutMs) * 100));
}

function urgencyBadge(urgency) {
  const colors = { high: 'var(--red)', normal: 'var(--yellow)', low: 'var(--green)' };
  const color = colors[urgency] || colors.normal;
  return `<span class="permission-urgency" style="background:${color};color:#000;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase">${escapeHtml(urgency)}</span>`;
}

function statusBadge(status) {
  const map = {
    approved: { bg: 'rgba(52,211,153,.15)', color: 'var(--green)', label: 'Approved' },
    denied: { bg: 'rgba(248,113,113,.1)', color: 'var(--red)', label: 'Denied' },
  };
  const s = map[status] || map.approved;
  return `<span class="badge" style="background:${s.bg};color:${s.color}">${s.label}</span>`;
}

function executionBadge(executionStatus) {
  const map = {
    decided: { bg: 'rgba(108,140,255,.15)', color: 'var(--accent)', label: 'Decided' },
    consumed: { bg: 'rgba(251,191,36,.15)', color: 'var(--orange)', label: 'Processing' },
    executed: { bg: 'rgba(52,211,153,.15)', color: 'var(--green)', label: 'Executed' },
    failed: { bg: 'rgba(248,113,113,.1)', color: 'var(--red)', label: 'Failed' },
  };
  const s = map[executionStatus] || map.decided;
  const pulse = executionStatus === 'consumed' ? ' <span class="processing-pulse"></span>' : '';
  return `<span class="badge" style="background:${s.bg};color:${s.color}">${s.label}${pulse}</span>`;
}

function renderRequestCard(r) {
  const pct = timeoutPercent(r.createdAt, r.timeoutMs);
  return `<div class="inbox-card" data-id="${escapeHtml(r.id)}">
    <div class="inbox-card-header">
      <span class="inbox-card-bot">${escapeHtml(r.botName)}</span>
      <span style="display:flex;gap:8px;align-items:center">
        ${urgencyBadge(r.urgency)}
        <span class="inbox-card-time">${formatRemaining(r.remainingMs)}</span>
      </span>
    </div>
    <div class="timeout-bar"><div class="timeout-bar-fill" style="width:${pct}%"></div></div>
    <div style="margin:8px 0">
      <span style="font-size:12px;color:var(--text-dim);margin-right:8px">Action:</span>
      <code style="background:var(--bg);padding:2px 6px;border-radius:3px;font-size:13px">${escapeHtml(r.action)}</code>
    </div>
    <div style="margin:4px 0">
      <span style="font-size:12px;color:var(--text-dim);margin-right:8px">Resource:</span>
      <code style="background:var(--bg);padding:2px 6px;border-radius:3px;font-size:13px">${escapeHtml(r.resource)}</code>
    </div>
    <div class="inbox-card-question">${escapeHtml(r.description)}</div>
    <div class="inbox-answer-form">
      <input type="text" class="inbox-answer-input" placeholder="Optional note..." />
      <button class="btn btn-primary btn-approve" style="background:var(--green)">Approve</button>
      <button class="btn btn-dismiss btn-deny" style="background:var(--red);color:#fff">Deny</button>
    </div>
  </div>`;
}

function renderHistoryCard(entry) {
  const borderColor = {
    decided: 'var(--accent)',
    consumed: 'var(--orange)',
    executed: 'var(--green)',
    failed: 'var(--red)',
  }[entry.executionStatus] || 'var(--border)';

  const toolCallsHtml = entry.toolCalls?.length
    ? `<div style="margin-top:8px;font-size:12px;color:var(--text-dim)">
        <strong>Tool calls:</strong>
        ${entry.toolCalls.map(t =>
          `<span style="margin-left:6px">${t.success ? '\u2705' : '\u274C'} <code>${escapeHtml(t.name)}</code></span>`
        ).join('')}
      </div>`
    : '';

  const summaryHtml = entry.executionSummary
    ? `<div style="margin-top:6px;font-size:12px;color:var(--text-dim);max-height:80px;overflow:hidden;text-overflow:ellipsis">
        <strong>Summary:</strong> ${escapeHtml(entry.executionSummary.slice(0, 200))}
      </div>`
    : '';

  const retryHtml = entry.executionStatus === 'failed'
    ? `<div style="margin-top:8px;text-align:right">
        <button class="btn btn-primary btn-retry" style="font-size:12px;padding:4px 12px">Retry</button>
      </div>`
    : '';

  return `<div class="history-card" style="border-left:3px solid ${borderColor}" data-id="${escapeHtml(entry.id)}">
    <div class="inbox-card-header">
      <span class="inbox-card-bot">${escapeHtml(entry.botName)}</span>
      <span style="display:flex;gap:8px;align-items:center">
        ${statusBadge(entry.status)}
        ${executionBadge(entry.executionStatus)}
        <span class="inbox-card-time">${formatTimeAgo(entry.resolvedAt)}</span>
      </span>
    </div>
    <div style="margin:8px 0">
      <span style="font-size:12px;color:var(--text-dim);margin-right:8px">Action:</span>
      <code style="background:var(--bg);padding:2px 6px;border-radius:3px;font-size:13px">${escapeHtml(entry.action)}</code>
      <span style="font-size:12px;color:var(--text-dim);margin:0 8px">Resource:</span>
      <code style="background:var(--bg);padding:2px 6px;border-radius:3px;font-size:13px">${escapeHtml(entry.resource)}</code>
    </div>
    ${entry.note ? `<div style="font-size:12px;color:var(--text-dim);margin:4px 0"><em>Note: ${escapeHtml(entry.note)}</em></div>` : ''}
    ${toolCallsHtml}
    ${summaryHtml}
    ${retryHtml}
  </div>`;
}

function pollHistoryEntry(id, el) {
  const timer = setInterval(async () => {
    const data = await api(`/api/ask-permission/history/${encodeURIComponent(id)}`);
    if (data.error || !data.entry) return;
    const { entry } = data;
    if (entry.executionStatus === 'executed' || entry.executionStatus === 'failed') {
      clearInterval(timer);
      pollTimers.delete(id);
      render(el);
    }
  }, 5000);
  pollTimers.set(id, timer);
}

function clearPollTimers() {
  for (const timer of pollTimers.values()) {
    clearInterval(timer);
  }
  pollTimers.clear();
}

async function render(el) {
  clearPollTimers();

  const [pendingData, historyData] = await Promise.all([
    api('/api/ask-permission'),
    api('/api/ask-permission/history?limit=20'),
  ]);

  if (pendingData.error) {
    el.innerHTML = `<div class="page-title">Permissions</div><p class="text-dim">Failed to load: ${escapeHtml(pendingData.error)}</p>`;
    return;
  }

  const { requests } = pendingData;
  const historyEntries = historyData.entries || [];

  const pendingHtml = requests.length > 0
    ? requests.map(renderRequestCard).join('')
    : '<p class="text-dim text-sm">No pending permission requests</p>';

  const historyHtml = historyEntries.length > 0
    ? historyEntries.map(renderHistoryCard).join('')
    : '<p class="text-dim text-sm">No recent decisions</p>';

  el.innerHTML = `
    <div class="page-title">Permissions <span class="count">${requests.length} pending</span></div>
    <div id="permission-requests">${pendingHtml}</div>
    <div class="page-title" style="margin-top:32px">Recent Decisions <span class="count">${historyEntries.length}</span></div>
    <div id="permission-history">${historyHtml}</div>
  `;

  // Attach approve + deny handlers
  el.querySelectorAll('#permission-requests .inbox-card').forEach((card) => {
    const id = card.dataset.id;
    const input = card.querySelector('.inbox-answer-input');
    const btnApprove = card.querySelector('.btn-approve');
    const btnDeny = card.querySelector('.btn-deny');

    if (btnApprove) {
      btnApprove.addEventListener('click', async () => {
        btnApprove.disabled = true;
        btnDeny.disabled = true;
        btnApprove.textContent = 'Approving...';
        const note = input ? input.value.trim() : '';
        const res = await api(`/api/ask-permission/${encodeURIComponent(id)}/approve`, {
          method: 'POST',
          body: note ? { note } : {},
        });
        if (res.ok) {
          // Transition card in-place instead of re-rendering
          card.classList.add('history-card');
          card.style.borderLeft = '3px solid var(--accent)';
          card.querySelector('.inbox-answer-form').innerHTML =
            `<div style="display:flex;align-items:center;gap:8px;padding:8px 0">
              ${statusBadge('approved')}
              ${executionBadge('decided')}
              <span class="text-dim text-sm">Waiting for bot to pick up...</span>
              <span class="processing-pulse"></span>
            </div>`;
          card.querySelector('.timeout-bar')?.remove();
          pollHistoryEntry(id, el);
        } else {
          btnApprove.disabled = false;
          btnDeny.disabled = false;
          btnApprove.textContent = 'Approve';
        }
      });
    }

    if (btnDeny) {
      btnDeny.addEventListener('click', async () => {
        btnDeny.disabled = true;
        btnApprove.disabled = true;
        btnDeny.textContent = 'Denying...';
        const note = input ? input.value.trim() : '';
        const res = await api(`/api/ask-permission/${encodeURIComponent(id)}/deny`, {
          method: 'POST',
          body: note ? { note } : {},
        });
        if (res.ok) {
          // Transition card in-place
          card.classList.add('history-card');
          card.style.borderLeft = '3px solid var(--red)';
          card.querySelector('.inbox-answer-form').innerHTML =
            `<div style="display:flex;align-items:center;gap:8px;padding:8px 0">
              ${statusBadge('denied')}
              <span class="text-dim text-sm">Denied \u2014 bot will skip this action</span>
            </div>`;
          card.querySelector('.timeout-bar')?.remove();
          // No need to poll for denied — the decision is final
        } else {
          btnDeny.disabled = false;
          btnApprove.disabled = false;
          btnDeny.textContent = 'Deny';
        }
      });
    }
  });

  // Attach retry handlers for failed history entries
  el.querySelectorAll('#permission-history .history-card .btn-retry').forEach((btn) => {
    const card = btn.closest('.history-card');
    const id = card?.dataset.id;
    if (!id) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Retrying...';
      const res = await api(`/api/ask-permission/history/${encodeURIComponent(id)}/requeue`, {
        method: 'POST',
        body: {},
      });
      if (res.ok) {
        render(el);
      } else {
        btn.disabled = false;
        btn.textContent = 'Retry';
      }
    });
  });

  // Start polling for in-progress history entries
  for (const entry of historyEntries) {
    if (entry.executionStatus === 'decided' || entry.executionStatus === 'consumed') {
      pollHistoryEntry(entry.id, el);
    }
  }
}

export async function renderPermissions(el) {
  await render(el);
  refreshTimer = setInterval(() => render(el), 15_000);
}

export function destroyPermissions() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  clearPollTimers();
}
