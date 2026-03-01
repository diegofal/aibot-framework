import { api, escapeHtml, renderThread, timeAgo } from './shared.js';

/**
 * #/conversations — List bots with conversation counts
 */
export async function renderConversations(el) {
  el.innerHTML = '<div class="page-title">Conversations</div><p class="text-dim">Loading...</p>';

  const data = await api('/api/conversations');
  if (data.error) {
    el.innerHTML = `
      <div class="page-title">Conversations</div>
      <p class="text-dim">${escapeHtml(data.error)}</p>`;
    return;
  }

  const total = data.reduce((s, b) => s + b.conversationCount, 0);

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Conversations <span class="count">${total}</span></div>
      ${total > 0 ? '<button class="btn btn-danger btn-sm" id="conv-delete-all-btn">Delete All</button>' : ''}
    </div>
    ${
      data.length === 0
        ? '<p class="text-dim">No bots configured.</p>'
        : `<table>
          <thead><tr><th>Bot</th><th>Conversations</th><th>Actions</th></tr></thead>
          <tbody id="conv-bots-tbody"></tbody>
        </table>`
    }`;

  // Wire "Delete All" button
  document.getElementById('conv-delete-all-btn')?.addEventListener('click', async () => {
    if (!confirm(`Delete all ${total} conversations across all bots? This cannot be undone.`))
      return;
    await api('/api/conversations', { method: 'DELETE' });
    renderConversations(el);
  });

  if (data.length === 0) return;

  const tbody = document.getElementById('conv-bots-tbody');
  for (const bot of data) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td><a href="#/conversations/${encodeURIComponent(bot.botId)}">${escapeHtml(bot.name)}</a></td>
      <td>${bot.conversationCount}</td>
      <td><button class="btn btn-danger btn-sm conv-del-bot-btn" data-bot-id="${escapeHtml(bot.botId)}" data-bot-name="${escapeHtml(bot.name)}" data-count="${bot.conversationCount}">Delete</button></td>`;
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON') return;
      location.hash = `#/conversations/${encodeURIComponent(bot.botId)}`;
    });
    tbody.appendChild(tr);
  }

  // Wire per-bot delete buttons
  for (const btn of document.querySelectorAll('.conv-del-bot-btn')) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const botId = btn.dataset.botId;
      const botName = btn.dataset.botName;
      const count = btn.dataset.count;
      if (!confirm(`Delete all ${count} conversations for ${botName}? This cannot be undone.`))
        return;
      await api(`/api/conversations/${encodeURIComponent(botId)}`, { method: 'DELETE' });
      renderConversations(el);
    });
  }
}

/**
 * #/conversations/:botId — List conversations for a bot
 */
export async function renderBotConversations(el, botId) {
  el.innerHTML = '<div class="page-title">Conversations</div><p class="text-dim">Loading...</p>';

  const data = await api(`/api/conversations/${encodeURIComponent(botId)}`);
  if (data.error) {
    el.innerHTML = `
      <div class="page-title">Conversations</div>
      <p class="text-dim">${escapeHtml(data.error)}</p>
      <a href="#/conversations" class="btn btn-sm">&larr; Back</a>`;
    return;
  }

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">${escapeHtml(botId)} Conversations <span class="count">${data.length}</span></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="new-conv-btn">New Conversation</button>
        <a href="#/conversations" class="btn btn-sm">&larr; Back</a>
      </div>
    </div>
    ${
      data.length === 0
        ? '<p class="text-dim">No conversations yet. Click "New Conversation" to start one.</p>'
        : `<table>
          <thead><tr><th>Title</th><th>Type</th><th>Messages</th><th>Last Activity</th></tr></thead>
          <tbody id="conv-list-tbody"></tbody>
        </table>`
    }`;

  // New Conversation button
  document.getElementById('new-conv-btn')?.addEventListener('click', async () => {
    const res = await api(`/api/conversations/${encodeURIComponent(botId)}`, {
      method: 'POST',
      body: { type: 'general' },
    });
    if (res.id) {
      location.hash = `#/conversations/${encodeURIComponent(botId)}/${res.id}`;
    }
  });

  if (data.length === 0) return;

  const tbody = document.getElementById('conv-list-tbody');
  for (const convo of data) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td><a href="#/conversations/${encodeURIComponent(botId)}/${convo.id}">${escapeHtml(convo.title)}</a></td>
      <td><span class="badge ${convo.type === 'productions' ? 'badge-running' : 'badge-stopped'}">${convo.type}</span></td>
      <td>${convo.messageCount}</td>
      <td class="text-dim">${timeAgo(convo.updatedAt)}</td>`;
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      location.hash = `#/conversations/${encodeURIComponent(botId)}/${convo.id}`;
    });
    tbody.appendChild(tr);
  }
}

