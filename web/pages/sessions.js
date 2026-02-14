import { api, escapeHtml, timeAgo } from './shared.js';

export async function renderSessions(el) {
  el.innerHTML = '<div class="page-title">Sessions</div><p class="text-dim">Loading...</p>';

  const sessions = await api('/api/sessions');

  // Sort by most recent activity
  sessions.sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt));

  el.innerHTML = `
    <div class="page-title">Sessions <span class="count">${sessions.length}</span></div>
    ${sessions.length === 0
      ? '<p class="text-dim">No sessions yet.</p>'
      : `<table>
          <thead><tr><th>Session</th><th>Messages</th><th>Last Activity</th><th>Actions</th></tr></thead>
          <tbody id="sessions-tbody"></tbody>
        </table>`
    }
  `;

  if (sessions.length === 0) return;

  const tbody = document.getElementById('sessions-tbody');
  for (const s of sessions) {
    const parsed = parseSessionKey(s.key);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <a href="#/sessions/${encodeURIComponent(s.key)}">${escapeHtml(parsed.label)}</a>
        <div class="text-dim text-sm">${escapeHtml(s.key)}</div>
      </td>
      <td>${s.messageCount}</td>
      <td class="text-dim">${timeAgo(s.lastActivityAt)}</td>
      <td class="actions">
        <a href="#/sessions/${encodeURIComponent(s.key)}" class="btn btn-sm">View</a>
        <button class="btn btn-sm btn-danger" data-action="clear" data-key="${escapeHtml(s.key)}">Clear</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action="clear"]');
    if (!btn) return;
    const key = btn.dataset.key;
    if (!confirm(`Clear session "${key}"? The transcript will be deleted.`)) return;
    await api(`/api/sessions/${encodeURIComponent(key)}`, { method: 'DELETE' });
    renderSessions(el);
  });
}

export async function renderSessionTranscript(el, key) {
  el.innerHTML = '<div class="page-title">Transcript</div><p class="text-dim">Loading...</p>';

  const data = await api(`/api/sessions/${encodeURIComponent(key)}/transcript?limit=200`);
  if (data.error) {
    el.innerHTML = `<p>Session not found.</p>`;
    return;
  }

  const parsed = parseSessionKey(key);

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/sessions" class="back">&larr;</a>
      <div class="page-title">${escapeHtml(parsed.label)}</div>
      <span class="count">${data.total} messages</span>
    </div>
    <div class="transcript" id="transcript"></div>
  `;

  const container = document.getElementById('transcript');
  for (const msg of data.messages) {
    const div = document.createElement('div');
    const role = msg.role || 'system';
    div.className = `bubble bubble-${role}`;

    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map((c) => c.text || '[media]').join('\n');
    }

    if (role !== 'system') {
      div.innerHTML = `<div class="bubble-role">${role}</div>${escapeHtml(content)}`;
    } else {
      div.textContent = content;
    }
    container.appendChild(div);
  }

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function parseSessionKey(key) {
  // e.g. "bot:default:private:123456" or "bot:default:group:-5234162254:topic:123"
  const parts = key.split(':');
  const botId = parts[1] || '?';
  const chatType = parts[2] || '?';
  const chatId = parts[3] || '?';

  let label = `${chatType} ${chatId}`;
  if (chatType === 'private') label = `DM ${chatId}`;
  label += ` (${botId})`;

  if (parts[4] === 'topic') label += ` #${parts[5]}`;

  return { botId, chatType, chatId, label };
}
