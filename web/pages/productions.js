import { api, escapeHtml, timeAgo, showModal, closeModal } from './shared.js';

function statusBadge(entry) {
  if (!entry.evaluation) return '<span class="badge eval-badge-unreviewed">Unreviewed</span>';
  if (entry.evaluation.status === 'approved') return '<span class="badge eval-badge-approved">Approved</span>';
  return '<span class="badge eval-badge-rejected">Rejected</span>';
}

function starsHtml(rating, interactive = false) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const cls = i <= (rating || 0) ? 'star-filled' : 'star-empty';
    html += `<span class="star ${cls}" data-star="${i}">${i <= (rating || 0) ? '\u2605' : '\u2606'}</span>`;
  }
  return `<span class="star-rating${interactive ? ' star-interactive' : ''}">${html}</span>`;
}

export async function renderProductions(el) {
  el.innerHTML = '<div class="page-title">Productions</div><p class="text-dim">Loading...</p>';

  const stats = await api('/api/productions');

  if (stats.error) {
    el.innerHTML = `
      <div class="page-title">Productions</div>
      <p class="text-dim">Productions are not enabled. Set <code>productions.enabled: true</code> in config.</p>
    `;
    return;
  }

  const total = stats.reduce((s, b) => s + b.total, 0);

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Productions <span class="count">${total}</span></div>
    </div>
    ${stats.length === 0
      ? '<p class="text-dim">No productions yet. Bots will log file operations here when they create or edit files.</p>'
      : `<table>
          <thead><tr><th>Bot</th><th>Total</th><th>Approved</th><th>Rejected</th><th>Unreviewed</th><th>Avg Rating</th></tr></thead>
          <tbody id="prod-tbody"></tbody>
        </table>`
    }
  `;

  if (stats.length === 0) return;

  const tbody = document.getElementById('prod-tbody');
  for (const bot of stats) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td><a href="#/productions/${encodeURIComponent(bot.botId)}">${escapeHtml(bot.name)}</a></td>
      <td>${bot.total}</td>
      <td class="text-dim">${bot.approved}</td>
      <td class="text-dim">${bot.rejected}</td>
      <td>${bot.unreviewed > 0 ? `<span style="color:var(--orange)">${bot.unreviewed}</span>` : '0'}</td>
      <td>${bot.avgRating != null ? starsHtml(Math.round(bot.avgRating)) + ` <span class="text-dim">${bot.avgRating}</span>` : '<span class="text-dim">-</span>'}</td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      location.hash = `#/productions/${encodeURIComponent(bot.botId)}`;
    });
    tbody.appendChild(tr);
  }
}

export async function renderBotProductions(el, botId) {
  el.innerHTML = '<div class="page-title">Productions</div><p class="text-dim">Loading...</p>';

  let currentStatus = 'all';

  async function load() {
    const statusParam = currentStatus !== 'all' ? `&status=${currentStatus}` : '';
    const data = await api(`/api/productions/${encodeURIComponent(botId)}?limit=100${statusParam}`);

    if (data.error) {
      el.innerHTML = `
        <div class="page-title">Productions</div>
        <p class="text-dim">${escapeHtml(data.error)}</p>
        <a href="#/productions" class="btn btn-sm">&larr; Back</a>
      `;
      return;
    }

    const { entries, stats } = data;

    el.innerHTML = `
      <div class="flex-between mb-16">
        <div class="page-title">${escapeHtml(botId)} Productions <span class="count">${stats.total}</span></div>
        <a href="#/productions" class="btn btn-sm">&larr; Back</a>
      </div>

      <div class="detail-card mb-16" style="display:flex;gap:24px;flex-wrap:wrap;align-items:center">
        <div><strong>${stats.total}</strong> <span class="text-dim">Total</span></div>
        <div><span style="color:var(--green)">${stats.approved}</span> <span class="text-dim">Approved</span></div>
        <div><span style="color:var(--red)">${stats.rejected}</span> <span class="text-dim">Rejected</span></div>
        <div><span style="color:var(--orange)">${stats.unreviewed}</span> <span class="text-dim">Unreviewed</span></div>
        <div>${stats.avgRating != null ? starsHtml(Math.round(stats.avgRating)) + ` <span class="text-dim">${stats.avgRating}</span>` : '<span class="text-dim">No ratings</span>'}</div>
        <div style="margin-left:auto"><button class="btn btn-sm" id="generate-summary-btn">Generate Summary</button></div>
      </div>

      <div id="summary-container" class="mb-16"></div>

      <div class="mb-16">
        <select id="status-filter" class="log-agent-filter">
          <option value="all"${currentStatus === 'all' ? ' selected' : ''}>All</option>
          <option value="approved"${currentStatus === 'approved' ? ' selected' : ''}>Approved</option>
          <option value="rejected"${currentStatus === 'rejected' ? ' selected' : ''}>Rejected</option>
          <option value="unreviewed"${currentStatus === 'unreviewed' ? ' selected' : ''}>Unreviewed</option>
        </select>
      </div>

      ${entries.length === 0
        ? '<p class="text-dim">No entries match the filter.</p>'
        : `<table>
            <thead><tr><th>Time</th><th>Path</th><th>Tool</th><th>Action</th><th>Status</th><th>Rating</th></tr></thead>
            <tbody id="entries-tbody"></tbody>
          </table>`
      }
    `;

    document.getElementById('status-filter')?.addEventListener('change', (e) => {
      currentStatus = e.target.value;
      load();
    });

    const summaryBtn = document.getElementById('generate-summary-btn');
    if (summaryBtn) {
      summaryBtn.addEventListener('click', async () => {
        summaryBtn.disabled = true;
        summaryBtn.textContent = 'Generating...';
        const container = document.getElementById('summary-container');
        container.innerHTML = '<p class="text-dim">Analyzing productions...</p>';

        try {
          const result = await api(`/api/productions/${encodeURIComponent(botId)}/generate-summary`, {
            method: 'POST',
          });
          if (result.error) {
            container.innerHTML = `<div class="detail-card" style="border-color:var(--red)"><p class="text-dim">${escapeHtml(result.error)}</p></div>`;
          } else {
            container.innerHTML = `<div class="detail-card" style="white-space:pre-wrap">${escapeHtml(result.summary)}</div>`;
          }
        } catch (err) {
          container.innerHTML = `<div class="detail-card" style="border-color:var(--red)"><p class="text-dim">Request failed: ${escapeHtml(String(err))}</p></div>`;
        }

        summaryBtn.disabled = false;
        summaryBtn.textContent = 'Regenerate Summary';
      });
    }

    if (entries.length === 0) return;

    const tbody = document.getElementById('entries-tbody');
    for (const entry of entries) {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.innerHTML = `
        <td class="text-dim">${timeAgo(entry.timestamp)}</td>
        <td>${escapeHtml(entry.path)}</td>
        <td class="text-dim">${escapeHtml(entry.tool)}</td>
        <td class="text-dim">${escapeHtml(entry.action)}${entry.trackOnly ? ' <span class="badge badge-disabled">track</span>' : ''}</td>
        <td>${statusBadge(entry)}</td>
        <td>${entry.evaluation?.rating ? starsHtml(entry.evaluation.rating) : '<span class="text-dim">-</span>'}</td>
      `;
      tr.addEventListener('click', () => showDetailModal(botId, entry.id));
      tbody.appendChild(tr);
    }
  }

  await load();
}