/**
 * #/conversations/:botId/:id — Full-page chat
 */
export async function renderConversationChat(el, botId, conversationId) {
  el.innerHTML = '<div class="page-title">Conversation</div><p class="text-dim">Loading...</p>';

  const data = await api(`/api/conversations/${encodeURIComponent(botId)}/${conversationId}`);
  if (data.error) {
    el.innerHTML = `
      <div class="page-title">Conversation</div>
      <p class="text-dim">${escapeHtml(data.error)}</p>
      <a href="#/conversations/${encodeURIComponent(botId)}" class="btn btn-sm">&larr; Back</a>`;
    return;
  }

  const { conversation, messages } = data;
  const threadMessages = messages;
  let generating = false;
  let errorMsg = null;
  const MAX_POLLS = 90; // 3 min at 2s interval

  function startPolling() {
    let pollCount = 0;
    const pollInterval = setInterval(async () => {
      if (!document.getElementById('conv-thread-container')) {
        clearInterval(pollInterval);
        return;
      }
      pollCount++;
      if (pollCount >= MAX_POLLS) {
        clearInterval(pollInterval);
        generating = false;
        errorMsg = 'Response timed out (3 minutes). The bot may still be processing.';
        renderThreadUI();
        return;
      }
      const statusRes = await api(
        `/api/conversations/${encodeURIComponent(botId)}/${conversationId}/status`
      );
      if (statusRes.status === 'error') {
        clearInterval(pollInterval);
        generating = false;
        errorMsg = statusRes.error || 'Generation failed';
        renderThreadUI();
        return;
      }
      if (statusRes.status === 'idle') {
        clearInterval(pollInterval);
        if (statusRes.lastBotMessage) {
          if (!threadMessages.find((m) => m.id === statusRes.lastBotMessage.id)) {
            threadMessages.push(statusRes.lastBotMessage);
          }
        }
        generating = false;
        errorMsg = null;
        renderThreadUI();

        // Refresh conversation title (may have been auto-updated)
        const convData = await api(
          `/api/conversations/${encodeURIComponent(botId)}/${conversationId}`
        );
        if (convData.conversation) {
          conversation.title = convData.conversation.title;
          const titleEl = el.querySelector('.page-title');
          if (titleEl) titleEl.textContent = conversation.title;
        }
      }
    }, 2000);
  }

  function render() {
    el.innerHTML = `
      <div class="flex-between mb-16">
        <div class="page-title">${escapeHtml(conversation.title)}</div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="badge ${conversation.type === 'productions' ? 'badge-running' : 'badge-stopped'}">${conversation.type}</span>
          <button class="btn btn-danger btn-sm" id="conv-delete-btn">Delete</button>
          <a href="#/conversations/${encodeURIComponent(botId)}" class="btn btn-sm">&larr; Back</a>
        </div>
      </div>
      <div id="conv-thread-container"></div>`;

    // Wire delete
    document.getElementById('conv-delete-btn')?.addEventListener('click', async () => {
      if (!confirm('Delete this conversation? This cannot be undone.')) return;
      await api(`/api/conversations/${encodeURIComponent(botId)}/${conversationId}`, {
        method: 'DELETE',
      });
      location.hash = `#/conversations/${encodeURIComponent(botId)}`;
    });

    renderThreadUI();
  }

  function renderThreadUI() {
    const container = document.getElementById('conv-thread-container');
    if (!container) return;

    renderThread(container, {
      thread: threadMessages,
      generating,
      error: errorMsg,
      botId,
      onRetry: async () => {
        errorMsg = null;
        generating = true;
        renderThreadUI();
        await api(`/api/conversations/${encodeURIComponent(botId)}/${conversationId}/retry`, {
          method: 'POST',
        });
        startPolling();
      },
      onSend: async (text) => {
        // Optimistic add
        threadMessages.push({
          id: `temp-${Date.now()}`,
          role: 'human',
          content: text,
          createdAt: new Date().toISOString(),
        });
        generating = true;
        errorMsg = null;
        renderThreadUI();

        const res = await api(
          `/api/conversations/${encodeURIComponent(botId)}/${conversationId}/messages`,
          {
            method: 'POST',
            body: { message: text },
          }
        );

        if (res.error) {
          generating = false;
          renderThreadUI();
          return;
        }

        // Update title if it changed (auto-title on first message)
        if (res.message) {
          // Replace temp message with real one
          const tempIdx = threadMessages.findIndex((m) => m.id.startsWith('temp-'));
          if (tempIdx !== -1) {
            threadMessages[tempIdx] = res.message;
          }
        }

        startPolling();
      },
    });
  }

  render();
}
