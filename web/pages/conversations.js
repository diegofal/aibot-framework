import { confirmDialog, emptyState, showToast } from '../ui/index.js';
import {
  botDisplayName,
  conversationFilters,
  convStatus,
  convTypeLabel,
  deleteAllDialog,
  filterConversations,
} from './conversations-helpers.js';
import { api, escapeHtml, renderThread, timeAgo } from './shared.js';

const convHref = (botId, id) =>
  id
    ? `#/work/conversations/${encodeURIComponent(botId)}/${encodeURIComponent(id)}`
    : `#/work/conversations/${encodeURIComponent(botId)}`;

/** Filters survive navigating into a thread and back. */
const convFilter = { type: '', status: '', q: '' };
const LIST_PAGE = 100;

/**
 * #/work/conversations — List bots with conversation counts
 */
export async function renderConversations(el) {
  el.innerHTML = '<div class="page-title">Conversations</div><p class="text-dim">Loading...</p>';

  const data = await api('/api/conversations');
  if (!Array.isArray(data)) {
    el.innerHTML = `<div class="page-title">Conversations</div>${emptyState({
      icon: '∅',
      title: 'Could not load conversations',
      hint: data?.error || 'The server did not answer.',
    })}`;
    return;
  }

  const total = data.reduce((s, b) => s + (Number(b.conversationCount) || 0), 0);

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

  const deleteMany = async (url, count, botName) => {
    if (!(await confirmDialog(deleteAllDialog(count, botName)))) return;
    const res = await api(url, { method: 'DELETE' });
    if (res?.error) {
      showToast(`Could not delete: ${res.error}`, { tone: 'danger' });
      return;
    }
    const n = res?.deleted ?? count;
    showToast(`Deleted ${n} conversation${n === 1 ? '' : 's'}`, { tone: 'ok' });
    renderConversations(el);
  };

  document
    .getElementById('conv-delete-all-btn')
    ?.addEventListener('click', () => deleteMany('/api/conversations', total, ''));

  if (data.length === 0) return;

  const tbody = document.getElementById('conv-bots-tbody');
  for (const bot of data) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td><a href="${convHref(bot.botId)}">${escapeHtml(bot.name || bot.botId)}</a></td>
      <td>${Number(bot.conversationCount) || 0}</td>
      <td>${
        bot.conversationCount > 0
          ? `<button class="btn btn-danger btn-sm conv-del-bot-btn" data-bot-id="${escapeHtml(bot.botId)}" data-bot-name="${escapeHtml(bot.name || bot.botId)}" data-count="${Number(bot.conversationCount) || 0}">Delete</button>`
          : ''
      }</td>`;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      location.hash = convHref(bot.botId);
    });
    tbody.appendChild(tr);
  }

  for (const btn of el.querySelectorAll('.conv-del-bot-btn')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const { botId, botName, count } = btn.dataset;
      deleteMany(`/api/conversations/${encodeURIComponent(botId)}`, Number(count), botName);
    });
  }
}

function statusBadge(c) {
  if (!convStatus(c)) return '';
  const raw = String(c.inboxStatus || 'closed');
  const cls = `badge-inbox-${raw.replace(/_/g, '-')}`;
  return `<span class="badge ${cls}">${escapeHtml(raw.replace(/_/g, ' '))}</span>`;
}

/**
 * #/work/conversations/:botId — List conversations for a bot
 */
export async function renderBotConversations(el, botId) {
  el.innerHTML = '<div class="page-title">Conversations</div><p class="text-dim">Loading...</p>';

  let limit = LIST_PAGE;
  const [first, index] = await Promise.all([
    api(`/api/conversations/${encodeURIComponent(botId)}?limit=${limit}`),
    api('/api/conversations').catch(() => []),
  ]);
  let data = first;
  if (!Array.isArray(data)) {
    el.innerHTML = `
      <div class="page-title">Conversations</div>
      <p class="text-dim">${escapeHtml(data?.error || 'Could not load conversations')}</p>
      <a href="#/work/conversations" class="btn btn-sm">&larr; Back</a>`;
    return;
  }
  const botName = botDisplayName(index, botId);

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">${escapeHtml(botName)} · Conversations <span class="count" id="conv-count"></span></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="new-conv-btn" data-page-new>New Conversation</button>
        <a href="#/work/conversations" class="btn btn-sm">&larr; Back</a>
      </div>
    </div>
    ${conversationFilters(convFilter)}
    <div id="conv-list-wrap"></div>`;

  const draw = () => {
    const wrap = el.querySelector('#conv-list-wrap');
    if (!wrap) return;
    const shown = filterConversations(data, convFilter);
    const countEl = el.querySelector('#conv-count');
    if (countEl) {
      countEl.textContent =
        shown.length === data.length ? `${data.length}` : `${shown.length} / ${data.length}`;
    }
    const canLoadMore = data.length >= limit;
    if (data.length === 0) {
      wrap.innerHTML =
        '<p class="text-dim">No conversations yet. Click "New Conversation" to start one.</p>';
      return;
    }
    wrap.innerHTML = `${
      shown.length === 0
        ? emptyState({
            icon: '⌕',
            title: 'Nothing matches',
            hint: 'Try another type, status or search.',
          })
        : `<table>
          <thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Messages</th><th>Last Activity</th></tr></thead>
          <tbody>${shown
            .map(
              (c) => `<tr class="conv-row" data-id="${escapeHtml(c.id)}" style="cursor:pointer">
            <td><a href="${convHref(botId, c.id)}">${escapeHtml(c.title)}</a></td>
            <td><span class="badge ${c.type === 'productions' ? 'badge-running' : 'badge-stopped'}">${escapeHtml(convTypeLabel(c.type))}</span></td>
            <td>${statusBadge(c)}</td>
            <td>${Number(c.messageCount) || 0}</td>
            <td class="text-dim">${timeAgo(c.updatedAt)}</td>
          </tr>`
            )
            .join('')}</tbody>
        </table>`
    }${canLoadMore ? '<div class="conv-load-more"><button class="btn btn-sm" id="conv-load-more">Load more</button></div>' : ''}`;
  };
  draw();

  el.querySelector('#conv-filter-q')?.addEventListener('input', (e) => {
    convFilter.q = e.target.value;
    draw();
  });
  el.querySelector('#conv-filter-type')?.addEventListener('change', (e) => {
    convFilter.type = e.target.value;
    draw();
  });
  el.querySelector('#conv-filter-status')?.addEventListener('change', (e) => {
    convFilter.status = e.target.value;
    draw();
  });

  el.querySelector('#conv-list-wrap')?.addEventListener('click', async (e) => {
    if (e.target.closest('#conv-load-more')) {
      limit += LIST_PAGE;
      const more = await api(`/api/conversations/${encodeURIComponent(botId)}?limit=${limit}`);
      if (!Array.isArray(more)) {
        showToast(`Could not load more: ${more?.error || 'no answer'}`, { tone: 'danger' });
        return;
      }
      data = more;
      draw();
      return;
    }
    const row = e.target.closest('tr.conv-row');
    if (!row || e.target.closest('a')) return;
    location.hash = convHref(botId, row.dataset.id);
  });

  document.getElementById('new-conv-btn')?.addEventListener('click', async () => {
    const res = await api(`/api/conversations/${encodeURIComponent(botId)}`, {
      method: 'POST',
      body: { type: 'general' },
    });
    if (res?.id) {
      location.hash = convHref(botId, res.id);
    } else {
      showToast(`Could not create: ${res?.error || 'no answer'}`, { tone: 'danger' });
    }
  });
}

