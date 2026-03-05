import {
  api,
  closeModal,
  escapeHtml,
  renderContent,
  renderThread,
  showModal,
  timeAgo,
} from './shared.js';

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

function getHashParams() {
  const idx = location.hash.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(location.hash.slice(idx + 1)));
}

function findNodeInTree(nodes, targetPath, botId, parentKeys, getExpandKey) {
  for (const node of nodes || []) {
    if (node.type === 'dir') {
      const key = getExpandKey(node, botId);
      const found = findNodeInTree(
        node.children,
        targetPath,
        botId,
        [...parentKeys, key],
        getExpandKey
      );
      if (found) return found;
    } else if (node.path === targetPath) {
      return { node, botId, parentKeys };
    }
  }
  return null;
}

export async function renderProductions(el) {
  destroyProductions();
  el.innerHTML = '<div class="page-title">Productions</div><p class="text-dim">Loading...</p>';

  const [stats, treeData] = await Promise.all([
    api('/api/productions'),
    api('/api/productions/all-trees'),
  ]);

  if (stats.error) {
    el.innerHTML = `
      <div class="page-title">Productions</div>
      <p class="text-dim">Productions are not enabled. Set <code>productions.enabled: true</code> in config.</p>
    `;
    return;
  }

  const total = stats.reduce((s, b) => s + b.total, 0);
  const tree = Array.isArray(treeData.tree) ? treeData.tree : [];

  // Build botId→name map from stats and a botId set from tree top-level nodes
  const botNameMap = {};
  const botIdFromName = {};
  for (const bot of stats) {
    botNameMap[bot.botId] = bot.name;
  }
  for (const node of tree) {
    // Top-level nodes: name is bot name, path is botId
    botIdFromName[node.name] = node.path;
  }

  // Explorer state — restore from localStorage if available
  const STORAGE_KEY = 'prod-expanded-all';
  const expandedDirs = new Set();
  let selectedFile = null;
  let searchFilter = '';
  let statusFilter = '';

  function saveExpandState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...expandedDirs]));
    } catch {}
  }

  function collectAllDirKeys(nodes, botId) {
    const keys = [];
    for (const node of nodes || []) {
      if (node.type === 'dir') {
        const isTopLevel = tree.includes(node);
        const key = isTopLevel ? node.path : `${botId}/${node.path}`;
        keys.push(key);
        keys.push(...collectAllDirKeys(node.children, isTopLevel ? node.path : botId));
      }
    }
    return keys;
  }

  el.innerHTML = `
    <div class="productions-explorer">
      <div class="prod-topbar">
        <div style="display:flex;gap:12px;align-items:center">
          <div class="page-title" style="margin-bottom:0">Productions <span class="count">${total}</span></div>
        </div>
        <div class="prod-topbar-stats">
          ${stats.map((b) => `<div class="stat-item"><a href="#/productions/${encodeURIComponent(b.botId)}">${escapeHtml(b.name)}</a> <span class="text-dim">${b.total}</span></div>`).join('')}
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
            <option value="checked">Checked</option>
          </select>
          <div class="prod-tree-toolbar">
            <button class="btn btn-sm" id="prod-expand-all">Expand all</button>
            <button class="btn btn-sm" id="prod-collapse-all">Collapse all</button>
          </div>
          <div id="prod-tree-container"></div>
        </div>
        <div class="prod-content-panel" id="prod-content-panel">
          <div class="prod-empty-state">Select a file to view its content</div>
        </div>
      </div>
    </div>
  `;

  if (stats.length === 0) {
    el.innerHTML = `
      <div class="page-title">Productions</div>
      <p class="text-dim">No productions yet. Bots will log file operations here when they create or edit files.</p>
    `;
    return;
  }

  // --- Tree rendering (same pattern as bot-level explorer) ---
  function matchesFilters(node) {
    if (node.type === 'dir') {
      if (!searchFilter && !statusFilter) return true;
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
      if (statusFilter === 'checked' && !node.coherenceCheck) return false;
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
      renderTreeNode(container, node, null);
    }
    if (container.childElementCount === 0) {
      container.innerHTML =
        '<p class="text-dim" style="padding:8px;font-size:12px">No files match filters</p>';
    }
  }

  function renderTreeNode(parent, node, botId) {
    if (node.type === 'dir') {
      // Top-level dirs are bot folders (path = botId)
      const isTopLevel = tree.includes(node);
      const resolvedBotId = isTopLevel ? node.path : botId;
      const expandKey = isTopLevel ? node.path : `${resolvedBotId}/${node.path}`;
      const isExpanded = expandedDirs.has(expandKey);
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.innerHTML = `<span class="tree-chevron${isExpanded ? ' expanded' : ''}">&#9654;</span> ${escapeHtml(node.name)}/`;
      if (isTopLevel) {
        item.style.fontWeight = '600';
      }
      item.addEventListener('click', () => {
        if (expandedDirs.has(expandKey)) {
          expandedDirs.delete(expandKey);
        } else {
          expandedDirs.add(expandKey);
        }
        saveExpandState();
        renderTree(document.getElementById('prod-tree-container'), tree);
      });
      parent.appendChild(item);

      if (isExpanded && node.children) {
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        for (const child of node.children) {
          if (!matchesFilters(child)) continue;
          renderTreeNode(childContainer, child, resolvedBotId);
        }
        parent.appendChild(childContainer);
      }
    } else {
      if (!matchesFilters(node)) return;
      const item = document.createElement('div');
      const isSelected = selectedFile?.path === node.path && selectedFile?._botId === botId;
      item.className = `tree-item${isSelected ? ' selected' : ''}`;

      let statusDotHtml = '';
      if (node.evaluation?.status === 'approved')
        statusDotHtml = '<span class="tree-dot tree-dot-approved"></span>';
      else if (node.evaluation?.status === 'rejected')
        statusDotHtml = '<span class="tree-dot tree-dot-rejected"></span>';
      else if (node.entryId) statusDotHtml = '<span class="tree-dot tree-dot-unreviewed"></span>';

      let coherenceDotHtml = '';
      if (node.coherenceCheck) {
        coherenceDotHtml = node.coherenceCheck.coherent
          ? '<span class="tree-dot tree-dot-coherent" title="Coherent"></span>'
          : '<span class="tree-dot tree-dot-incoherent" title="Incoherent"></span>';
      }

      const dotHtml = statusDotHtml + coherenceDotHtml;
      item.innerHTML = `<span style="width:14px;flex-shrink:0"></span>${dotHtml} ${escapeHtml(node.name)}`;
      item.title = node.description || node.path;
      item.addEventListener('click', () => {
        selectedFile = { ...node, _botId: botId };
        history.replaceState(
          null,
          '',
          `#/productions?bot=${encodeURIComponent(botId)}&file=${encodeURIComponent(node.path)}`
        );
        renderTree(document.getElementById('prod-tree-container'), tree);
        renderFileViewer(botId, node);
      });
      parent.appendChild(item);
    }
  }

  // --- File viewer (same as bot-level but resolves botId from tree context) ---
  async function renderFileViewer(botId, node) {
    const panel = document.getElementById('prod-content-panel');
    if (!panel) return;
    panel.innerHTML = '<p class="text-dim">Loading...</p>';

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
    let coherenceResult = null;
    let coherencePolling = false;
    const VIEWER_MAX_POLLS = 90;

    function updateCoherenceBadge(r) {
      const b = document.getElementById('viewer-coherence-badge');
      if (!b) return;
      if (r.coherent) {
        const tip = r.explanation ? ` title="${escapeHtml(r.explanation)}"` : '';
        b.innerHTML = `<span class="badge eval-badge-checked"${tip}>Checked</span>`;
      } else {
        b.innerHTML = `<span class="badge eval-badge-rejected" title="${escapeHtml(r.issues.join('; '))}">${escapeHtml('Incoherent')}</span>`;
      }
    }

    function updateTreeCoherence(r) {
      node.coherenceCheck = { coherent: r.coherent };
      renderTree(document.getElementById('prod-tree-container'), tree);
    }

    // Fetch coherence check in background (LLM-based, may need polling)
    function fetchCoherence() {
      if (!entry) return;
      const badge = document.getElementById('viewer-coherence-badge');
      api(`/api/productions/${encodeURIComponent(botId)}/${entry.id}/coherence`).then((res) => {
        if (res.error) return;
        if (res.status === 'checking') {
          if (badge) badge.innerHTML = '<span class="badge badge-disabled">Checking\u2026</span>';
          if (!coherencePolling) {
            coherencePolling = true;
            const pollId = setInterval(() => {
              api(`/api/productions/${encodeURIComponent(botId)}/${entry.id}/coherence`).then(
                (r) => {
                  if (r.status === 'checking') return;
                  clearInterval(pollId);
                  coherencePolling = false;
                  if (r.status === 'error') {
                    const b = document.getElementById('viewer-coherence-badge');
                    if (b)
                      b.innerHTML =
                        '<span class="badge badge-disabled" title="Coherence check failed">Error</span>';
                    return;
                  }
                  coherenceResult = r;
                  updateCoherenceBadge(r);
                  updateTreeCoherence(r);
                }
              );
            }, 3000);
          }
        } else {
          coherenceResult = res;
          updateCoherenceBadge(res);
          if (!node.coherenceCheck) updateTreeCoherence(res);
        }
      });
    }
    fetchCoherence();

    function renderViewer() {
      const botLabel = botNameMap[botId] || botId;
      panel.innerHTML = `
        <div class="prod-file-viewer-title">
          <a href="#/productions/${encodeURIComponent(botId)}" style="font-size:13px;font-weight:400">${escapeHtml(botLabel)}</a> / ${escapeHtml(node.path)}
        </div>
        ${
          entry
            ? `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;font-size:12px;align-items:center">
          <span class="text-dim">${new Date(entry.timestamp).toLocaleString()}</span>
          <span class="text-dim">${escapeHtml(entry.tool)} / ${escapeHtml(entry.action)}</span>
          ${entry.trackOnly ? '<span class="badge badge-disabled">track-only</span>' : ''}
          ${statusBadge(entry)}
          ${entry.coherenceCheck ? `<span class="badge eval-badge-checked"${entry.coherenceCheck.explanation ? ` title="${escapeHtml(entry.coherenceCheck.explanation)}"` : ''}>Checked</span>` : ''}
          <span id="viewer-coherence-badge">${coherencePolling ? '<span class="badge badge-disabled">Checking\u2026</span>' : coherenceResult ? (coherenceResult.coherent ? `<span class="badge eval-badge-checked"${coherenceResult.explanation ? ` title="${escapeHtml(coherenceResult.explanation)}"` : ''}>Checked</span>` : `<span class="badge eval-badge-rejected" title="${escapeHtml(coherenceResult.issues.join('; '))}">${escapeHtml('Incoherent')}</span>`) : ''}</span>
        </div>`
            : ''
        }

        <div class="production-content" style="max-height:400px">${content != null ? renderContent(content, node.name) : '<p class="text-dim" style="padding:12px">File not found or empty</p>'}</div>

        ${
          entry
            ? `
          <div class="eval-controls" style="margin-top:16px">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
              <button class="btn btn-sm${currentStatus === 'approved' ? ' btn-primary' : ''}" id="viewer-approve">Approve</button>
              <button class="btn btn-sm${currentStatus === 'rejected' ? ' btn-danger' : ''}" id="viewer-reject">Reject</button>
              <span style="margin-left:12px">${starsHtml(currentRating, true)}</span>
              <button class="btn btn-primary btn-sm" id="viewer-save" style="margin-left:auto">Save</button>
              <button class="btn btn-sm" id="viewer-archive" title="Move to archived/">Archive</button>
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

      // Archive
      document.getElementById('viewer-archive')?.addEventListener('click', () => {
        showModal(
          'Archive Production',
          `
          <p style="margin-bottom:12px">Move <strong>${escapeHtml(entry.path)}</strong> to <code>archived/</code>.</p>
          <label class="form-label">Reason</label>
          <input type="text" id="archive-reason" class="form-input" placeholder="Why are you archiving this file?" style="width:100%;margin-bottom:12px">
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-sm" id="archive-cancel">Cancel</button>
            <button class="btn btn-primary btn-sm" id="archive-confirm">Archive</button>
          </div>
        `
        );
        document.getElementById('archive-cancel')?.addEventListener('click', closeModal);
        document.getElementById('archive-confirm')?.addEventListener('click', async () => {
          const reason =
            document.getElementById('archive-reason')?.value?.trim() || 'Archived from dashboard';
          const confirmBtn = document.getElementById('archive-confirm');
          if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Archiving...';
          }
          await api(`/api/productions/${encodeURIComponent(botId)}/${entry.id}/archive`, {
            method: 'POST',
            body: { reason },
          });
          closeModal();
          selectedFile = null;
          history.replaceState(null, '', '#/productions');
          const freshTree = await api('/api/productions/all-trees');
          tree.length = 0;
          tree.push(...(freshTree.tree || []));
          renderTree(document.getElementById('prod-tree-container'), tree);
          panel.innerHTML =
            '<div class="prod-empty-state">File archived. Select another file.</div>';
        });
      });

      // Delete
      document.getElementById('viewer-delete')?.addEventListener('click', async () => {
        if (!confirm('Delete this production and its file? This cannot be undone.')) return;
        await api(`/api/productions/${encodeURIComponent(botId)}/${entry.id}`, {
          method: 'DELETE',
        });
        selectedFile = null;
        history.replaceState(null, '', '#/productions');
        // Reload tree
        const freshTree = await api('/api/productions/all-trees');
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

  // --- Expand / Collapse buttons ---
  document.getElementById('prod-expand-all')?.addEventListener('click', () => {
    for (const key of collectAllDirKeys(tree, null)) expandedDirs.add(key);
    saveExpandState();
    renderTree(document.getElementById('prod-tree-container'), tree);
  });
  document.getElementById('prod-collapse-all')?.addEventListener('click', () => {
    expandedDirs.clear();
    saveExpandState();
    renderTree(document.getElementById('prod-tree-container'), tree);
  });

  // Restore expand state from localStorage, or auto-expand everything as default
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) {
      for (const key of saved) expandedDirs.add(key);
    }
  } catch {}
  if (expandedDirs.size === 0) {
    // Default: auto-expand all
    for (const key of collectAllDirKeys(tree, null)) expandedDirs.add(key);
    saveExpandState();
  }
  renderTree(document.getElementById('prod-tree-container'), tree);

  // Restore selected file from URL hash params
  const hashParams = getHashParams();
  if (hashParams.bot && hashParams.file) {
    const targetBotId = hashParams.bot;
    // Find the bot's top-level node in the tree
    const botNode = tree.find((n) => n.path === targetBotId);
    if (botNode) {
      const expandKeyFn = (dirNode, bId) => {
        const isTopLevel = tree.includes(dirNode);
        return isTopLevel ? dirNode.path : `${bId}/${dirNode.path}`;
      };
      const result = findNodeInTree(
        botNode.children,
        hashParams.file,
        targetBotId,
        [botNode.path],
        expandKeyFn
      );
      if (result) {
        for (const key of result.parentKeys) expandedDirs.add(key);
        saveExpandState();
        selectedFile = { ...result.node, _botId: targetBotId };
        renderTree(document.getElementById('prod-tree-container'), tree);
        renderFileViewer(targetBotId, result.node);
      }
    }
  }
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
  const tree = Array.isArray(treeData.tree) ? treeData.tree : [];
  const botList = Array.isArray(allBots) ? allBots : [];

  // Explorer state — restore from localStorage if available
  const BOT_STORAGE_KEY = `prod-expanded-${botId}`;
  const expandedDirs = new Set();
  let selectedFile = null;
  let searchFilter = '';
  let statusFilter = '';

  function saveExpandState() {
    try {
      localStorage.setItem(BOT_STORAGE_KEY, JSON.stringify([...expandedDirs]));
    } catch {}
  }

  function collectAllDirKeys(nodes) {
    const keys = [];
    for (const node of nodes || []) {
      if (node.type === 'dir') {
        keys.push(node.path);
        keys.push(...collectAllDirKeys(node.children));
      }
    }
    return keys;
  }

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
            <option value="checked">Checked</option>
          </select>
          <div class="prod-tree-toolbar">
            <button class="btn btn-sm" id="prod-expand-all">Expand all</button>
            <button class="btn btn-sm" id="prod-collapse-all">Collapse all</button>
          </div>
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
    location.hash = `#/productions/${encodeURIComponent(e.target.value)}`;
  });

  // --- Tree rendering ---
  function matchesFilters(node) {
    if (node.type === 'dir') {
      if (!searchFilter && !statusFilter) return true;
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
      if (statusFilter === 'checked' && !node.coherenceCheck) return false;
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
        saveExpandState();
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

      let statusDotHtml = '';
      if (node.evaluation?.status === 'approved')
        statusDotHtml = '<span class="tree-dot tree-dot-approved"></span>';
      else if (node.evaluation?.status === 'rejected')
        statusDotHtml = '<span class="tree-dot tree-dot-rejected"></span>';
      else if (node.entryId) statusDotHtml = '<span class="tree-dot tree-dot-unreviewed"></span>';

      let coherenceDotHtml = '';
      if (node.coherenceCheck) {
        coherenceDotHtml = node.coherenceCheck.coherent
          ? '<span class="tree-dot tree-dot-coherent" title="Coherent"></span>'
          : '<span class="tree-dot tree-dot-incoherent" title="Incoherent"></span>';
      }

      const dotHtml = statusDotHtml + coherenceDotHtml;
      item.innerHTML = `<span style="width:14px;flex-shrink:0"></span>${dotHtml} ${escapeHtml(node.name)}`;
      item.title = node.description || node.path;
      item.addEventListener('click', () => {
        selectedFile = node;
        history.replaceState(
          null,
          '',
          `#/productions/${encodeURIComponent(botId)}?file=${encodeURIComponent(node.path)}`
        );
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
    let coherenceResult = null;
    let coherencePolling = false;
    const VIEWER_MAX_POLLS = 90;

    function updateCoherenceBadge(r) {
      const b = document.getElementById('viewer-coherence-badge');
      if (!b) return;
      if (r.coherent) {
        const tip = r.explanation ? ` title="${escapeHtml(r.explanation)}"` : '';
        b.innerHTML = `<span class="badge eval-badge-checked"${tip}>Checked</span>`;
      } else {
        b.innerHTML = `<span class="badge eval-badge-rejected" title="${escapeHtml(r.issues.join('; '))}">${escapeHtml('Incoherent')}</span>`;
      }
    }

    function updateTreeCoherence(r) {
      node.coherenceCheck = { coherent: r.coherent };
      renderTree(document.getElementById('prod-tree-container'), tree);
    }

    // Fetch coherence check in background (LLM-based, may need polling)
    function fetchCoherence() {
      if (!entry) return;
      const badge = document.getElementById('viewer-coherence-badge');
      api(`/api/productions/${encodeURIComponent(botId)}/${entry.id}/coherence`).then((res) => {
        if (res.error) return;
        if (res.status === 'checking') {
          if (badge) badge.innerHTML = '<span class="badge badge-disabled">Checking\u2026</span>';
          if (!coherencePolling) {
            coherencePolling = true;
            const pollId = setInterval(() => {
              api(`/api/productions/${encodeURIComponent(botId)}/${entry.id}/coherence`).then(
                (r) => {
                  if (r.status === 'checking') return;
                  clearInterval(pollId);
                  coherencePolling = false;
                  if (r.status === 'error') {
                    const b = document.getElementById('viewer-coherence-badge');
                    if (b)
                      b.innerHTML =
                        '<span class="badge badge-disabled" title="Coherence check failed">Error</span>';
                    return;
                  }
                  coherenceResult = r;
                  updateCoherenceBadge(r);
                  updateTreeCoherence(r);
                }
              );
            }, 3000);
          }
        } else {
          coherenceResult = res;
          updateCoherenceBadge(res);
          if (!node.coherenceCheck) updateTreeCoherence(res);
        }
      });
    }
    fetchCoherence();

    function renderViewer() {
      panel.innerHTML = `
        <div class="prod-file-viewer-title">${escapeHtml(node.path)}</div>
        ${
          entry
            ? `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;font-size:12px;align-items:center">
          <span class="text-dim">${new Date(entry.timestamp).toLocaleString()}</span>
          <span class="text-dim">${escapeHtml(entry.tool)} / ${escapeHtml(entry.action)}</span>
          ${entry.trackOnly ? '<span class="badge badge-disabled">track-only</span>' : ''}
          ${statusBadge(entry)}
          ${entry.coherenceCheck ? `<span class="badge eval-badge-checked"${entry.coherenceCheck.explanation ? ` title="${escapeHtml(entry.coherenceCheck.explanation)}"` : ''}>Checked</span>` : ''}
          <span id="viewer-coherence-badge">${coherencePolling ? '<span class="badge badge-disabled">Checking\u2026</span>' : coherenceResult ? (coherenceResult.coherent ? `<span class="badge eval-badge-checked"${coherenceResult.explanation ? ` title="${escapeHtml(coherenceResult.explanation)}"` : ''}>Checked</span>` : `<span class="badge eval-badge-rejected" title="${escapeHtml(coherenceResult.issues.join('; '))}">${escapeHtml('Incoherent')}</span>`) : ''}</span>
        </div>`
            : ''
        }

        <div class="production-content" style="max-height:400px">${content != null ? renderContent(content, node.name) : '<p class="text-dim" style="padding:12px">File not found or empty</p>'}</div>

        ${
          entry
            ? `
          <div class="eval-controls" style="margin-top:16px">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
              <button class="btn btn-sm${currentStatus === 'approved' ? ' btn-primary' : ''}" id="viewer-approve">Approve</button>
              <button class="btn btn-sm${currentStatus === 'rejected' ? ' btn-danger' : ''}" id="viewer-reject">Reject</button>
              <span style="margin-left:12px">${starsHtml(currentRating, true)}</span>
              <button class="btn btn-primary btn-sm" id="viewer-save" style="margin-left:auto">Save</button>
              <button class="btn btn-sm" id="viewer-archive" title="Move to archived/">Archive</button>
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

      // Archive
      document.getElementById('viewer-archive')?.addEventListener('click', () => {
        showModal(
          'Archive Production',
          `
          <p style="margin-bottom:12px">Move <strong>${escapeHtml(entry.path)}</strong> to <code>archived/</code>.</p>
          <label class="form-label">Reason</label>
          <input type="text" id="archive-reason" class="form-input" placeholder="Why are you archiving this file?" style="width:100%;margin-bottom:12px">
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-sm" id="archive-cancel">Cancel</button>
            <button class="btn btn-primary btn-sm" id="archive-confirm">Archive</button>
          </div>
        `
        );
        document.getElementById('archive-cancel')?.addEventListener('click', closeModal);
        document.getElementById('archive-confirm')?.addEventListener('click', async () => {
          const reason =
            document.getElementById('archive-reason')?.value?.trim() || 'Archived from dashboard';
          const confirmBtn = document.getElementById('archive-confirm');
          if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Archiving...';
          }
          await api(`/api/productions/${encodeURIComponent(botId)}/${entry.id}/archive`, {
            method: 'POST',
            body: { reason },
          });
          closeModal();
          selectedFile = null;
          history.replaceState(null, '', `#/productions/${encodeURIComponent(botId)}`);
          const freshTree = await api(`/api/productions/${encodeURIComponent(botId)}/tree`);
          tree.length = 0;
          tree.push(...(freshTree.tree || []));
          renderTree(document.getElementById('prod-tree-container'), tree);
          panel.innerHTML =
            '<div class="prod-empty-state">File archived. Select another file.</div>';
        });
      });

      // Delete
      document.getElementById('viewer-delete')?.addEventListener('click', async () => {
        if (!confirm('Delete this production and its file? This cannot be undone.')) return;
        await api(`/api/productions/${encodeURIComponent(botId)}/${entry.id}`, {
          method: 'DELETE',
        });
        selectedFile = null;
        history.replaceState(null, '', `#/productions/${encodeURIComponent(botId)}`);
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

  // --- Expand / Collapse buttons ---
  document.getElementById('prod-expand-all')?.addEventListener('click', () => {
    for (const key of collectAllDirKeys(tree)) expandedDirs.add(key);
    saveExpandState();
    renderTree(document.getElementById('prod-tree-container'), tree);
  });
  document.getElementById('prod-collapse-all')?.addEventListener('click', () => {
    expandedDirs.clear();
    saveExpandState();
    renderTree(document.getElementById('prod-tree-container'), tree);
  });

  // Restore expand state from localStorage, or auto-expand if few dirs
  try {
    const saved = JSON.parse(localStorage.getItem(BOT_STORAGE_KEY));
    if (Array.isArray(saved)) {
      for (const key of saved) expandedDirs.add(key);
    }
  } catch {}
  if (expandedDirs.size === 0) {
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
    if (countDirs(tree) <= 20) {
      for (const key of collectAllDirKeys(tree)) expandedDirs.add(key);
    }
    saveExpandState();
  }
  renderTree(document.getElementById('prod-tree-container'), tree);

  // Restore selected file from URL hash params
  const botHashParams = getHashParams();
  if (botHashParams.file) {
    const expandKeyFn = (dirNode) => dirNode.path;
    const result = findNodeInTree(tree, botHashParams.file, botId, [], expandKeyFn);
    if (result) {
      for (const key of result.parentKeys) expandedDirs.add(key);
      saveExpandState();
      selectedFile = result.node;
      renderTree(document.getElementById('prod-tree-container'), tree);
      renderFileViewer(botId, result.node);
    }
  }

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

      <div class="production-content">${content != null ? renderContent(content, entry.path) : '<p class="text-dim">File not found or empty</p>'}</div>

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
