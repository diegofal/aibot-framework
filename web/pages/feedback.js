import { api, escapeHtml, timeAgo } from './shared.js';

function statusBadge(status) {
  if (status === 'applied') return '<span class="badge eval-badge-approved">Applied</span>';
  if (status === 'dismissed') return '<span class="badge eval-badge-rejected">Dismissed</span>';
  return '<span class="badge eval-badge-unreviewed">Pending</span>';
}

export async function renderFeedback(el) {
  el.innerHTML = '<div class="page-title">Agent Feedback</div><p class="text-dim">Loading...</p>';

  const bots = await api('/api/agent-feedback');

  if (bots.error) {
    el.innerHTML = `
      <div class="page-title">Agent Feedback</div>
      <p class="text-dim">${escapeHtml(bots.error)}</p>
    `;
    return;
  }

  const total = bots.reduce((s, b) => s + b.total, 0);
  const totalPending = bots.reduce((s, b) => s + b.pending, 0);

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Agent Feedback <span class="count">${total}</span>${totalPending > 0 ? ` <span class="badge eval-badge-unreviewed">${totalPending} pending</span>` : ''}</div>
    </div>
    ${bots.length === 0
      ? '<p class="text-dim">No feedback yet. Start a bot and submit feedback to guide its behavior.</p>'
      : `<table>
          <thead><tr><th>Bot</th><th>Total</th><th>Pending</th><th>Applied</th><th>Dismissed</th></tr></thead>
          <tbody id="feedback-tbody"></tbody>
        </table>`
    }
  `;

  if (bots.length === 0) return;

  const tbody = document.getElementById('feedback-tbody');
  for (const bot of bots) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td><a href="#/feedback/${encodeURIComponent(bot.botId)}">${escapeHtml(bot.name)}</a></td>
      <td>${bot.total}</td>
      <td>${bot.pending > 0 ? `<span style="color:var(--orange)">${bot.pending}</span>` : '0'}</td>
      <td class="text-dim">${bot.applied}</td>
      <td class="text-dim">${bot.dismissed}</td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      location.hash = `#/feedback/${encodeURIComponent(bot.botId)}`;
    });
    tbody.appendChild(tr);
  }
}

export async function renderBotFeedback(el, botId) {
  el.innerHTML = '<div class="page-title">Agent Feedback</div><p class="text-dim">Loading...</p>';

  let currentStatus = 'all';

  async function load() {
    const statusParam = currentStatus !== 'all' ? `?status=${currentStatus}` : '';
    const data = await api(`/api/agent-feedback/${encodeURIComponent(botId)}${statusParam}`);

    if (data.error) {
      el.innerHTML = `
        <div class="page-title">Agent Feedback</div>
        <p class="text-dim">${escapeHtml(data.error)}</p>
        <a href="#/feedback" class="btn btn-sm">&larr; Back</a>
      `;
      return;
    }

    const { entries } = data;

    el.innerHTML = `
      <div class="flex-between mb-16">
        <div class="page-title">${escapeHtml(botId)} Feedback</div>
        <a href="#/feedback" class="btn btn-sm">&larr; Back</a>
      </div>

      <div class="detail-card mb-16">
        <div class="form-group">
          <label>Submit Feedback</label>
          <textarea id="feedback-input" rows="5" placeholder="Give high-level directives: change tone, focus more on X, stop doing Y..."></textarea>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" id="feedback-submit">Submit Feedback</button>
          <button class="btn" id="feedback-generate">Generate Feedback</button>
        </div>
      </div>

      <div class="mb-16">
        <select id="status-filter" class="log-agent-filter">
          <option value="all"${currentStatus === 'all' ? ' selected' : ''}>All</option>
          <option value="pending"${currentStatus === 'pending' ? ' selected' : ''}>Pending</option>
          <option value="applied"${currentStatus === 'applied' ? ' selected' : ''}>Applied</option>
          <option value="dismissed"${currentStatus === 'dismissed' ? ' selected' : ''}>Dismissed</option>
        </select>
      </div>

      <div id="feedback-list">
        ${entries.length === 0
          ? '<p class="text-dim">No feedback entries match the filter.</p>'
          : ''}
      </div>
    `;

    // Submit handler
    document.getElementById('feedback-submit').addEventListener('click', async () => {
      const input = document.getElementById('feedback-input');
      const content = input.value.trim();
      if (!content) return;

      const btn = document.getElementById('feedback-submit');
      btn.disabled = true;
      btn.textContent = 'Submitting...';

      await api(`/api/agent-feedback/${encodeURIComponent(botId)}`, {
        method: 'POST',
        body: { content },
      });

      input.value = '';
      btn.disabled = false;
      btn.textContent = 'Submit Feedback';
      load();
    });

    // Generate handler
    document.getElementById('feedback-generate').addEventListener('click', async () => {
      const input = document.getElementById('feedback-input');
      const submitBtn = document.getElementById('feedback-submit');
      const generateBtn = document.getElementById('feedback-generate');

      submitBtn.disabled = true;
      generateBtn.disabled = true;
      generateBtn.textContent = 'Analyzing...';
      input.value = 'Analyzing bot performance, this may take a minute...';
      input.disabled = true;

      try {
        const data = await api(`/api/agent-feedback/${encodeURIComponent(botId)}/generate`, {
          method: 'POST',
        });
        if (data.error) {
          input.value = `Error: ${data.error}`;
        } else {
          input.value = data.feedback;
        }
      } catch (err) {
        input.value = `Error: ${err.message || 'Failed to generate feedback'}`;
      }

      input.disabled = false;
      submitBtn.disabled = false;
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate Feedback';
    });

    // Filter handler
    document.getElementById('status-filter').addEventListener('change', (e) => {
      currentStatus = e.target.value;
      load();
    });

    // Render feedback cards
    const list = document.getElementById('feedback-list');
    for (const entry of entries) {
      const card = document.createElement('div');
      card.className = 'detail-card mb-16';
      card.innerHTML = `
        <div class="flex-between mb-16">
          <span class="text-dim text-sm">${timeAgo(entry.createdAt)}</span>
          ${statusBadge(entry.status)}
        </div>
        <div style="margin-bottom:12px">
          <strong>Feedback:</strong>
          <div style="margin-top:4px;white-space:pre-wrap">${escapeHtml(entry.content)}</div>
        </div>
        ${entry.status === 'applied' && entry.response ? `
          <div style="background:var(--surface-2);padding:12px;border-radius:8px;border-left:3px solid var(--green)">
            <strong>Bot Response:</strong>
            <div style="margin-top:4px;white-space:pre-wrap">${escapeHtml(entry.response)}</div>
          </div>
          ${entry.appliedAt ? `<div class="text-dim text-sm" style="margin-top:8px">Applied ${timeAgo(entry.appliedAt)}</div>` : ''}
        ` : ''}
        ${entry.status === 'pending' ? `
          <div style="margin-top:8px">
            <button class="btn btn-sm btn-danger dismiss-btn" data-id="${entry.id}">Dismiss</button>
          </div>
        ` : ''}
      `;
      list.appendChild(card);
    }

    // Dismiss handlers
    list.querySelectorAll('.dismiss-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = 'Dismissing...';
        await api(`/api/agent-feedback/${encodeURIComponent(botId)}/${id}`, { method: 'DELETE' });
        load();
      });
    });
  }

  await load();
}