/**
 * #/work/conversations/:botId/:id — Full-page chat
 */
export async function renderConversationChat(el, botId, conversationId) {
  el.innerHTML = '<div class="page-title">Conversation</div><p class="text-dim">Loading...</p>';

  const data = await api(`/api/conversations/${encodeURIComponent(botId)}/${conversationId}`);
  if (data.error) {
    el.innerHTML = `
      <div class="page-title">Conversation</div>
      <p class="text-dim">${escapeHtml(data.error)}</p>
      <a href="${convHref(botId)}" class="btn btn-sm">&larr; Back</a>`;
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
          <a href="${convHref(botId)}" class="btn btn-sm">&larr; Back</a>
        </div>
      </div>
      <div id="conv-thread-container"></div>`;

    // Wire delete
    document.getElementById('conv-delete-btn')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Delete conversation',
        message: `Delete "${conversation.title}"? This cannot be undone.`,
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      if (!ok) return;
      const res = await api(`/api/conversations/${encodeURIComponent(botId)}/${conversationId}`, {
        method: 'DELETE',
      });
      if (res?.error) {
        showToast(`Could not delete: ${res.error}`, { tone: 'danger' });
        return;
      }
      showToast('Conversation deleted', { tone: 'ok' });
      location.hash = convHref(botId);
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
      onApprove: async (action, messageId) => {
        const res = await api(
          `/api/conversations/${encodeURIComponent(botId)}/${conversationId}/approve`,
          { method: 'POST', body: { action, messageId } }
        );
        if (res.error) {
          showToast(res.error, { tone: 'danger' });
        }
        if (res.status === 'approved') {
          // Tool was executed — start polling for the follow-up bot reply
          generating = true;
        }
        // Refresh full thread to get updated approval status and any new messages
        const freshData = await api(
          `/api/conversations/${encodeURIComponent(botId)}/${conversationId}`
        );
        if (freshData.messages) {
          threadMessages.length = 0;
          threadMessages.push(...freshData.messages);
        }
        renderThreadUI();
        if (generating) startPolling();
      },
      onSend: async (text, images, documents) => {
        // Optimistic add
        threadMessages.push({
          id: `temp-${Date.now()}`,
          role: 'human',
          content: text,
          images: images || undefined,
          documents: documents
            ? documents.map((d) => ({ name: d.name, mimeType: d.mimeType, size: d.content.length }))
            : undefined,
          createdAt: new Date().toISOString(),
        });
        generating = true;
        errorMsg = null;
        renderThreadUI();

        const body = { message: text };
        if (images && images.length > 0) body.images = images;
        if (documents && documents.length > 0) body.documents = documents;

        const res = await api(
          `/api/conversations/${encodeURIComponent(botId)}/${conversationId}/messages`,
          {
            method: 'POST',
            body,
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
