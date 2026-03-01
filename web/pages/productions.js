import { api, closeModal, escapeHtml, renderThread, showModal, timeAgo } from './shared.js';

function statusBadge(entry) {
  if (!entry.evaluation?.status)
    return '<span class="badge eval-badge-unreviewed">Unreviewed</span>';
  if (entry.evaluation.status === 'approved')
    return '<span class="badge eval-badge-approved">Approved</span>';
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

  // Build botNameMap for unified list
  const botNameMap = {};
  for (const bot of stats) {
    botNameMap[bot.botId] = bot.name;
  }

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Productions <span class="count">${total}</span></div>
    </div>
    ${
      stats.length === 0
        ? '<p class="text-dim">No productions yet. Bots will log file operations here when they create or edit files.</p>'
        : `<table>
          <thead><tr><th>Bot</th><th>Total</th><th>Approved</th><th>Rejected</th><th>Unreviewed</th><th>Avg Rating</th></tr></thead>
          <tbody id="prod-tbody"></tbody>
        </table>`
    }
    <div id="unified-entries-section"></div>
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
      <td>${bot.avgRating != null ? `${starsHtml(Math.round(bot.avgRating))} <span class="text-dim">${bot.avgRating}</span>` : '<span class="text-dim">-</span>'}</td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      location.hash = `#/productions/${encodeURIComponent(bot.botId)}`;
    });
    tbody.appendChild(tr);
  }

  // Unified entries list
  const section = document.getElementById('unified-entries-section');
  if (!section || total === 0) return;

  let filterBot = '';
  let filterStatus = '';
  let currentOffset = 0;
  const PAGE_SIZE = 100;
  let loadedEntries = [];
  let loadedTotal = 0;

  async function loadUnifiedEntries(append) {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(append ? currentOffset : 0));
    if (filterBot) params.set('botId', filterBot);
    if (filterStatus) params.set('status', filterStatus);

    const data = await api(`/api/productions/all-entries?${params}`);
    if (data.error) return;

    if (append) {
      loadedEntries = loadedEntries.concat(data.entries);
    } else {
      loadedEntries = data.entries;
      currentOffset = 0;
    }
    loadedTotal = data.total;
    currentOffset = loadedEntries.length;

    renderUnifiedEntries();
  }

  function renderUnifiedEntries() {
    section.innerHTML = `
      <div class="form-separator"></div>
      <div class="flex-between mb-16">
        <div class="page-title" style="font-size:1.1rem">All Entries</div>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="unified-bot-filter" class="log-agent-filter">
            <option value="">All Bots</option>
            ${stats.map((b) => `<option value="${escapeHtml(b.botId)}"${filterBot === b.botId ? ' selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}
          </select>
          <select id="unified-status-filter" class="log-agent-filter">
            <option value=""${filterStatus === '' ? ' selected' : ''}>All</option>
            <option value="approved"${filterStatus === 'approved' ? ' selected' : ''}>Approved</option>
            <option value="rejected"${filterStatus === 'rejected' ? ' selected' : ''}>Rejected</option>
            <option value="unreviewed"${filterStatus === 'unreviewed' ? ' selected' : ''}>Unreviewed</option>
          </select>
        </div>
      </div>

      ${
        loadedEntries.length === 0
          ? '<p class="text-dim">No entries match the filter.</p>'
          : `<table>
            <thead><tr><th>Time</th><th>Bot</th><th>Path</th><th>Tool</th><th>Action</th><th>Status</th><th>Rating</th></tr></thead>
            <tbody id="unified-entries-tbody"></tbody>
          </table>`
      }

      ${
        loadedTotal > loadedEntries.length
          ? `<div style="text-align:center;margin-top:12px"><button class="btn btn-sm" id="unified-load-more">Load More (${loadedEntries.length}/${loadedTotal})</button></div>`
          : ''
      }
    `;

    // Bind filter events
    document.getElementById('unified-bot-filter')?.addEventListener('change', (e) => {
      filterBot = e.target.value;
      loadUnifiedEntries(false);
    });
    document.getElementById('unified-status-filter')?.addEventListener('change', (e) => {
      filterStatus = e.target.value;
      loadUnifiedEntries(false);
    });
    document.getElementById('unified-load-more')?.addEventListener('click', () => {
      loadUnifiedEntries(true);
    });

    // Populate rows
    const utbody = document.getElementById('unified-entries-tbody');
    if (!utbody) return;

    for (const entry of loadedEntries) {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.innerHTML = `
        <td class="text-dim">${timeAgo(entry.timestamp)}</td>
        <td>${escapeHtml(botNameMap[entry.botId] || entry.botId)}</td>
        <td>${escapeHtml(entry.path)}</td>
        <td class="text-dim">${escapeHtml(entry.tool)}</td>
        <td class="text-dim">${escapeHtml(entry.action)}${entry.trackOnly ? ' <span class="badge badge-disabled">track</span>' : ''}</td>
        <td>${statusBadge(entry)}</td>
        <td>${entry.evaluation?.rating ? starsHtml(entry.evaluation.rating) : '<span class="text-dim">-</span>'}</td>
      `;
      tr.addEventListener('click', () =>
        showDetailModal(entry.botId, entry.id, () => loadUnifiedEntries(false))
      );
      utbody.appendChild(tr);
    }
  }

  await loadUnifiedEntries(false);
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
        <div>${stats.avgRating != null ? `${starsHtml(Math.round(stats.avgRating))} <span class="text-dim">${stats.avgRating}</span>` : '<span class="text-dim">No ratings</span>'}</div>
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

      ${
        entries.length === 0
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

    function checkSummaryStatus(id) {
      const btn = document.getElementById('generate-summary-btn');
      const container = document.getElementById('summary-container');
      if (!btn || !container) return Promise.resolve('gone');

      return api(`/api/productions/${encodeURIComponent(id)}/summary-status`).then((res) => {
        // Guard: DOM may be gone if user navigated away
        if (!document.getElementById('generate-summary-btn')) return 'gone';

        if (res.status === 'generating') {
          btn.disabled = true;
          btn.textContent = 'Generating...';
          container.innerHTML = '<p class="text-dim">Analyzing productions...</p>';
        } else if (res.status === 'done') {
          btn.disabled = false;
          btn.textContent = 'Regenerate Summary';
          container.innerHTML = `<div class="detail-card" style="white-space:pre-wrap">${escapeHtml(res.summary)}</div>`;
        } else if (res.status === 'error') {
          btn.disabled = false;
          btn.textContent = 'Retry Summary';
          container.innerHTML = `<div class="detail-card" style="border-color:var(--red)"><p class="text-dim">${escapeHtml(res.error)}</p></div>`;
        } else {
          // idle
          btn.disabled = false;
          btn.textContent = 'Generate Summary';
        }
        return res.status;
      });
    }

    function startPolling(id) {
      const interval = setInterval(async () => {
        const status = await checkSummaryStatus(id);
        if (status !== 'generating') clearInterval(interval);
      }, 3000);
    }

    const summaryBtn = document.getElementById('generate-summary-btn');
    if (summaryBtn) {
      // Check status on load
      checkSummaryStatus(botId).then((status) => {
        if (status === 'generating') startPolling(botId);
      });

      summaryBtn.addEventListener('click', async () => {
        summaryBtn.disabled = true;
        summaryBtn.textContent = 'Generating...';
        const container = document.getElementById('summary-container');
        container.innerHTML = '<p class="text-dim">Analyzing productions...</p>';

        try {
          await api(`/api/productions/${encodeURIComponent(botId)}/generate-summary`, {
            method: 'POST',
          });
          startPolling(botId);
        } catch (err) {
          container.innerHTML = `<div class="detail-card" style="border-color:var(--red)"><p class="text-dim">Request failed: ${escapeHtml(String(err))}</p></div>`;
          summaryBtn.disabled = false;
          summaryBtn.textContent = 'Retry Summary';
        }
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
      tr.addEventListener('click', () => showDetailModal(botId, entry.id, () => load()));
      tbody.appendChild(tr);
    }
  }

  await load();

  // --- Productions Chat section ---
  const chatSection = document.createElement('div');
  chatSection.className = 'mb-16';
  chatSection.id = 'productions-chat-section';
  el.appendChild(chatSection);

  let chatConvos = [];
  let activeChat = null;
  let chatMessages = [];
  let chatGenerating = false;
  let chatErrorMsg = null;
  const MAX_POLLS = 90;

  async function loadProductionsChats() {
    const data = await api(`/api/conversations/${encodeURIComponent(botId)}?type=productions`);
    if (!data.error) chatConvos = data;
    renderProductionsChat();
  }

  function renderProductionsChat() {
    const section = document.getElementById('productions-chat-section');
    if (!section) return;

    section.innerHTML = `
      <div class="form-separator"></div>
      <div class="flex-between mb-16">
        <div class="page-title" style="font-size:1.1rem">Productions Chat</div>
        <button class="btn btn-primary btn-sm" id="new-prod-chat-btn">New Chat</button>
      </div>
      ${
        chatConvos.length > 0 && !activeChat
          ? `<div id="prod-chat-list" class="mb-16">
            ${chatConvos
              .map(
                (c) => `
              <div class="detail-card mb-8 prod-chat-item" data-id="${c.id}" style="cursor:pointer;padding:10px 14px;display:flex;justify-content:space-between;align-items:center">
                <div>
                  <strong>${escapeHtml(c.title)}</strong>
                  <span class="text-dim text-sm" style="margin-left:8px">${c.messageCount} messages</span>
                </div>
                <span class="text-dim text-sm">${timeAgo(c.updatedAt)}</span>
              </div>
            `
              )
              .join('')}
          </div>`
          : ''
      }
      ${
        activeChat
          ? `<div class="detail-card mb-16">
            <div class="flex-between mb-8">
              <strong>${escapeHtml(activeChat.title)}</strong>
              <div style="display:flex;gap:8px;align-items:center">
                <a href="#/conversations/${encodeURIComponent(botId)}/${activeChat.id}" class="text-dim text-sm">Open in Conversations &rarr;</a>
                <button class="btn btn-sm" id="prod-chat-back-btn">Back to list</button>
              </div>
            </div>
            <div id="prod-chat-thread"></div>
          </div>`
          : ''
      }
      ${
        !activeChat && chatConvos.length === 0
          ? '<p class="text-dim">No productions chats yet. Start a conversation about this bot\'s work.</p>'
          : ''
      }`;

    // Wire new chat button
    document.getElementById('new-prod-chat-btn')?.addEventListener('click', async () => {
      const res = await api(`/api/conversations/${encodeURIComponent(botId)}`, {
        method: 'POST',
        body: { type: 'productions' },
      });
      if (res.id) {
        activeChat = res;
        chatMessages = [];
        chatGenerating = false;
        renderProductionsChat();
      }
    });

    // Wire back button
    document.getElementById('prod-chat-back-btn')?.addEventListener('click', () => {
      activeChat = null;
      loadProductionsChats();
    });

    // Wire chat item clicks
    document.querySelectorAll('.prod-chat-item').forEach((item) => {
      item.addEventListener('click', async () => {
        const convId = item.dataset.id;
        const data = await api(`/api/conversations/${encodeURIComponent(botId)}/${convId}`);
        if (data.conversation) {
          activeChat = data.conversation;
          chatMessages = data.messages || [];
          chatGenerating = false;
          renderProductionsChat();
        }
      });
    });

    // Render thread if active chat
    if (activeChat) {
      renderProdChatThread();
    }
  }

  function startProdChatPolling() {
    let pollCount = 0;
    const pollInterval = setInterval(async () => {
      if (!document.getElementById('prod-chat-thread')) {
        clearInterval(pollInterval);
        return;
      }
      pollCount++;
      if (pollCount >= MAX_POLLS) {
        clearInterval(pollInterval);
        chatGenerating = false;
        chatErrorMsg = 'Response timed out (3 minutes). The bot may still be processing.';
        renderProdChatThread();
        return;
      }
      const statusRes = await api(
        `/api/conversations/${encodeURIComponent(botId)}/${activeChat.id}/status`
      );
      if (statusRes.status === 'error') {
        clearInterval(pollInterval);
        chatGenerating = false;
        chatErrorMsg = statusRes.error || 'Generation failed';
        renderProdChatThread();
        return;
      }
      if (statusRes.status === 'idle') {
        clearInterval(pollInterval);
        if (statusRes.lastBotMessage) {
          if (!chatMessages.find((m) => m.id === statusRes.lastBotMessage.id)) {
            chatMessages.push(statusRes.lastBotMessage);
          }
        }
        chatGenerating = false;
        chatErrorMsg = null;
        renderProdChatThread();

        // Refresh title
        const convData = await api(
          `/api/conversations/${encodeURIComponent(botId)}/${activeChat.id}`
        );
        if (convData.conversation) {
          activeChat.title = convData.conversation.title;
          loadProductionsChats().then(() => {});
          renderProductionsChat();
        }
      }
    }, 2000);
  }

  function renderProdChatThread() {
    const container = document.getElementById('prod-chat-thread');
    if (!container || !activeChat) return;

    renderThread(container, {
      thread: chatMessages,
      generating: chatGenerating,
      error: chatErrorMsg,
      botId,
      onRetry: async () => {
        chatErrorMsg = null;
        chatGenerating = true;
        renderProdChatThread();
        await api(`/api/conversations/${encodeURIComponent(botId)}/${activeChat.id}/retry`, {
          method: 'POST',
        });
        startProdChatPolling();
      },
      onSend: async (text) => {
        chatMessages.push({
          id: `temp-${Date.now()}`,
          role: 'human',
          content: text,
          createdAt: new Date().toISOString(),
        });
        chatGenerating = true;
        chatErrorMsg = null;
        renderProdChatThread();

        const res = await api(
          `/api/conversations/${encodeURIComponent(botId)}/${activeChat.id}/messages`,
          {
            method: 'POST',
            body: { message: text },
          }
        );

        if (res.error) {
          chatGenerating = false;
          renderProdChatThread();
          return;
        }

        if (res.message) {
          const tempIdx = chatMessages.findIndex((m) => m.id.startsWith('temp-'));
          if (tempIdx !== -1) chatMessages[tempIdx] = res.message;
        }

        startProdChatPolling();
      },
    });
  }

  await loadProductionsChats();
}

async function showDetailModal(botId, entryId, onDelete) {
  showModal('<p class="text-dim">Loading...</p>');

  const data = await api(`/api/productions/${encodeURIComponent(botId)}/${entryId}`);
  if (data.error) {
    showModal(
      `<p class="text-dim">${escapeHtml(data.error)}</p><div class="modal-actions"><button class="btn" onclick="document.getElementById('modal-overlay').classList.add('hidden')">Close</button></div>`
    );
    return;
  }

  const { entry, content } = data;
  let currentRating = entry.evaluation?.rating || 0;
  let currentStatus = entry.evaluation?.status || '';
  let threadGenerating = false;
  let threadErrorMsg = null;
  const MODAL_MAX_POLLS = 90;

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
      <div class="form-section-title">Discussion</div>
      <div id="thread-container"></div>

      <div class="form-separator"></div>

      <div class="eval-controls">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
          <button class="btn btn-sm${currentStatus === 'approved' ? ' btn-primary' : ''}" id="eval-approve">Approve</button>
          <button class="btn btn-sm${currentStatus === 'rejected' ? ' btn-danger' : ''}" id="eval-reject">Reject</button>
          <span style="margin-left:12px">${starsHtml(currentRating, true)}</span>
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
        currentRating = Number.parseInt(star.dataset.star);
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
      if (!currentStatus && !currentRating) return; // nothing to save
      const btn = document.getElementById('eval-save');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      await api(`/api/productions/${encodeURIComponent(botId)}/${entryId}/evaluate`, {
        method: 'POST',
        body: {
          status: currentStatus || undefined,
          rating: currentRating || undefined,
        },
      });

      // Update entry in-place so badge reflects new status
      if (!entry.evaluation) entry.evaluation = { evaluatedAt: new Date().toISOString() };
      if (currentStatus) entry.evaluation.status = currentStatus;
      if (currentRating) entry.evaluation.rating = currentRating;

      btn.textContent = 'Saved';
      setTimeout(() => {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Save Evaluation';
        }
      }, 1500);
    });

    // Delete
    document.getElementById('eval-delete').addEventListener('click', async () => {
      if (!confirm('Delete this production and its file? This cannot be undone.')) return;
      await api(`/api/productions/${encodeURIComponent(botId)}/${entryId}`, { method: 'DELETE' });
      closeModal();
      if (onDelete) {
        onDelete();
      } else {
        const contentEl = document.getElementById('content');
        renderBotProductions(contentEl, botId);
      }
    });

    // Close
    document.getElementById('eval-cancel').addEventListener('click', closeModal);

    // Thread discussion
    const threadContainer = document.getElementById('thread-container');

    function startModalThreadPolling() {
      let pollCount = 0;
      const pollInterval = setInterval(async () => {
        if (!document.getElementById('thread-container')) {
          clearInterval(pollInterval);
          return;
        }
        pollCount++;
        if (pollCount >= MODAL_MAX_POLLS) {
          clearInterval(pollInterval);
          threadGenerating = false;
          threadErrorMsg = 'Response timed out (3 minutes). The bot may still be processing.';
          renderThreadUI();
          return;
        }
        const statusRes = await api(
          `/api/productions/${encodeURIComponent(botId)}/${entryId}/thread-status`
        );
        if (statusRes.status === 'error') {
          clearInterval(pollInterval);
          threadGenerating = false;
          threadErrorMsg = statusRes.error || 'Generation failed';
          renderThreadUI();
          return;
        }
        if (statusRes.status === 'idle') {
          clearInterval(pollInterval);
          if (statusRes.lastBotMessage) {
            if (!entry.evaluation.thread.find((m) => m.id === statusRes.lastBotMessage.id)) {
              entry.evaluation.thread.push(statusRes.lastBotMessage);
            }
          }
          threadGenerating = false;
          threadErrorMsg = null;
          renderThreadUI();
        }
      }, 2000);
    }

    function renderThreadUI() {
      if (!threadContainer) return;
      renderThread(threadContainer, {
        thread: entry.evaluation?.thread ?? [],
        legacyFeedback: entry.evaluation?.feedback || null,
        legacyResponse: entry.evaluation?.aiResponse || null,
        generating: threadGenerating,
        error: threadErrorMsg,
        botId,
        onRetry: async () => {
          threadErrorMsg = null;
          threadGenerating = true;
          renderThreadUI();
          await api(`/api/productions/${encodeURIComponent(botId)}/${entryId}/retry-thread`, {
            method: 'POST',
          });
          startModalThreadPolling();
        },
        onSend: async (text) => {
          // Optimistically add human message
          if (!entry.evaluation) entry.evaluation = { evaluatedAt: new Date().toISOString() };
          if (!entry.evaluation.thread) entry.evaluation.thread = [];
          entry.evaluation.thread.push({
            id: 'temp',
            role: 'human',
            content: text,
            createdAt: new Date().toISOString(),
          });
          threadGenerating = true;
          threadErrorMsg = null;
          renderThreadUI();

          const res = await api(`/api/productions/${encodeURIComponent(botId)}/${entryId}/thread`, {
            method: 'POST',
            body: { message: text },
          });

          if (res.error) {
            threadGenerating = false;
            renderThreadUI();
            return;
          }

          // Update entry with server response
          if (res.entry?.evaluation) entry.evaluation = res.entry.evaluation;

          startModalThreadPolling();
        },
      });
    }

    renderThreadUI();
  }

  render();
}
