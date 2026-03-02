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

// --- Polling intervals to clean up on navigation ---
let _prodIntervals = [];

export function destroyProductions() {
  for (const id of _prodIntervals) clearInterval(id);
  _prodIntervals = [];
}

export async function renderBotProductions(el, botId) {
  destroyProductions();
  el.innerHTML = '<div class="page-title">Productions</div><p class="text-dim">Loading...</p>';

  // Load tree + stats + bot list in parallel
  const [treeData, statsData, allBots] = await Promise.all([
    api(`/api/productions/${encodeURIComponent(botId)}/tree`),
    api(`/api/productions/${encodeURIComponent(botId)}`),
    api('/api/productions'),
  ]);

  if (statsData.error) {
    el.innerHTML = `
      <div class="page-title">Productions</div>
      <p class="text-dim">${escapeHtml(statsData.error)}</p>
      <a href="#/productions" class="btn btn-sm">&larr; Back</a>
    `;
    return;
  }

  const { stats } = statsData;
  const tree = treeData.tree || [];
  const botList = Array.isArray(allBots) ? allBots : [];

  // Explorer state
  const expandedDirs = new Set();
  let selectedFile = null;
  let searchFilter = '';
  let statusFilter = '';

  // Build the explorer layout
  el.innerHTML = `
    <div class="productions-explorer">
      <div class="prod-topbar">
        <div style="display:flex;gap:12px;align-items:center">
          <a href="#/productions" class="btn btn-sm">&larr; Back</a>
          <select id="prod-bot-selector" class="log-agent-filter">
            ${botList.map((b) => `<option value="${escapeHtml(b.botId)}"${b.botId === botId ? ' selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}
          </select>
        </div>
        <div class="prod-topbar-stats">
          <div class="stat-item"><strong>${stats.total}</strong> <span class="text-dim">Total</span></div>
          <div class="stat-item"><span style="color:var(--green)">${stats.approved}</span> <span class="text-dim">Approved</span></div>
          <div class="stat-item"><span style="color:var(--red)">${stats.rejected}</span> <span class="text-dim">Rejected</span></div>
          <div class="stat-item"><span style="color:var(--orange)">${stats.unreviewed}</span> <span class="text-dim">Unreviewed</span></div>
          ${stats.avgRating != null ? `<div class="stat-item">${starsHtml(Math.round(stats.avgRating))} <span class="text-dim">${stats.avgRating}</span></div>` : ''}
          <button class="btn btn-sm" id="generate-summary-btn">Summary</button>
        </div>
      </div>

      <div class="prod-explorer-body">
        <div class="prod-tree-panel">
          <input type="text" class="prod-tree-search" id="prod-tree-search" placeholder="Filter files...">
          <select id="prod-status-filter" class="log-agent-filter" style="width:100%;margin-bottom:8px">
            <option value="">All Status</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="unreviewed">Unreviewed</option>
          </select>
          <div id="prod-tree-container"></div>
        </div>
        <div class="prod-content-panel" id="prod-content-panel">
          <div class="prod-empty-state">Select a file to view its content</div>
        </div>
      </div>

      <div id="prod-bottom-section"></div>
    </div>
  `;

  // --- Bot selector ---
  document.getElementById('prod-bot-selector')?.addEventListener('change', (e) => {
    location.hash = '#/productions/' + encodeURIComponent(e.target.value);
  });

  // --- Tree rendering ---
  function matchesFilters(node) {
    if (node.type === 'dir') {
      return node.children?.some(matchesFilters) ?? false;
    }
    if (
      searchFilter &&
      !node.name.toLowerCase().includes(searchFilter.toLowerCase()) &&
      !node.path.toLowerCase().includes(searchFilter.toLowerCase())
    ) {
      return false;
    }
    if (statusFilter) {
      const evalStatus = node.evaluation?.status;
      if (statusFilter === 'unreviewed' && evalStatus) return false;
      if (statusFilter === 'approved' && evalStatus !== 'approved') return false;
      if (statusFilter === 'rejected' && evalStatus !== 'rejected') return false;
    }
    return true;
  }

  function renderTree(container, nodes) {
    container.innerHTML = '';
    for (const node of nodes) {
      if (!matchesFilters(node)) continue;
      renderTreeNode(container, node);
    }
    if (container.childElementCount === 0) {
      container.innerHTML =
        '<p class="text-dim" style="padding:8px;font-size:12px">No files match filters</p>';
    }
  }

  function renderTreeNode(parent, node) {
    if (node.type === 'dir') {
      const isExpanded = expandedDirs.has(node.path);
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.innerHTML = `<span class="tree-chevron${isExpanded ? ' expanded' : ''}">&#9654;</span> ${escapeHtml(node.name)}/`;
      item.addEventListener('click', () => {
        if (expandedDirs.has(node.path)) {
          expandedDirs.delete(node.path);
        } else {
          expandedDirs.add(node.path);
        }
        renderTree(document.getElementById('prod-tree-container'), tree);
      });
      parent.appendChild(item);

      if (isExpanded && node.children) {
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        for (const child of node.children) {
          if (!matchesFilters(child)) continue;
          renderTreeNode(childContainer, child);
        }
        parent.appendChild(childContainer);
      }
    } else {
      if (!matchesFilters(node)) return;
      const item = document.createElement('div');
      const isSelected = selectedFile?.path === node.path;
      item.className = `tree-item${isSelected ? ' selected' : ''}`;

      let dotHtml = '';
      if (node.evaluation?.status === 'approved')
        dotHtml = '<span class="tree-dot tree-dot-approved"></span>';
      else if (node.evaluation?.status === 'rejected')
        dotHtml = '<span class="tree-dot tree-dot-rejected"></span>';
      else if (node.entryId) dotHtml = '<span class="tree-dot tree-dot-unreviewed"></span>';

      item.innerHTML = `<span style="width:14px;flex-shrink:0"></span>${dotHtml} ${escapeHtml(node.name)}`;
      item.title = node.description || node.path;
      item.addEventListener('click', () => {
        selectedFile = node;
        renderTree(document.getElementById('prod-tree-container'), tree);
        renderFileViewer(botId, node);
      });
      parent.appendChild(item);
    }
  }

  // --- File viewer ---
  async function renderFileViewer(botId, node) {
    const panel = document.getElementById('prod-content-panel');
    if (!panel) return;
    panel.innerHTML = '<p class="text-dim">Loading...</p>';

    // Load content either via entryId or by path
    let content = null;
    let entry = null;
    if (node.entryId) {
      const data = await api(`/api/productions/${encodeURIComponent(botId)}/${node.entryId}`);
      if (!data.error) {
        content = data.content;
        entry = data.entry;
      }
    }
    if (content == null) {
      const data = await api(
        `/api/productions/${encodeURIComponent(botId)}/file-content?path=${encodeURIComponent(node.path)}`
      );
      if (!data.error) content = data.content;
    }

    let currentRating = entry?.evaluation?.rating || 0;
    let currentStatus = entry?.evaluation?.status || '';
    let threadGenerating = false;
    let threadErrorMsg = null;
    const VIEWER_MAX_POLLS = 90;

    function renderViewer() {
      panel.innerHTML = `
        <div class="prod-file-viewer-title">${escapeHtml(node.path)}</div>
        ${
          entry
            ? `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;font-size:12px">
          <span class="text-dim">${new Date(entry.timestamp).toLocaleString()}</span>
          <span class="text-dim">${escapeHtml(entry.tool)} / ${escapeHtml(entry.action)}</span>
          ${entry.trackOnly ? '<span class="badge badge-disabled">track-only</span>' : ''}
          ${statusBadge(entry)}
        </div>`
            : ''
        }

        <div class="production-content" style="max-height:400px">${content != null ? `<pre>${escapeHtml(content)}</pre>` : '<p class="text-dim" style="padding:12px">File not found or empty</p>'}</div>

        ${
          entry
            ? `
          <div class="eval-controls" style="margin-top:16px">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
              <button class="btn btn-sm${currentStatus === 'approved' ? ' btn-primary' : ''}" id="viewer-approve">Approve</button>
              <button class="btn btn-sm${currentStatus === 'rejected' ? ' btn-danger' : ''}" id="viewer-reject">Reject</button>
              <span style="margin-left:12px">${starsHtml(currentRating, true)}</span>
              <button class="btn btn-primary btn-sm" id="viewer-save" style="margin-left:auto">Save</button>
              <button class="btn btn-danger btn-sm" id="viewer-delete">Delete</button>
            </div>
          </div>

          <div class="form-separator"></div>
          <div class="form-section-title">Discussion</div>
          <div id="viewer-thread-container"></div>
        `
            : `<div style="margin-top:12px"><span class="text-dim text-sm">This file is not tracked in the changelog.</span></div>`
        }
      `;

      if (!entry) return;

      // Star rating
      panel.querySelectorAll('.star-interactive .star').forEach((star) => {
        star.style.cursor = 'pointer';
        star.addEventListener('click', () => {
          currentRating = Number.parseInt(star.dataset.star);
          renderViewer();
        });
      });

      // Approve/Reject
      document.getElementById('viewer-approve')?.addEventListener('click', () => {
        currentStatus = 'approved';
        renderViewer();
      });
      document.getElementById('viewer-reject')?.addEventListener('click', () => {
        currentStatus = 'rejected';
        renderViewer();
      });

      // Save
      document.getElementById('viewer-save')?.addEventListener('click', async () => {
        if (!currentStatus && !currentRating) return;
        const btn = document.getElementById('viewer-save');
        btn.disabled = true;
        btn.textContent = 'Saving...';

        await api(`/api/productions/${encodeURIComponent(botId)}/${entry.id}/evaluate`, {
          method: 'POST',
          body: { status: currentStatus || undefined, rating: currentRating || undefined },
        });

        if (!entry.evaluation) entry.evaluation = { evaluatedAt: new Date().toISOString() };
        if (currentStatus) entry.evaluation.status = currentStatus;
        if (currentRating) entry.evaluation.rating = currentRating;

        // Update tree dot
        if (node.entryId) {
          node.evaluation = { status: currentStatus, rating: currentRating };
          renderTree(document.getElementById('prod-tree-container'), tree);
        }

        btn.textContent = 'Saved';
        setTimeout(() => {
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Save';
          }
        }, 1500);
      });

      // Delete
      document.getElementById('viewer-delete')?.addEventListener('click', async () => {
        if (!confirm('Delete this production and its file? This cannot be undone.')) return;
        await api(`/api/productions/${encodeURIComponent(botId)}/${entry.id}`, {
          method: 'DELETE',
        });
        selectedFile = null;
        // Reload tree
        const freshTree = await api(`/api/productions/${encodeURIComponent(botId)}/tree`);
        tree.length = 0;
        tree.push(...(freshTree.tree || []));
        renderTree(document.getElementById('prod-tree-container'), tree);
        panel.innerHTML = '<div class="prod-empty-state">File deleted. Select another file.</div>';
      });

      // Thread
      const threadContainer = document.getElementById('viewer-thread-container');

      function startViewerThreadPolling() {
        let pollCount = 0;
        const interval = setInterval(async () => {
          if (!document.getElementById('viewer-thread-container')) {
            clearInterval(interval);
            return;
          }
          pollCount++;
          if (pollCount >= VIEWER_MAX_POLLS) {
            clearInterval(interval);
            threadGenerating = false;
            threadErrorMsg = 'Response timed out (3 minutes).';
            renderViewerThread();
            return;
          }
          const statusRes = await api(
            `/api/productions/${encodeURIComponent(botId)}/${entry.id}/thread-status`
          );
          if (statusRes.status === 'error') {
            clearInterval(interval);
            threadGenerating = false;
            threadErrorMsg = statusRes.error || 'Generation failed';
            renderViewerThread();
            return;
          }
          if (statusRes.status === 'idle') {
            clearInterval(interval);
            if (statusRes.lastBotMessage) {
              if (!entry.evaluation?.thread?.find((m) => m.id === statusRes.lastBotMessage.id)) {
                if (!entry.evaluation) entry.evaluation = { evaluatedAt: new Date().toISOString() };
                if (!entry.evaluation.thread) entry.evaluation.thread = [];
                entry.evaluation.thread.push(statusRes.lastBotMessage);
              }
            }
            threadGenerating = false;
            threadErrorMsg = null;
            renderViewerThread();
          }
        }, 2000);
        _prodIntervals.push(interval);
      }

      function renderViewerThread() {
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
            renderViewerThread();
            await api(`/api/productions/${encodeURIComponent(botId)}/${entry.id}/retry-thread`, {
              method: 'POST',
            });
            startViewerThreadPolling();
          },
          onSend: async (text) => {
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
            renderViewerThread();

            const res = await api(
              `/api/productions/${encodeURIComponent(botId)}/${entry.id}/thread`,
              { method: 'POST', body: { message: text } }
            );
            if (res.error) {
              threadGenerating = false;
              renderViewerThread();
              return;
            }
            if (res.entry?.evaluation) entry.evaluation = res.entry.evaluation;
            startViewerThreadPolling();
          },
        });
      }

      renderViewerThread();
    }

    renderViewer();
  }

  // --- Filters ---
  document.getElementById('prod-tree-search')?.addEventListener('input', (e) => {
    searchFilter = e.target.value;
    renderTree(document.getElementById('prod-tree-container'), tree);
  });
  document.getElementById('prod-status-filter')?.addEventListener('change', (e) => {
    statusFilter = e.target.value;
    renderTree(document.getElementById('prod-tree-container'), tree);
  });

  // Initial tree render — auto-expand if few dirs
  function countDirs(nodes) {
    let n = 0;
    for (const node of nodes) {
      if (node.type === 'dir') {
        n++;
        n += countDirs(node.children || []);
      }
    }
    return n;
  }
  if (countDirs(tree) <= 5) {
    // Auto-expand all dirs
    function expandAll(nodes) {
      for (const node of nodes) {
        if (node.type === 'dir') {
          expandedDirs.add(node.path);
          expandAll(node.children || []);
        }
      }
    }
    expandAll(tree);
  }
  renderTree(document.getElementById('prod-tree-container'), tree);

  // --- Summary (collapsible at bottom) ---
  const bottomSection = document.getElementById('prod-bottom-section');
  if (bottomSection) {
    bottomSection.innerHTML = `
      <div class="form-separator"></div>
      <div id="summary-container" class="mb-16"></div>
      <div id="productions-chat-section" class="mb-16"></div>
    `;
  }

  // Summary polling
  function checkSummaryStatus(id) {
    const btn = document.getElementById('generate-summary-btn');
    const container = document.getElementById('summary-container');
    if (!btn || !container) return Promise.resolve('gone');

    return api(`/api/productions/${encodeURIComponent(id)}/summary-status`).then((res) => {
      if (!document.getElementById('generate-summary-btn')) return 'gone';
      if (res.status === 'generating') {
        btn.disabled = true;
        btn.textContent = 'Generating...';
        container.innerHTML = '<p class="text-dim">Analyzing productions...</p>';
      } else if (res.status === 'done') {
        btn.disabled = false;
        btn.textContent = 'Summary';
        container.innerHTML = `<div class="detail-card" style="white-space:pre-wrap">${escapeHtml(res.summary)}</div>`;
      } else if (res.status === 'error') {
        btn.disabled = false;
        btn.textContent = 'Summary';
        container.innerHTML = `<div class="detail-card" style="border-color:var(--red)"><p class="text-dim">${escapeHtml(res.error)}</p></div>`;
      } else {
        btn.disabled = false;
        btn.textContent = 'Summary';
      }
      return res.status;
    });
  }

  function startSummaryPolling(id) {
    const interval = setInterval(async () => {
      const status = await checkSummaryStatus(id);
      if (status !== 'generating') clearInterval(interval);
    }, 3000);
    _prodIntervals.push(interval);
  }

  const summaryBtn = document.getElementById('generate-summary-btn');
  if (summaryBtn) {
    checkSummaryStatus(botId).then((status) => {
      if (status === 'generating') startSummaryPolling(botId);
    });
    summaryBtn.addEventListener('click', async () => {
      summaryBtn.disabled = true;
      summaryBtn.textContent = 'Generating...';
      const container = document.getElementById('summary-container');
      if (container) container.innerHTML = '<p class="text-dim">Analyzing productions...</p>';
      try {
        await api(`/api/productions/${encodeURIComponent(botId)}/generate-summary`, {
          method: 'POST',
        });
        startSummaryPolling(botId);
      } catch (err) {
        if (container)
          container.innerHTML = `<div class="detail-card" style="border-color:var(--red)"><p class="text-dim">Request failed: ${escapeHtml(String(err))}</p></div>`;
        summaryBtn.disabled = false;
        summaryBtn.textContent = 'Summary';
      }
    });
  }

  // --- Productions Chat section ---
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
      <div class="flex-between mb-16">
        <div class="form-section-title">Productions Chat</div>
        <button class="btn btn-primary btn-sm" id="new-prod-chat-btn">New Chat</button>
      </div>
      ${
        chatConvos.length > 0 && !activeChat
          ? `<div id="prod-chat-list" class="mb-16">
        ${chatConvos
          .map(
            (c) => `
          <div class="detail-card mb-8 prod-chat-item" data-id="${c.id}" style="cursor:pointer;padding:10px 14px;display:flex;justify-content:space-between;align-items:center">
            <div><strong>${escapeHtml(c.title)}</strong> <span class="text-dim text-sm" style="margin-left:8px">${c.messageCount} messages</span></div>
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
      ${!activeChat && chatConvos.length === 0 ? '<p class="text-dim">No productions chats yet. Start a conversation about this bot\'s work.</p>' : ''}`;

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
    document.getElementById('prod-chat-back-btn')?.addEventListener('click', () => {
      activeChat = null;
      loadProductionsChats();
    });
    document.querySelectorAll('.prod-chat-item').forEach((item) => {
      item.addEventListener('click', async () => {
        const data = await api(
          `/api/conversations/${encodeURIComponent(botId)}/${item.dataset.id}`
        );
        if (data.conversation) {
          activeChat = data.conversation;
          chatMessages = data.messages || [];
          chatGenerating = false;
          renderProductionsChat();
        }
      });
    });
    if (activeChat) renderProdChatThread();
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
        chatErrorMsg = 'Response timed out (3 minutes).';
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
        if (
          statusRes.lastBotMessage &&
          !chatMessages.find((m) => m.id === statusRes.lastBotMessage.id)
        )
          chatMessages.push(statusRes.lastBotMessage);
        chatGenerating = false;
        chatErrorMsg = null;
        renderProdChatThread();
        const convData = await api(
          `/api/conversations/${encodeURIComponent(botId)}/${activeChat.id}`
        );
        if (convData.conversation) {
          activeChat.title = convData.conversation.title;
          loadProductionsChats();
        }
      }
    }, 2000);
    _prodIntervals.push(pollInterval);
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
          { method: 'POST', body: { message: text } }
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
