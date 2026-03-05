import { api } from './shared.js';

export async function renderSettings(el) {
  el.innerHTML = '<div class="page-title">Settings</div><p class="text-dim">Loading...</p>';

  const [session, collab, skillsFolders, mcpData, memSearch, healthCheck, agentDefaults] =
    await Promise.all([
      api('/api/settings/session'),
      api('/api/settings/collaboration'),
      api('/api/settings/skills-folders'),
      api('/api/settings/mcp'),
      api('/api/settings/memory-search'),
      api('/api/settings/health-check'),
      api('/api/agents/defaults'),
    ]);
  if (session.error || collab.error) {
    el.innerHTML = '<div class="page-title">Settings</div><p>Failed to load settings.</p>';
    return;
  }

  const availableModels = agentDefaults.availableModels || ['claude-cli'];
  const hcEffectiveModel =
    healthCheck.llmBackend === 'claude-cli'
      ? 'claude-cli'
      : healthCheck.model || agentDefaults.model || '';

  const sfPaths = skillsFolders.paths || [];
  const sfDefault = skillsFolders.defaultPath || '';
  const mcpServers = mcpData.servers || [];
  const mcpStatus = mcpData.status || [];

  el.innerHTML = `
    <div class="page-title">Settings</div>

    <div class="detail-card" id="skills-folders-card">
      <div class="form-section-title">Skill Folders</div>
      <p class="text-dim text-sm mb-16">Directories containing external skill packages (skill.json + handlers). Changes take effect on restart.</p>
      <div id="sf-list"></div>
      <div class="form-row" style="align-items:flex-end;gap:8px;margin-top:12px">
        <div class="form-group" style="flex:1;margin-bottom:0">
          <label>Add Folder Path</label>
          <input type="text" id="sf-new-path" placeholder="./productions/tsc/src/skills">
        </div>
        <button type="button" class="btn btn-sm" id="sf-add-btn" style="margin-bottom:0">Add</button>
      </div>
      <div class="actions" style="margin-top:12px">
        <button type="button" class="btn btn-primary btn-sm" id="sf-save-btn">Save Folders</button>
        <span class="text-dim text-sm" id="sf-save-status"></span>
      </div>
    </div>

    <div class="detail-card" id="mcp-servers-card">
      <div class="form-section-title">MCP Servers</div>
      <p class="text-dim text-sm mb-16">External MCP server connections. Bots can use tools from these servers.</p>
      <div id="mcp-list"></div>
      <div class="form-separator" style="margin:12px 0"></div>
      <div class="form-row" style="align-items:flex-end;gap:8px">
        <div class="form-group" style="flex:1;margin-bottom:0">
          <label>Name</label>
          <input type="text" id="mcp-new-name" placeholder="my-server">
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label>Transport</label>
          <select id="mcp-new-transport">
            <option value="stdio">stdio</option>
            <option value="sse">sse</option>
          </select>
        </div>
      </div>
      <div class="form-row" style="align-items:flex-end;gap:8px;margin-top:8px">
        <div class="form-group" style="flex:1;margin-bottom:0" id="mcp-cmd-group">
          <label>Command</label>
          <input type="text" id="mcp-new-command" placeholder="npx -y @modelcontextprotocol/server-github">
        </div>
        <div class="form-group" style="flex:1;margin-bottom:0;display:none" id="mcp-url-group">
          <label>URL</label>
          <input type="text" id="mcp-new-url" placeholder="http://localhost:3001/sse">
        </div>
        <div class="form-group" style="width:100px;margin-bottom:0">
          <label>Timeout</label>
          <input type="number" id="mcp-new-timeout" min="1000" step="1000" value="30000">
        </div>
        <button type="button" class="btn btn-sm btn-primary" id="mcp-add-btn" style="margin-bottom:0">Add Server</button>
      </div>
      <div style="margin-top:8px">
        <span class="text-dim text-sm" id="mcp-status"></span>
      </div>
    </div>

    <div class="detail-card" id="health-check-card">
      <div class="form-section-title">Soul Health Check / Quality Review</div>
      <p class="text-dim text-sm mb-16">Configure the LLM backend used for soul quality review and memory consolidation on startup.</p>

      <div class="form-group">
        <label>Enabled</label>
        <label class="toggle">
          <input type="checkbox" id="hc-enabled" ${healthCheck.enabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="form-group">
        <label>Model</label>
        <select id="hc-model">
          ${availableModels.map((m) => `<option value="${m}"${m === hcEffectiveModel ? ' selected' : ''}>${m}${m === agentDefaults.model ? ' (primary)' : ''}</option>`).join('')}
        </select>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>Cooldown (hours)</label>
          <input type="number" id="hc-cooldown" min="1" step="1" value="${Math.round((healthCheck.cooldownMs || 86400000) / 3600000)}">
        </div>
        <div class="form-group">
          <label>Memory Consolidation</label>
          <label class="toggle">
            <input type="checkbox" id="hc-consolidate" ${healthCheck.consolidateMemory ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="actions" style="margin-top:12px">
        <button type="button" class="btn btn-primary btn-sm" id="hc-save-btn">Save</button>
        <span class="text-dim text-sm" id="hc-save-status"></span>
      </div>
    </div>

    <form id="settings-form">

      <div class="detail-card">
        <div class="form-section-title">Group Activation</div>

        <div class="form-row">
          <div class="form-group">
            <label>Activation Mode</label>
            <select name="groupActivation">
              <option value="mention" ${session.groupActivation === 'mention' ? 'selected' : ''}>Mention</option>
              <option value="always" ${session.groupActivation === 'always' ? 'selected' : ''}>Always</option>
            </select>
          </div>
          <div class="form-group">
            <label>Reply Window (minutes, 0 = unlimited)</label>
            <input type="number" name="replyWindow" min="0" step="1" value="${session.replyWindow}">
          </div>
        </div>

        <div class="form-group">
          <label>Forum Topic Isolation</label>
          <label class="toggle">
            <input type="checkbox" name="forumTopicIsolation" ${session.forumTopicIsolation ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="detail-card">
        <div class="form-section-title">LLM Relevance Check</div>

        <div class="form-group">
          <label>Enabled</label>
          <label class="toggle">
            <input type="checkbox" name="rlcEnabled" ${session.llmRelevanceCheck.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <p class="text-dim text-sm mt-8">When a reply-window message arrives, ask the LLM if it's really directed at the bot before responding.</p>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Temperature</label>
            <input type="number" name="rlcTemperature" min="0" max="2" step="0.1" value="${session.llmRelevanceCheck.temperature}">
          </div>
          <div class="form-group">
            <label>Timeout (ms)</label>
            <input type="number" name="rlcTimeout" min="1000" step="1000" value="${session.llmRelevanceCheck.timeout}">
          </div>
          <div class="form-group">
            <label>Context Messages</label>
            <input type="number" name="rlcContextMessages" min="0" step="1" value="${session.llmRelevanceCheck.contextMessages}">
          </div>
        </div>

        <div class="form-separator"></div>

        <div class="form-group">
          <label>Broadcast Check</label>
          <label class="toggle">
            <input type="checkbox" name="rlcBroadcastCheck" ${session.llmRelevanceCheck.broadcastCheck ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <p class="text-dim text-sm mt-8">When no mention/reply/window matches, run an LLM check as fallback. Enables messages like "presentense todos" to trigger all bots.</p>
        </div>
      </div>

      <div class="detail-card">
        <div class="form-section-title">Reset Policy</div>

        <div class="form-row">
          <div class="form-group">
            <label>Daily Reset</label>
            <label class="toggle">
              <input type="checkbox" name="dailyEnabled" ${session.resetPolicy.daily.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="form-group">
            <label>Reset Hour (0-23)</label>
            <input type="number" name="dailyHour" min="0" max="23" step="1" value="${session.resetPolicy.daily.hour}">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Idle Reset</label>
            <label class="toggle">
              <input type="checkbox" name="idleEnabled" ${session.resetPolicy.idle.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="form-group">
            <label>Idle Minutes</label>
            <input type="number" name="idleMinutes" min="1" step="1" value="${session.resetPolicy.idle.minutes}">
          </div>
        </div>
      </div>

      <div class="detail-card">
        <div class="form-section-title">Agent Collaboration</div>

        <div class="form-group">
          <label>Enabled</label>
          <label class="toggle">
            <input type="checkbox" name="collabEnabled" ${collab.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <p class="text-dim text-sm mt-8">Allow bots to collaborate with each other via the collaborate tool.</p>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Max Rounds</label>
            <input type="number" name="collabMaxRounds" min="1" max="20" step="1" value="${collab.maxRounds}">
            <p class="text-dim text-sm mt-8">Max collaboration exchanges per cooldown window.</p>
          </div>
          <div class="form-group">
            <label>Cooldown (ms)</label>
            <input type="number" name="collabCooldownMs" min="0" step="1000" value="${collab.cooldownMs}">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Internal Query Timeout (ms)</label>
            <input type="number" name="collabInternalQueryTimeout" min="1000" step="1000" value="${collab.internalQueryTimeout}">
          </div>
          <div class="form-group">
            <label>Session TTL (ms)</label>
            <input type="number" name="collabSessionTtlMs" min="1000" step="1000" value="${collab.sessionTtlMs}">
          </div>
        </div>

        <div class="form-group">
          <label>Enable Target Tools</label>
          <label class="toggle">
            <input type="checkbox" name="collabEnableTargetTools" ${collab.enableTargetTools ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <p class="text-dim text-sm mt-8">Allow the target bot to use tools (memory, web search, etc.) during collaboration.</p>
        </div>

        <div class="form-separator"></div>

        <div class="form-row">
          <div class="form-group">
            <label>Internal Max Turns</label>
            <input type="number" name="collabMaxConverseTurns" min="1" max="10" step="1" value="${collab.maxConverseTurns}">
            <p class="text-dim text-sm mt-8">Max turns for internal (invisible) multi-turn conversations.</p>
          </div>
          <div class="form-group">
            <label>Visible Max Turns</label>
            <input type="number" name="collabVisibleMaxTurns" min="1" max="10" step="1" value="${collab.visibleMaxTurns}">
            <p class="text-dim text-sm mt-8">Max turns for visible back-and-forth discussions in group chat.</p>
          </div>
        </div>
      </div>

      <div class="detail-card">
        <div class="form-section-title">Memory Search</div>

        <div class="form-group">
          <label>MMR Diversity Re-ranking</label>
          <label class="toggle">
            <input type="checkbox" name="mmrEnabled" ${memSearch.mmr?.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <p class="text-dim text-sm mt-8">Re-rank search results to reduce near-duplicate memory chunks. Balances relevance with diversity.</p>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Lambda (0 = max diversity, 1 = max relevance)</label>
            <input type="number" name="mmrLambda" min="0" max="1" step="0.05" value="${memSearch.mmr?.lambda ?? 0.7}">
          </div>
        </div>

        <div class="form-separator"></div>

        <div class="form-group">
          <label>Auto-RAG</label>
          <label class="toggle">
            <input type="checkbox" name="autoRagEnabled" ${memSearch.autoRag?.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <p class="text-dim text-sm mt-8">Automatically search memory before each LLM call and inject relevant context.</p>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Max Results</label>
            <input type="number" name="autoRagMaxResults" min="1" max="20" step="1" value="${memSearch.autoRag?.maxResults ?? 3}">
          </div>
          <div class="form-group">
            <label>Min Score (0-1)</label>
            <input type="number" name="autoRagMinScore" min="0" max="1" step="0.05" value="${memSearch.autoRag?.minScore ?? 0.25}">
          </div>
          <div class="form-group">
            <label>Max Content Chars</label>
            <input type="number" name="autoRagMaxContentChars" min="100" step="100" value="${memSearch.autoRag?.maxContentChars ?? 2000}">
          </div>
        </div>
      </div>

      <div class="actions">
        <button type="submit" class="btn btn-primary" id="btn-save">Save</button>
        <span class="text-dim text-sm" id="save-status"></span>
      </div>
    </form>
  `;

  // --- Skill Folders UI logic ---
  const currentSfPaths = [...sfPaths];

  function renderSfList() {
    const listEl = document.getElementById('sf-list');
    const items = [];

    // Default folder (non-removable)
    if (sfDefault) {
      items.push(`<div style="display:flex;align-items:center;gap:8px;padding:6px 0">
        <code style="flex:1">${sfDefault}</code>
        <span class="badge badge-disabled">(default)</span>
      </div>`);
    }

    // Extra folders
    for (let i = 0; i < currentSfPaths.length; i++) {
      items.push(`<div style="display:flex;align-items:center;gap:8px;padding:6px 0">
        <code style="flex:1">${currentSfPaths[i]}</code>
        <button type="button" class="btn btn-sm btn-danger sf-remove-btn" data-idx="${i}">Remove</button>
      </div>`);
    }

    if (items.length === 0) {
      listEl.innerHTML = '<p class="text-dim text-sm">No skill folders configured.</p>';
    } else {
      listEl.innerHTML = items.join('');
    }

    for (const btn of listEl.querySelectorAll('.sf-remove-btn')) {
      btn.addEventListener('click', () => {
        currentSfPaths.splice(Number.parseInt(btn.dataset.idx, 10), 1);
        renderSfList();
      });
    }
  }

  renderSfList();

  document.getElementById('sf-add-btn').addEventListener('click', () => {
    const input = document.getElementById('sf-new-path');
    const val = input.value.trim();
    if (val && !currentSfPaths.includes(val)) {
      currentSfPaths.push(val);
      input.value = '';
      renderSfList();
    }
  });

  document.getElementById('sf-save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sf-save-btn');
    const status = document.getElementById('sf-save-status');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const res = await api('/api/settings/skills-folders', {
      method: 'PATCH',
      body: { paths: currentSfPaths },
    });

    btn.disabled = false;
    btn.textContent = 'Save Folders';

    if (res.error) {
      status.textContent = 'Failed to save';
      status.style.color = 'var(--red)';
    } else {
      status.textContent = 'Saved (restart to apply)';
      status.style.color = 'var(--green)';
      setTimeout(() => {
        status.textContent = '';
      }, 4000);
    }
  });

  // --- MCP Servers UI logic ---
  function getServerStatus(name) {
    const entry = mcpStatus.find((s) => s.name === name);
    return entry?.status ?? 'unknown';
  }

  function statusBadge(status) {
    const colors = {
      connected: 'var(--green)',
      disconnected: 'var(--yellow)',
      error: 'var(--red)',
    };
    const color = colors[status] || 'var(--text-dim)';
    return `<span class="badge" style="background:${color};color:#000;font-size:11px">${status}</span>`;
  }

  function renderMcpList() {
    const listEl = document.getElementById('mcp-list');
    if (mcpServers.length === 0) {
      listEl.innerHTML = '<p class="text-dim text-sm">No MCP servers configured.</p>';
      return;
    }
    listEl.innerHTML = mcpServers
      .map(
        (s, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0">
        <code style="flex:1">${s.name}</code>
        <span class="text-dim text-sm">${s.transport}</span>
        ${statusBadge(getServerStatus(s.name))}
        <button type="button" class="btn btn-sm btn-danger mcp-remove-btn" data-name="${s.name}">Remove</button>
      </div>
    `
      )
      .join('');

    for (const btn of listEl.querySelectorAll('.mcp-remove-btn')) {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        btn.disabled = true;
        btn.textContent = '...';
        const res = await api(`/api/settings/mcp/servers/${encodeURIComponent(name)}`, {
          method: 'DELETE',
        });
        if (!res.error) {
          const idx = mcpServers.findIndex((s) => s.name === name);
          if (idx !== -1) mcpServers.splice(idx, 1);
          renderMcpList();
          showMcpStatus('Removed', 'var(--green)');
        } else {
          btn.disabled = false;
          btn.textContent = 'Remove';
          showMcpStatus('Failed to remove', 'var(--red)');
        }
      });
    }
  }

  function showMcpStatus(text, color) {
    const el = document.getElementById('mcp-status');
    el.textContent = text;
    el.style.color = color;
    setTimeout(() => {
      el.textContent = '';
    }, 4000);
  }

  renderMcpList();

  // Toggle command/url fields based on transport
  document.getElementById('mcp-new-transport').addEventListener('change', (e) => {
    const isStdio = e.target.value === 'stdio';
    document.getElementById('mcp-cmd-group').style.display = isStdio ? '' : 'none';
    document.getElementById('mcp-url-group').style.display = isStdio ? 'none' : '';
  });

  document.getElementById('mcp-add-btn').addEventListener('click', async () => {
    const name = document.getElementById('mcp-new-name').value.trim();
    const transport = document.getElementById('mcp-new-transport').value;
    const command = document.getElementById('mcp-new-command').value.trim();
    const url = document.getElementById('mcp-new-url').value.trim();
    const timeout = Number.parseInt(document.getElementById('mcp-new-timeout').value, 10) || 30000;

    if (!name) {
      showMcpStatus('Name is required', 'var(--red)');
      return;
    }

    const body = { name, transport, timeout };
    if (transport === 'stdio') {
      if (!command) {
        showMcpStatus('Command is required for stdio', 'var(--red)');
        return;
      }
      // Split command into command + args
      const parts = command.split(/\s+/);
      body.command = parts[0];
      if (parts.length > 1) body.args = parts.slice(1);
    } else {
      if (!url) {
        showMcpStatus('URL is required for SSE', 'var(--red)');
        return;
      }
      body.url = url;
    }

    const btn = document.getElementById('mcp-add-btn');
    btn.disabled = true;
    btn.textContent = 'Adding...';

    const res = await api('/api/settings/mcp/servers', { method: 'POST', body });
    btn.disabled = false;
    btn.textContent = 'Add Server';

    if (res.error) {
      showMcpStatus(res.error, 'var(--red)');
    } else {
      mcpServers.push(res.server);
      document.getElementById('mcp-new-name').value = '';
      document.getElementById('mcp-new-command').value = '';
      document.getElementById('mcp-new-url').value = '';
      // Refresh status
      const freshData = await api('/api/settings/mcp');
      mcpStatus.length = 0;
      mcpStatus.push(...(freshData.status || []));
      renderMcpList();
      showMcpStatus('Server added', 'var(--green)');
    }
  });

  // --- Health Check save ---
  document.getElementById('hc-save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('hc-save-btn');
    const status = document.getElementById('hc-save-status');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const selectedModel = document.getElementById('hc-model').value;
    const isClaudeCli = selectedModel === 'claude-cli';
    const patch = {
      enabled: document.getElementById('hc-enabled').checked,
      llmBackend: isClaudeCli ? 'claude-cli' : 'ollama',
      model: isClaudeCli ? '' : selectedModel,
      cooldownMs: Number.parseInt(document.getElementById('hc-cooldown').value, 10) * 3600000,
      consolidateMemory: document.getElementById('hc-consolidate').checked,
    };

    const res = await api('/api/settings/health-check', { method: 'PATCH', body: patch });

    btn.disabled = false;
    btn.textContent = 'Save';

    if (res.error) {
      status.textContent = 'Failed to save';
      status.style.color = 'var(--red)';
    } else {
      status.textContent = 'Saved (applies on next bot start)';
      status.style.color = 'var(--green)';
      setTimeout(() => {
        status.textContent = '';
      }, 4000);
    }
  });

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = document.getElementById('btn-save');
    const status = document.getElementById('save-status');

    btn.disabled = true;
    btn.textContent = 'Saving...';

    const sessionPatch = {
      groupActivation: form.groupActivation.value,
      replyWindow: Number.parseInt(form.replyWindow.value, 10),
      forumTopicIsolation: form.forumTopicIsolation.checked,
      resetPolicy: {
        daily: {
          enabled: form.dailyEnabled.checked,
          hour: Number.parseInt(form.dailyHour.value, 10),
        },
        idle: {
          enabled: form.idleEnabled.checked,
          minutes: Number.parseInt(form.idleMinutes.value, 10),
        },
      },
      llmRelevanceCheck: {
        enabled: form.rlcEnabled.checked,
        temperature: Number.parseFloat(form.rlcTemperature.value),
        timeout: Number.parseInt(form.rlcTimeout.value, 10),
        contextMessages: Number.parseInt(form.rlcContextMessages.value, 10),
        broadcastCheck: form.rlcBroadcastCheck.checked,
      },
    };

    const collabPatch = {
      enabled: form.collabEnabled.checked,
      maxRounds: Number.parseInt(form.collabMaxRounds.value, 10),
      cooldownMs: Number.parseInt(form.collabCooldownMs.value, 10),
      internalQueryTimeout: Number.parseInt(form.collabInternalQueryTimeout.value, 10),
      enableTargetTools: form.collabEnableTargetTools.checked,
      maxConverseTurns: Number.parseInt(form.collabMaxConverseTurns.value, 10),
      sessionTtlMs: Number.parseInt(form.collabSessionTtlMs.value, 10),
      visibleMaxTurns: Number.parseInt(form.collabVisibleMaxTurns.value, 10),
    };

    const memSearchPatch = {
      mmr: {
        enabled: form.mmrEnabled.checked,
        lambda: Number.parseFloat(form.mmrLambda.value),
      },
      autoRag: {
        enabled: form.autoRagEnabled.checked,
        maxResults: Number.parseInt(form.autoRagMaxResults.value, 10),
        minScore: Number.parseFloat(form.autoRagMinScore.value),
        maxContentChars: Number.parseInt(form.autoRagMaxContentChars.value, 10),
      },
    };

    const [result, collabResult, memSearchResult] = await Promise.all([
      api('/api/settings/session', { method: 'PATCH', body: sessionPatch }),
      api('/api/settings/collaboration', { method: 'PATCH', body: collabPatch }),
      api('/api/settings/memory-search', { method: 'PATCH', body: memSearchPatch }),
    ]);

    btn.disabled = false;
    btn.textContent = 'Save';

    if (result.error || collabResult.error || memSearchResult.error) {
      status.textContent = 'Failed to save';
      status.style.color = 'var(--red)';
    } else {
      status.textContent = 'Saved';
      status.style.color = 'var(--green)';
      setTimeout(() => {
        status.textContent = '';
      }, 3000);
    }
  });
}