async function showDetailModal(botId, entryId) {
  showModal('<p class="text-dim">Loading...</p>');

  const data = await api(`/api/productions/${encodeURIComponent(botId)}/${entryId}`);
  if (data.error) {
    showModal(`<p class="text-dim">${escapeHtml(data.error)}</p><div class="modal-actions"><button class="btn" onclick="document.getElementById('modal-overlay').classList.add('hidden')">Close</button></div>`);
    return;
  }

  const { entry, content } = data;
  let currentRating = entry.evaluation?.rating || 0;
  let currentStatus = entry.evaluation?.status || '';

  function render() {
    const modal = document.getElementById('modal');
    modal.style.maxWidth = '700px';
    modal.innerHTML = `
      <div class="modal-title">${escapeHtml(entry.path)}</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px">
        <span class="text-dim text-sm">${new Date(entry.timestamp).toLocaleString()}</span>
        <span class="text-dim text-sm">${escapeHtml(entry.tool)} / ${escapeHtml(entry.action)}</span>
        ${entry.trackOnly ? '<span class="badge badge-disabled">track-only</span>' : ''}
        ${statusBadge(entry)}
      </div>

      <div class="production-content">${content != null ? `<pre>${escapeHtml(content)}</pre>` : '<p class="text-dim">File not found or empty</p>'}</div>

      <div class="form-separator"></div>

      <div class="eval-controls">
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn btn-sm${currentStatus === 'approved' ? ' btn-primary' : ''}" id="eval-approve">Approve</button>
          <button class="btn btn-sm${currentStatus === 'rejected' ? ' btn-danger' : ''}" id="eval-reject">Reject</button>
          <span style="margin-left:12px">${starsHtml(currentRating, true)}</span>
        </div>

        <div class="form-group">
          <label>Feedback</label>
          <textarea id="eval-feedback" rows="2">${escapeHtml(entry.evaluation?.feedback || '')}</textarea>
        </div>

        <div class="modal-actions" style="justify-content:space-between">
          <div class="actions">
            <button class="btn btn-danger btn-sm" id="eval-delete">Delete</button>
          </div>
          <div class="actions">
            <button class="btn" id="eval-cancel">Close</button>
            <button class="btn btn-primary" id="eval-save">Save Evaluation</button>
          </div>
        </div>
      </div>
    `;

    // Star rating click
    modal.querySelectorAll('.star-interactive .star').forEach((star) => {
      star.style.cursor = 'pointer';
      star.addEventListener('click', () => {
        currentRating = parseInt(star.dataset.star);
        render();
      });
    });

    // Approve/Reject toggle
    document.getElementById('eval-approve').addEventListener('click', () => {
      currentStatus = 'approved';
      render();
    });
    document.getElementById('eval-reject').addEventListener('click', () => {
      currentStatus = 'rejected';
      render();
    });

    // Save
    document.getElementById('eval-save').addEventListener('click', async () => {
      if (!currentStatus) {
        alert('Please select Approve or Reject');
        return;
      }
      const feedback = document.getElementById('eval-feedback').value.trim();
      const btn = document.getElementById('eval-save');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      await api(`/api/productions/${encodeURIComponent(botId)}/${entryId}/evaluate`, {
        method: 'POST',
        body: {
          status: currentStatus,
          rating: currentRating || undefined,
          feedback: feedback || undefined,
        },
      });
      closeModal();
    });

    // Delete
    document.getElementById('eval-delete').addEventListener('click', async () => {
      if (!confirm('Delete this production and its file? This cannot be undone.')) return;
      await api(`/api/productions/${encodeURIComponent(botId)}/${entryId}`, { method: 'DELETE' });
      closeModal();
      // Re-render the page
      const contentEl = document.getElementById('content');
      renderBotProductions(contentEl, botId);
    });

    // Close
    document.getElementById('eval-cancel').addEventListener('click', closeModal);
  }

  render();
}
