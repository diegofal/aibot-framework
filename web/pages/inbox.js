import { api, escapeHtml, timeAgo, renderThread } from './shared.js';

let refreshTimer = null;

const STATUS_LABELS = {
  pending: 'Pending',
  answered: 'Answered',
  dismissed: 'Dismissed',
  timed_out: 'Timed Out',
};

const STATUS_BADGE_CLASS = {
  pending: 'badge-inbox-pending',
  answered: 'badge-inbox-answered',
  dismissed: 'badge-inbox-dismissed',
  timed_out: 'badge-inbox-timed-out',
};

function renderConversationRow(convo, botName) {
  const status = convo.inboxStatus || 'pending';
  const badgeClass = STATUS_BADGE_CLASS[status] || '';
  const label = STATUS_LABELS[status] || status;

  return `<tr style="cursor:pointer" data-href="#/inbox/${encodeURIComponent(convo.botId)}/${convo.id}">
    <td>${escapeHtml(botName)}</td>
    <td><a href="#/inbox/${encodeURIComponent(convo.botId)}/${convo.id}">${escapeHtml(convo.title)}</a></td>
    <td><span class="badge ${badgeClass}">${label}</span></td>
    <td>${convo.messageCount}</td>
    <td class="text-dim">${timeAgo(convo.updatedAt)}</td>
  </tr>`;
}

async function render(el) {
  // Fetch inbox conversations across all bots
  const botsRes = await api('/api/conversations');
  if (botsRes.error) {
    el.innerHTML = `<div class="page-title">Inbox</div><p class="text-dim">Failed to load: ${escapeHtml(botsRes.error)}</p>`;
    return;
  }

  // Fetch inbox conversations for each bot
  const allConvos = [];
  const botNames = {};
  for (const bot of botsRes) {
    botNames[bot.botId] = bot.name;
  }

  const fetches = botsRes.map(async (bot) => {
    const convos = await api(`/api/conversations/${encodeURIComponent(bot.botId)}?type=inbox`);
    if (Array.isArray(convos)) {
      for (const c of convos) allConvos.push({ ...c, _botName: bot.name });
    }
  });
  await Promise.all(fetches);

  // Split into pending and previous
  const pending = allConvos.filter((c) => c.inboxStatus === 'pending');
  const previous = allConvos.filter((c) => c.inboxStatus !== 'pending');

  // Sort pending by updatedAt desc, previous by updatedAt desc
  pending.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  previous.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const pendingHtml = pending.length > 0
    ? `<table>
        <thead><tr><th>Bot</th><th>Question</th><th>Status</th><th>Messages</th><th>Time</th></tr></thead>
        <tbody>${pending.map((c) => renderConversationRow(c, c._botName)).join('')}</tbody>
      </table>`
    : '<p class="text-dim text-sm">No pending questions</p>';

  const previousHtml = previous.length > 0
    ? `<table>
        <thead><tr><th>Bot</th><th>Question</th><th>Status</th><th>Messages</th><th>Time</th></tr></thead>
        <tbody>${previous.map((c) => renderConversationRow(c, c._botName)).join('')}</tbody>
      </table>`
    : '<p class="text-dim text-sm">No previous questions</p>';

  el.innerHTML = `
    <div class="page-title">Inbox <span class="count">${pending.length} pending</span></div>

    <div style="font-weight:600;font-size:15px;margin-bottom:12px">Awaiting Response</div>
    <div id="inbox-pending" style="margin-bottom:24px">${pendingHtml}</div>

    <div style="font-weight:600;font-size:15px;margin-bottom:12px">Previous</div>
    <div id="inbox-previous">${previousHtml}</div>
  `;

  // Wire row clicks
  el.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      location.hash = tr.dataset.href;
    });
  });
}

export async function renderInbox(el) {
  await render(el);
  refreshTimer = setInterval(() => render(el), 15_000);
}

export function destroyInbox() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * #/inbox/:botId/:id — Inbox chat view
 */
export async function renderInboxChat(el, botId, conversationId) {
  el.innerHTML = '<div class="page-title">Inbox</div><p class="text-dim">Loading...</p>';

  const data = await api(`/api/conversations/${encodeURIComponent(botId)}/${conversationId}`);
  if (data.error) {
    el.innerHTML = `
      <div class="page-title">Inbox</div>
      <p class="text-dim">${escapeHtml(data.error)}</p>
      <a href="#/inbox" class="btn btn-sm">&larr; Back</a>`;
    return;
  }

  const { conversation, messages } = data;
  let threadMessages = messages;
  let generating = false;
  let errorMsg = null;
  const MAX_POLLS = 90;

  function startPolling() {
    let pollCount = 0;
    const pollInterval = setInterval(async () => {
      if (!document.getElementById('inbox-thread-container')) {
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
      const statusRes = await api(`/api/conversations/${encodeURIComponent(botId)}/${conversationId}/status`);
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

        // Refresh conversation title
        const convData = await api(`/api/conversations/${encodeURIComponent(botId)}/${conversationId}`);
        if (convData.conversation) {
          conversation.title = convData.conversation.title;
          const titleEl = el.querySelector('.page-title');
          if (titleEl) titleEl.textContent = conversation.title;
        }
      }
    }, 2000);
  }

  function renderView() {
    const status = conversation.inboxStatus || 'pending';
    const badgeClass = STATUS_BADGE_CLASS[status] || '';
    const label = STATUS_LABELS[status] || status;

    el.innerHTML = `
      <div class="flex-between mb-16">
        <div class="page-title">${escapeHtml(conversation.title)}</div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="badge ${badgeClass}">${label}</span>
          <button class="btn btn-danger btn-sm" id="inbox-delete-btn">Delete</button>
          <a href="#/inbox" class="btn btn-sm">&larr; Back</a>
        </div>
      </div>
      ${status === 'pending' ? '<div class="inbox-pending-banner"><span>This question is awaiting your response. Your first reply will be delivered to the bot.</span></div>' : ''}
      <div id="inbox-thread-container"></div>`;

    // Wire delete
    document.getElementById('inbox-delete-btn')?.addEventListener('click', async () => {
      if (!confirm('Delete this conversation? This cannot be undone.')) return;
      await api(`/api/conversations/${encodeURIComponent(botId)}/${conversationId}`, { method: 'DELETE' });
      location.hash = '#/inbox';
    });

    renderThreadUI();
  }

  function renderThreadUI() {
    const container = document.getElementById('inbox-thread-container');
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
        await api(`/api/conversations/${encodeURIComponent(botId)}/${conversationId}/retry`, { method: 'POST' });
        startPolling();
      },
      onSend: async (text) => {
        // Optimistic add
        threadMessages.push({
          id: 'temp-' + Date.now(),
          role: 'human',
          content: text,
          createdAt: new Date().toISOString(),
        });
        generating = true;
        errorMsg = null;
        renderThreadUI();

        const res = await api(`/api/conversations/${encodeURIComponent(botId)}/${conversationId}/messages`, {
          method: 'POST',
          body: { message: text },
        });

        if (res.error) {
          generating = false;
          renderThreadUI();
          return;
        }

        // If this resolved the inbox question, update status badge but continue to poll for bot reply
        if (res.inboxResolved) {
          conversation.inboxStatus = 'answered';
          renderView();
        }

        // Update title if it changed (auto-title on first message)
        if (res.message) {
          const tempIdx = threadMessages.findIndex((m) => m.id.startsWith('temp-'));
          if (tempIdx !== -1) threadMessages[tempIdx] = res.message;
        }

        startPolling();
      },
    });
  }

  renderView();
}
