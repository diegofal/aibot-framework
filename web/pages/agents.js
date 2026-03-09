import { api, closeModal, escapeHtml, getAuthToken, showModal, timeAgo } from './shared.js';

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function statusBadge(status) {
  const cls =
    status === 'completed' ? 'badge-ok' : status === 'error' ? 'badge-error' : 'badge-disabled';
  return `<span class="badge ${cls}">${status}</span>`;
}

function formatTokenCount(n) {
  if (n == null || n === 0) return '--';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function tokenBreakdownCompact(stats) {
  if (!stats || !stats.modelBreakdown) return '<span class="text-dim">--</span>';
  const total = (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0);
  if (total === 0) return '<span class="text-dim">--</span>';

  const models = Object.keys(stats.modelBreakdown);
  const totalStr = formatTokenCount(total);
  if (models.length <= 1) {
    return `<span title="${models[0] || 'unknown'}: ${total} tokens">${totalStr}</span>`;
  }
  const detail = models
    .map((m) => `${m}: ${formatTokenCount(stats.modelBreakdown[m].totalTokens)}`)
    .join(', ');
  return `<span title="${detail}">${totalStr} <span class="text-dim">(${models.length} models)</span></span>`;
}

function karmaScoreColor(score) {
  if (score >= 70) return 'var(--green)';
  if (score >= 40) return 'var(--orange)';
  return 'var(--red)';
}

function karmaCompact(score, trend) {
  if (score == null) return '<span class="text-dim">--</span>';
  const color = karmaScoreColor(score);
  const arrow = trend === 'rising' ? '&#8593;' : trend === 'falling' ? '&#8595;' : '';
  const arrowColor = trend === 'rising' ? 'var(--green)' : trend === 'falling' ? 'var(--red)' : '';
  return `<span style="font-weight:600;color:${color}">${score}</span>${arrow ? `<span style="color:${arrowColor};margin-left:2px">${arrow}</span>` : ''}`;
}

function karmaTrendBadge(trend) {
  if (trend === 'rising') return '<span class="badge badge-ok">&#8593; rising</span>';
  if (trend === 'falling') return '<span class="badge badge-error">&#8595; falling</span>';
  return '<span class="badge badge-disabled">&#8594; stable</span>';
}

function renderAgentLoopResult(r) {
  const sections = [];

  sections.push(`<div class="flex-between mb-16">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-weight:600;font-size:14px">Agent Loop Result</span>
      ${statusBadge(r.status)}
    </div>
    <span class="text-dim text-sm">${formatDuration(r.durationMs)}</span>
  </div>`);

  if (r.plannerReasoning) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Planner Reasoning</div>
      <pre>${escapeHtml(r.plannerReasoning)}</pre>
    </div>`);
  }

  if (r.plan && r.plan.length > 0) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Plan</div>
      <ol style="margin:0;padding-left:20px;font-size:13px">${r.plan.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
    </div>`);
  }

  if (r.toolCalls && r.toolCalls.length > 0) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Tool Calls (${r.toolCalls.length})</div>
      ${r.toolCalls
        .map((tc) => {
          const badge = tc.success
            ? '<span class="badge badge-ok">OK</span>'
            : '<span class="badge badge-error">FAIL</span>';
          const argsStr = JSON.stringify(tc.args || {}, null, 2);
          return `<div class="tool-call-item">
          <div class="tool-call-header">
            <span style="font-family:monospace;font-weight:600">${escapeHtml(tc.name)}</span> ${badge}
          </div>
          <details class="tool-call-details">
            <summary class="text-dim text-sm">Args</summary>
            <pre>${escapeHtml(argsStr)}</pre>
          </details>
          <details class="tool-call-details" ${!tc.success ? 'open' : ''}>
            <summary class="text-dim text-sm">Result</summary>
            <pre>${escapeHtml(tc.result || '')}</pre>
          </details>
        </div>`;
        })
        .join('')}
    </div>`);
  }

  if (r.tokenUsage && r.tokenUsage.total > 0) {
    const modelRows = Object.entries(r.tokenUsage.models)
      .map(
        ([model, u]) =>
          `<tr><td style="font-family:monospace;font-size:12px">${escapeHtml(model)}</td><td style="text-align:right">${formatTokenCount(u.promptTokens)}</td><td style="text-align:right">${formatTokenCount(u.completionTokens)}</td><td style="text-align:right;font-weight:600">${formatTokenCount(u.promptTokens + u.completionTokens)}</td></tr>`
      )
      .join('');
    sections.push(`<div class="result-section">
      <div class="result-section-title">Token Usage (${formatTokenCount(r.tokenUsage.total)} total)</div>
      <table style="width:100%;font-size:13px">
        <thead><tr><th style="text-align:left">Model</th><th style="text-align:right">In</th><th style="text-align:right">Out</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${modelRows}</tbody>
      </table>
    </div>`);
  }

  sections.push(`<div class="result-section">
    <div class="result-section-title">Summary</div>
    <pre>${escapeHtml(r.summary || '')}</pre>
  </div>`);

  return sections.join('');
}

export async function renderAgents(el) {
  el.innerHTML = '<div class="page-title">Agents</div><p class="text-dim">Loading...</p>';

  const [agents, skills, karmaScores, loopState, defaults, llmStatsRes] = await Promise.all([
    api('/api/agents'),
    api('/api/skills'),
    api('/api/karma'),
    api('/api/agent-loop'),
    api('/api/agents/defaults'),
    api('/api/agent-loop/llm-stats'),
  ]);

  // Build karma lookup by botId (graceful if karma is disabled)
  const karmaMap = {};
  if (Array.isArray(karmaScores)) {
    for (const k of karmaScores) karmaMap[k.botId] = k;
  }

  // Build LLM stats lookup by botId
  const llmStatsMap = {};
  if (Array.isArray(llmStatsRes?.stats)) {
    for (const s of llmStatsRes.stats) llmStatsMap[s.botId] = s;
  }

  // Build executing lookup from loop state
  const executingMap = {};
  if (loopState.botSchedules) {
    for (const s of loopState.botSchedules) executingMap[s.botId] = s.isExecutingLoop;
  }

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Agents <span class="count">${agents.length}</span></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="btn-start-all">Start All</button>
        <button class="btn" id="btn-import-agent">Import Agent</button>
        <button class="btn btn-primary" id="btn-new-agent">+ New Agent</button>
      </div>
    </div>
    <table>
      <thead><tr><th>Name</th><th>ID</th><th>Model</th><th>Status</th><th>Agent Loop</th><th>Productions</th><th>Karma</th><th>LLM Calls</th><th>Tokens</th><th>Fallbacks</th><th>Skills</th><th>Actions</th></tr></thead>
      <tbody id="agents-tbody"></tbody>
    </table>
  `;

  const tbody = document.getElementById('agents-tbody');
  for (const agent of agents) {
    const isExecuting = executingMap[agent.id];
    const executingDot =
      agent.running && isExecuting
        ? ' <span class="processing-pulse" style="margin-left:4px" title="Executing loop cycle"></span>'
        : '';
    const statusBadge = agent.running
      ? `<span class="badge badge-running">Running</span>${executingDot}`
      : '<span class="badge badge-stopped">Stopped</span>';

    const tr = document.createElement('tr');
    const karma = karmaMap[agent.id];
    const llmStats = llmStatsMap[agent.id];
    const effectiveModel = agent.llmBackend === 'claude-cli' ? 'claude-cli' : agent.model || '';
    const modelOptions = (defaults.availableModels || [])
      .map(
        (m) =>
          `<option value="${escapeHtml(m)}"${m === effectiveModel ? ' selected' : ''}>${escapeHtml(m)}</option>`
      )
      .join('');

    const callsDisplay = llmStats
      ? `<span style="color:var(--green)">${llmStats.successCount}</span><span class="text-dim"> / ${llmStats.totalCalls}</span>`
      : '<span class="text-dim">--</span>';
    const fallbackDisplay = llmStats?.fallbackCount
      ? `<span style="color:var(--orange);font-weight:600">${llmStats.fallbackCount}</span>`
      : '<span class="text-dim">0</span>';

    tr.innerHTML = `
      <td><a href="#/agents/${agent.id}">${escapeHtml(agent.name)}</a></td>
      <td class="text-dim">${escapeHtml(agent.id)}</td>
      <td><select class="inline-model-select" data-agent-id="${agent.id}" style="font-size:12px;padding:2px 4px;max-width:170px">
        <option value=""${!effectiveModel ? ' selected' : ''}>Global (${escapeHtml(defaults.model)})</option>
        ${modelOptions}
      </select></td>
      <td>${statusBadge}</td>
      <td><button class="btn btn-sm${agent.agentLoop?.enabled === false ? ' btn-danger' : ''}" data-action="toggle-loop" data-id="${agent.id}" title="${agent.agentLoop?.enabled == null ? 'Inherit global' : agent.agentLoop.enabled ? 'On' : 'Off'}">${agent.agentLoop?.enabled === false ? 'Off' : agent.agentLoop?.enabled === true ? 'On' : '<span class="text-dim">Auto</span>'}</button></td>
      <td><button class="btn btn-sm${agent.productions?.enabled === false ? ' btn-danger' : ''}" data-action="toggle-productions" data-id="${agent.id}">${agent.productions?.enabled === false ? 'Off' : 'On'}</button></td>
      <td><a href="#/karma/${encodeURIComponent(agent.id)}" style="text-decoration:none">${karmaCompact(karma?.current, karma?.trend)}</a></td>
      <td>${callsDisplay}</td>
      <td>${tokenBreakdownCompact(llmStats)}</td>
      <td>${fallbackDisplay}</td>
      <td class="text-dim">${agent.skills.length}</td>
      <td class="actions">
        ${
          agent.running
            ? `<button class="btn btn-sm btn-danger" data-action="stop" data-id="${agent.id}">Stop</button>`
            : `<button class="btn btn-sm" data-action="start" data-id="${agent.id}">Start</button>`
        }
        ${
          agent.running
            ? `<button class="btn btn-sm" data-action="run-loop" data-id="${agent.id}">Run Loop</button>`
            : ''
        }
        <button class="btn btn-sm" data-action="edit" data-id="${agent.id}">Edit</button>
        <button class="btn btn-sm" data-action="clone" data-id="${agent.id}">Clone</button>
        <button class="btn btn-sm" data-action="export" data-id="${agent.id}">Export</button>
        ${!agent.running ? `<button class="btn btn-sm btn-danger" data-action="reset" data-id="${agent.id}">Reset</button>` : ''}
        <button class="btn btn-sm btn-danger" data-action="delete" data-id="${agent.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // Event delegation
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'start') {
      btn.disabled = true;
      btn.textContent = 'Starting...';
      const res = await api(`/api/agents/${id}/start`, { method: 'POST' });
      if (res.error) alert(`Failed to start: ${res.error}`);
      renderAgents(el);
    } else if (action === 'stop') {
      btn.disabled = true;
      btn.textContent = 'Stopping...';
      const res = await api(`/api/agents/${id}/stop`, { method: 'POST' });
      if (res.error) alert(`Failed to stop: ${res.error}`);
      renderAgents(el);
    } else if (action === 'run-loop') {
      btn.disabled = true;
      btn.textContent = 'Running...';
      try {
        const res = await api(`/api/agent-loop/run/${encodeURIComponent(id)}`, { method: 'POST' });
        if (res.error) {
          alert(`Agent loop error: ${res.error}`);
        } else {
          showModal(`
            <div class="modal-title">Agent Loop Result</div>
            <div style="max-height:60vh;overflow-y:auto">${renderAgentLoopResult(res.result)}</div>
            <div class="modal-actions">
              <button class="btn" id="loop-result-close">Close</button>
            </div>
          `);
          document.getElementById('modal').style.maxWidth = '700px';
          document.getElementById('loop-result-close').addEventListener('click', () => {
            document.getElementById('modal').style.maxWidth = '';
            closeModal();
          });
        }
      } catch (err) {
        alert(`Agent loop failed: ${err.message}`);
      }
      btn.disabled = false;
      btn.textContent = 'Run Loop';
    } else if (action === 'edit') {
      location.hash = `#/agents/${id}/edit`;
    } else if (action === 'clone') {
      showCloneModal(id, el);
    } else if (action === 'reset') {
      if (
        confirm(
          `Reset agent "${id}"? This will fully reset the agent to its original state: all conversations, memory, goals, and learned facts will be cleared, and soul files will be restored to their generated baseline. This cannot be undone.`
        )
      ) {
        btn.disabled = true;
        btn.textContent = 'Resetting...';
        const res = await api(`/api/agents/${id}/reset`, { method: 'POST' });
        if (res.error) alert(`Reset failed: ${res.error}`);
        renderAgents(el);
      }
    } else if (action === 'export') {
      showExportModal(id);
    } else if (action === 'toggle-loop') {
      const agent = agents.find((a) => a.id === id);
      // Cycle: Auto → On → Off → Auto
      const current = agent?.agentLoop?.enabled;
      const next = current == null ? true : current === true ? false : undefined;
      const patch = { agentLoop: { ...agent?.agentLoop, enabled: next } };
      if (next === undefined) patch.agentLoop.enabled = undefined;
      btn.disabled = true;
      const res = await api(`/api/agents/${id}`, { method: 'PATCH', body: patch });
      btn.disabled = false;
      if (res.error) {
        alert(`Failed to update: ${res.error}`);
        return;
      }
      // Update in-place
      if (agent) {
        if (!agent.agentLoop) agent.agentLoop = {};
        agent.agentLoop.enabled = next;
      }
      btn.className = `btn btn-sm${next === false ? ' btn-danger' : ''}`;
      btn.title = next == null ? 'Inherit global' : next ? 'On' : 'Off';
      btn.innerHTML =
        next === false ? 'Off' : next === true ? 'On' : '<span class="text-dim">Auto</span>';
    } else if (action === 'toggle-productions') {
      const agent = agents.find((a) => a.id === id);
      const current = agent?.productions?.enabled !== false;
      const next = !current;
      const patch = { productions: { ...agent?.productions, enabled: next } };
      btn.disabled = true;
      const res = await api(`/api/agents/${id}`, { method: 'PATCH', body: patch });
      btn.disabled = false;
      if (res.error) {
        alert(`Failed to update: ${res.error}`);
        return;
      }
      // Update in-place
      if (agent) {
        if (!agent.productions) agent.productions = {};
        agent.productions.enabled = next;
      }
      btn.className = `btn btn-sm${!next ? ' btn-danger' : ''}`;
      btn.textContent = next ? 'On' : 'Off';
    } else if (action === 'delete') {
      if (confirm(`Delete agent "${id}"? This cannot be undone.`)) {
        await api(`/api/agents/${id}`, { method: 'DELETE' });
        renderAgents(el);
      }
    }
  });

  // Inline model change
  tbody.addEventListener('change', async (e) => {
    const select = e.target.closest('.inline-model-select');
    if (!select) return;
    const agentId = select.dataset.agentId;
    const selectedModel = select.value.trim();

    const patch = {};
    if (selectedModel === 'claude-cli') {
      patch.model = null;
      patch.llmBackend = 'claude-cli';
    } else {
      patch.model = selectedModel || null;
      patch.llmBackend = null;
    }

    select.disabled = true;
    const res = await api(`/api/agents/${agentId}`, { method: 'PATCH', body: patch });
    select.disabled = false;
    if (res.error) {
      alert(`Failed to update model: ${res.error}`);
      renderAgents(el);
    }
  });

  document.getElementById('btn-start-all').addEventListener('click', async () => {
    const stoppedAgents = agents.filter((a) => a.enabled && !a.running);
    if (stoppedAgents.length === 0) {
      alert('All enabled agents are already running.');
      return;
    }

    const btn = document.getElementById('btn-start-all');
    btn.disabled = true;
    btn.textContent = `Starting ${stoppedAgents.length}...`;

    const errors = [];
    for (const agent of stoppedAgents) {
      const res = await api(`/api/agents/${agent.id}/start`, { method: 'POST' });
      if (res.error) errors.push(`${agent.name}: ${res.error}`);
    }

    if (errors.length) alert(`Some agents failed to start:\n${errors.join('\n')}`);
    renderAgents(el);
  });

  document.getElementById('btn-new-agent').addEventListener('click', () => {
    showNewAgentModal(skills, el);
  });

  document.getElementById('btn-import-agent').addEventListener('click', () => {
    showImportModal(el);
  });
}

export async function renderAgentDetail(el, id) {
  const [agent, skills, defaults, karmaData, loopState, llmStatsRes] = await Promise.all([
    api(`/api/agents/${id}`),
    api('/api/skills'),
    api('/api/agents/defaults'),
    api(`/api/karma/${encodeURIComponent(id)}`),
    api('/api/agent-loop'),
    api(`/api/agent-loop/llm-stats/${encodeURIComponent(id)}`),
  ]);

  const llmStats = llmStatsRes?.stats;

  // Find this bot's schedule info
  const botSchedule = loopState.botSchedules?.find((s) => s.botId === id);
  const isExecutingLoop = botSchedule?.isExecutingLoop ?? false;

  if (agent.error) {
    el.innerHTML = '<p>Agent not found.</p>';
    return;
  }

  const statusBadge = agent.running
    ? '<span class="badge badge-running">Running</span>'
    : '<span class="badge badge-stopped">Stopped</span>';

  const effectiveModel = agent.llmBackend === 'claude-cli' ? 'claude-cli' : agent.model;
  const modelDisplay = effectiveModel
    ? escapeHtml(effectiveModel)
    : `<span class="text-dim">${escapeHtml(defaults.model)} (global)</span>`;

  const soulDirDisplay = agent.soulDir
    ? escapeHtml(agent.soulDir)
    : `<span class="text-dim">${escapeHtml(defaults.soulDir)} (global)</span>`;

  const workDirDisplay = agent.workDir
    ? escapeHtml(agent.workDir)
    : `<span class="text-dim">${escapeHtml(`${defaults.productionsBaseDir || './productions'}/${agent.id}`)} (default)</span>`;

  const agentLoopEvery = agent.agentLoop?.every;
  const loopIntervalDisplay = agentLoopEvery
    ? escapeHtml(agentLoopEvery)
    : `<span class="text-dim">${escapeHtml(defaults.agentLoopInterval || '6h')} (global)</span>`;

  const systemPromptDisplay = agent.conversation?.systemPrompt
    ? escapeHtml(agent.conversation.systemPrompt).substring(0, 120) +
      (agent.conversation.systemPrompt.length > 120 ? '...' : '')
    : `<span class="text-dim">Global default</span>`;

  const tempDisplay =
    agent.conversation?.temperature !== undefined
      ? agent.conversation.temperature
      : `<span class="text-dim">${defaults.temperature} (global)</span>`;

  const maxHistDisplay =
    agent.conversation?.maxHistory !== undefined
      ? agent.conversation.maxHistory
      : `<span class="text-dim">${defaults.maxHistory} (global)</span>`;

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/agents" class="back">&larr;</a>
      <div class="page-title">${escapeHtml(agent.name)} ${statusBadge}</div>
    </div>
    <div class="detail-card">
      <table>
        <tr><td class="text-dim" style="width:140px">ID</td><td>${escapeHtml(agent.id)}</td></tr>
        <tr><td class="text-dim">Token</td><td><code>${escapeHtml(agent.token)}</code></td></tr>
        <tr><td class="text-dim">Enabled</td><td>${agent.enabled ? 'Yes' : 'No'}</td></tr>
        <tr><td class="text-dim">Model</td><td>${modelDisplay}</td></tr>
        <tr><td class="text-dim">Soul Dir</td><td>${soulDirDisplay}</td></tr>
        <tr><td class="text-dim">Work Dir</td><td>${workDirDisplay}</td></tr>
        <tr><td class="text-dim">Productions</td><td>${agent.productions?.enabled === false ? '<span class="badge badge-disabled">Disabled</span>' : '<span class="badge badge-ok">Enabled</span>'}</td></tr>
        <tr><td class="text-dim">System Prompt</td><td>${systemPromptDisplay}</td></tr>
        <tr><td class="text-dim">Temperature</td><td>${tempDisplay}</td></tr>
        <tr><td class="text-dim">Max History</td><td>${maxHistDisplay}</td></tr>
        <tr><td class="text-dim">Skills</td><td>${agent.skills.map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join(' ')}</td></tr>
        <tr><td class="text-dim">Allowed Users</td><td>${agent.allowedUsers?.length ? agent.allowedUsers.join(', ') : '<span class="text-dim">All</span>'}</td></tr>
        <tr><td class="text-dim">Mention Patterns</td><td>${agent.mentionPatterns?.length ? agent.mentionPatterns.join(', ') : '<span class="text-dim">None</span>'}</td></tr>
        <tr><td class="text-dim">Loop Interval</td><td>${loopIntervalDisplay}</td></tr>
        ${
          agent.running
            ? `<tr><td class="text-dim">Loop Status</td><td>${
                isExecutingLoop
                  ? '<span style="display:inline-flex;align-items:center;gap:6px"><span class="processing-pulse"></span> Executing cycle</span>'
                  : '<span class="text-dim">Idle</span>'
              }</td></tr>`
            : ''
        }
      </table>
    </div>
    ${
      !karmaData.error
        ? `
    <div class="detail-card" style="margin-top:16px">
      <div class="flex-between mb-16">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-weight:600">Karma</span>
          ${karmaTrendBadge(karmaData.trend)}
        </div>
        <a href="#/karma/${encodeURIComponent(id)}" class="btn btn-sm">View Details</a>
      </div>
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
        <span style="font-size:32px;font-weight:700;color:${karmaScoreColor(karmaData.current)}">${karmaData.current}</span>
        <div style="flex:1;height:8px;background:var(--surface-2);border-radius:4px;overflow:hidden">
          <div style="width:${karmaData.current}%;height:100%;background:${karmaScoreColor(karmaData.current)};border-radius:4px"></div>
        </div>
        <span class="text-dim text-sm">/ 100</span>
      </div>
      ${
        karmaData.recentEvents?.length
          ? `
        <div class="text-dim text-sm" style="margin-bottom:4px">Recent events</div>
        ${karmaData.recentEvents
          .slice(0, 15)
          .map((evt) => {
            const sign = evt.delta >= 0 ? '+' : '';
            const color =
              evt.delta > 0 ? 'var(--green)' : evt.delta < 0 ? 'var(--red)' : 'var(--text-dim)';
            return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px">
            <span style="font-weight:600;color:${color};min-width:36px;font-family:monospace">${sign}${evt.delta}</span>
            <span class="badge badge-disabled" style="font-size:11px">${escapeHtml(evt.source)}</span>
            <span style="flex:1">${escapeHtml(evt.reason)}</span>
            <span class="text-dim text-sm">${timeAgo(evt.timestamp)}</span>
          </div>`;
          })
          .join('')}
      `
          : '<p class="text-dim text-sm">No karma events yet.</p>'
      }
    </div>
    `
        : ''
    }

    ${llmStats ? buildLlmStatsCard(llmStats) : ''}

    <div class="actions">
      ${
        agent.running
          ? `<button class="btn btn-danger" id="btn-toggle">Stop</button>`
          : `<button class="btn btn-primary" id="btn-toggle">Start</button>`
      }
      <a href="#/agents/${agent.id}/edit" class="btn">Edit</a>
      <button class="btn" id="btn-clone">Clone</button>
      ${
        agent.running
          ? `<button class="btn" id="btn-run-loop">Run Agent Loop</button>`
          : `<button class="btn btn-danger" id="btn-reset">Reset</button>`
      }
    </div>
    <div id="agent-loop-result"></div>
  `;

  document.getElementById('btn-toggle').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const res = agent.running
      ? await api(`/api/agents/${id}/stop`, { method: 'POST' })
      : await api(`/api/agents/${id}/start`, { method: 'POST' });
    if (res.error) alert(res.error);
    renderAgentDetail(el, id);
  });

  document.getElementById('btn-clone').addEventListener('click', () => {
    showCloneModal(id, el, () => renderAgentDetail(el, id));
  });

  const resetBtn = document.getElementById('btn-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (
        !confirm(
          `Reset agent "${id}"? This will fully reset the agent to its original state: all conversations, memory, goals, and learned facts will be cleared, and soul files will be restored to their generated baseline. This cannot be undone.`
        )
      )
        return;
      resetBtn.disabled = true;
      resetBtn.textContent = 'Resetting...';
      try {
        const res = await api(`/api/agents/${id}/reset`, { method: 'POST' });
        if (res.error) {
          alert(`Reset failed: ${res.error}`);
        } else {
          alert('Agent reset successfully.');
        }
      } catch (err) {
        alert(`Reset failed: ${err.message}`);
      }
      renderAgentDetail(el, id);
    });
  }

  const runLoopBtn = document.getElementById('btn-run-loop');
  if (runLoopBtn) {
    runLoopBtn.addEventListener('click', async () => {
      runLoopBtn.disabled = true;
      runLoopBtn.textContent = 'Running...';
      const resultDiv = document.getElementById('agent-loop-result');
      resultDiv.innerHTML = '<p class="text-dim text-sm mt-8">Executing agent loop...</p>';

      try {
        const res = await api(`/api/agent-loop/run/${encodeURIComponent(id)}`, { method: 'POST' });
        if (res.error) {
          resultDiv.innerHTML = `<div class="detail-card mt-8"><p style="color:var(--red)">${escapeHtml(res.error)}</p></div>`;
        } else {
          resultDiv.innerHTML = `<div class="detail-card mt-8">${renderAgentLoopResult(res.result)}</div>`;
        }
      } catch (err) {
        resultDiv.innerHTML = `<div class="detail-card mt-8"><p style="color:var(--red)">Failed: ${escapeHtml(err.message)}</p></div>`;
      }

      runLoopBtn.disabled = false;
      runLoopBtn.textContent = 'Run Agent Loop';
    });
  }
}

function buildLlmStatsCard(stats) {
  const successRate =
    stats.totalCalls > 0 ? ((stats.successCount / stats.totalCalls) * 100).toFixed(1) : '0.0';
  const rateColor =
    Number(successRate) >= 95
      ? 'var(--green)'
      : Number(successRate) >= 80
        ? 'var(--orange)'
        : 'var(--red)';
  const lastCallDisplay = stats.lastCallAt ? timeAgo(stats.lastCallAt) : 'Never';

  const callerRows = Object.entries(stats.callerBreakdown || {})
    .sort(([, a], [, b]) => b.calls - a.calls)
    .map(([caller, cs]) => {
      const avgMs = cs.calls > 0 ? Math.round(cs.totalDurationMs / cs.calls) : 0;
      return `<tr>
        <td style="font-family:monospace;font-size:12px">${escapeHtml(caller)}</td>
        <td>${cs.calls}</td>
        <td>${cs.errors > 0 ? `<span style="color:var(--red)">${cs.errors}</span>` : '0'}</td>
        <td class="text-dim">${formatDuration(avgMs)}</td>
      </tr>`;
    })
    .join('');

  return `
    <div class="detail-card" style="margin-top:16px">
      <div style="font-weight:600;margin-bottom:12px">LLM Stats</div>
      <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:16px">
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700">${stats.totalCalls}</div>
          <div class="text-dim text-sm">Total Calls</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700;color:var(--green)">${stats.successCount}</div>
          <div class="text-dim text-sm">Successes</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700;color:${stats.failCount > 0 ? 'var(--red)' : 'inherit'}">${stats.failCount}</div>
          <div class="text-dim text-sm">Failures</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700;color:${stats.fallbackCount > 0 ? 'var(--orange)' : 'inherit'}">${stats.fallbackCount}</div>
          <div class="text-dim text-sm">Fallbacks</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700;color:${rateColor}">${successRate}%</div>
          <div class="text-dim text-sm">Success Rate</div>
        </div>
      </div>
      <table style="font-size:13px;margin-bottom:8px">
        <tr>
          <td class="text-dim" style="width:120px">Avg Duration</td>
          <td>${formatDuration(stats.avgDurationMs)}</td>
        </tr>
        <tr>
          <td class="text-dim">Last Call</td>
          <td>${lastCallDisplay}</td>
        </tr>
        ${
          stats.lastError
            ? `<tr>
          <td class="text-dim">Last Error</td>
          <td><details><summary style="cursor:pointer;color:var(--red);font-size:12px">Show error</summary><pre style="white-space:pre-wrap;font-size:11px;margin-top:4px;max-height:100px;overflow-y:auto">${escapeHtml(stats.lastError)}</pre></details></td>
        </tr>`
            : ''
        }
      </table>
      ${
        callerRows
          ? `
        <div class="text-dim text-sm" style="margin-bottom:4px;margin-top:12px">Breakdown by caller</div>
        <table style="font-size:13px">
          <thead><tr><th style="text-align:left">Caller</th><th>Calls</th><th>Errors</th><th>Avg Duration</th></tr></thead>
          <tbody>${callerRows}</tbody>
        </table>
      `
          : ''
      }
      ${buildModelTokenBreakdown(stats)}
    </div>`;
}

function buildModelTokenBreakdown(stats) {
  const mb = stats.modelBreakdown;
  if (!mb || Object.keys(mb).length === 0) return '';
  const totalTokens = (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0);
  if (totalTokens === 0) return '';

  const rows = Object.values(mb)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map(
      (m) => `<tr>
        <td style="font-family:monospace;font-size:12px">${escapeHtml(m.model)}</td>
        <td style="text-align:right">${formatTokenCount(m.promptTokens)}</td>
        <td style="text-align:right">${formatTokenCount(m.completionTokens)}</td>
        <td style="text-align:right;font-weight:600">${formatTokenCount(m.totalTokens)}</td>
        <td style="text-align:right" class="text-dim">${m.calls}</td>
      </tr>`
    )
    .join('');

  return `
    <div class="text-dim text-sm" style="margin-bottom:4px;margin-top:12px">Token usage by model (${formatTokenCount(totalTokens)} total)</div>
    <table style="font-size:13px">
      <thead><tr><th style="text-align:left">Model</th><th style="text-align:right">In</th><th style="text-align:right">Out</th><th style="text-align:right">Total</th><th style="text-align:right">Calls</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function buildSoulStatusBanner(soulStatus) {
  if (!soulStatus || soulStatus.error) {
    return `<div class="soul-banner soul-banner-error">
      <span class="soul-banner-icon">&#9888;</span>
      <div class="soul-banner-text">
        <strong>Soul status unknown</strong>
        <span class="text-dim text-sm">Could not check soul files.</span>
      </div>
      <button class="btn btn-sm btn-primary" id="btn-soul-retry">Generate Soul</button>
    </div>`;
  }

  if (soulStatus.complete) return '';

  const missing = [];
  if (!soulStatus.files.identity.exists || soulStatus.files.identity.length === 0)
    missing.push('IDENTITY.md');
  if (!soulStatus.files.soul.exists || soulStatus.files.soul.length === 0) missing.push('SOUL.md');
  if (!soulStatus.files.motivations.exists || soulStatus.files.motivations.length === 0)
    missing.push('MOTIVATIONS.md');

  if (!soulStatus.hasSoulDir) {
    return `<div class="soul-banner soul-banner-error">
      <span class="soul-banner-icon">&#9888;</span>
      <div class="soul-banner-text">
        <strong>No soul directory</strong>
        <span class="text-dim text-sm">Soul files have not been created yet. Generate a soul to give this agent a personality.</span>
      </div>
      <button class="btn btn-sm btn-primary" id="btn-soul-retry">Generate Soul</button>
    </div>`;
  }

  return `<div class="soul-banner soul-banner-warn">
    <span class="soul-banner-icon">&#9888;</span>
    <div class="soul-banner-text">
      <strong>Incomplete soul files</strong>
      <span class="text-dim text-sm">Missing: ${missing.join(', ')}. Generate or regenerate soul to fix this.</span>
    </div>
    <button class="btn btn-sm btn-primary" id="btn-soul-retry">Generate Soul</button>
  </div>`;
}

export async function renderAgentEdit(el, id) {
  const [agent, skills, defaults, soulStatus] = await Promise.all([
    api(`/api/agents/${id}`),
    api('/api/skills'),
    api('/api/agents/defaults'),
    api(`/api/agents/${id}/soul-status`),
  ]);

  if (agent.error) {
    el.innerHTML = '<p>Agent not found.</p>';
    return;
  }

  const soulBanner = buildSoulStatusBanner(soulStatus);

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/agents/${id}" class="back">&larr;</a>
      <div class="page-title">Edit ${escapeHtml(agent.name)}</div>
    </div>
    ${soulBanner}
    <form id="edit-form" class="detail-card">
      <div class="form-group">
        <label>Name</label>
        <input type="text" name="name" value="${escapeHtml(agent.name)}">
      </div>
      <div class="form-group">
        <label>Token</label>
        <input type="password" name="token" value="" placeholder="Leave blank to keep current">
      </div>
      <div class="form-group">
        <label>Enabled</label>
        <label class="toggle">
          <input type="checkbox" name="enabled" ${agent.enabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="form-group">
        <label>Skills</label>
        <div style="margin-bottom:6px">
          <a href="#" id="skills-select-all" class="text-sm" style="margin-right:12px">Select all</a>
          <a href="#" id="skills-unselect-all" class="text-sm">Unselect all</a>
        </div>
        <div class="checkbox-group" id="skills-group">
          ${skills
            .map(
              (s) => `
            <label class="${agent.skills.includes(s.id) ? 'checked' : ''}">
              <input type="checkbox" name="skills" value="${s.id}" ${agent.skills.includes(s.id) ? 'checked' : ''}>
              ${escapeHtml(s.name)}
            </label>
          `
            )
            .join('')}
        </div>
      </div>
      <div class="form-group">
        <label>Mention Patterns (comma-separated)</label>
        <input type="text" name="mentionPatterns" value="${(agent.mentionPatterns || []).join(', ')}">
      </div>

      <div class="form-separator"></div>
      <div class="form-section-title">Agent Overrides <span class="text-dim text-sm">(empty = use global default)</span></div>

      <div class="form-group">
        <label>Model</label>
        <select name="model">
          <option value="">Global default (${escapeHtml(defaults.model)})</option>
          ${(defaults.availableModels || [])
            .map((m) => {
              const selected =
                m === 'claude-cli'
                  ? agent.llmBackend === 'claude-cli'
                    ? 'selected'
                    : ''
                  : agent.model === m && agent.llmBackend !== 'claude-cli'
                    ? 'selected'
                    : '';
              return `<option value="${escapeHtml(m)}" ${selected}>${escapeHtml(m)}</option>`;
            })
            .join('')}
        </select>
      </div>
      <div class="form-group">
        <label>System Prompt</label>
        <textarea name="systemPrompt" rows="4" placeholder="${escapeHtml(defaults.systemPrompt)}">${escapeHtml(agent.conversation?.systemPrompt || '')}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Temperature</label>
          <input type="number" name="temperature" min="0" max="2" step="0.1" value="${agent.conversation?.temperature ?? ''}" placeholder="${defaults.temperature}">
        </div>
        <div class="form-group">
          <label>Max History</label>
          <input type="number" name="maxHistory" min="1" step="1" value="${agent.conversation?.maxHistory ?? ''}" placeholder="${defaults.maxHistory}">
        </div>
      </div>
      <div class="form-group">
        <label>Soul Directory</label>
        <div class="input-with-btn">
          <input type="text" name="soulDir" value="${escapeHtml(agent.soulDir || '')}" placeholder="${escapeHtml(defaults.soulDir)}">
          <button type="button" class="btn btn-sm" id="btn-init-soul">Init Custom Soul</button>
        </div>
      </div>
      <div class="form-group">
        <label>Working Directory</label>
        <input type="text" name="workDir" value="${escapeHtml(agent.workDir || '')}" placeholder="${escapeHtml(`${defaults.productionsBaseDir || './productions'}/${agent.id}`)}">
        <span class="text-dim text-sm">File tools and exec operate within this directory. Default: productions/&lt;botId&gt;</span>
      </div>
      <div class="form-group">
        <label>Productions</label>
        <select name="productionsEnabled">
          <option value="true" ${agent.productions?.enabled !== false ? 'selected' : ''}>Enabled (default)</option>
          <option value="false" ${agent.productions?.enabled === false ? 'selected' : ''}>Disabled</option>
        </select>
        <span class="text-dim text-sm">When disabled, the agent loop won't instruct the bot to produce files or scan the working directory</span>
      </div>

      <div class="form-separator"></div>
      <div class="form-section-title">Agent Loop <span class="text-dim text-sm">(empty = use global default)</span></div>

      <div class="form-group">
        <label>Agent Loop Enabled</label>
        <select name="agentLoopEnabled">
          <option value="" ${agent.agentLoop?.enabled == null ? 'selected' : ''}>Inherit global</option>
          <option value="true" ${agent.agentLoop?.enabled === true ? 'selected' : ''}>On</option>
          <option value="false" ${agent.agentLoop?.enabled === false ? 'selected' : ''}>Off</option>
        </select>
        <span class="text-dim text-sm">Override global agent loop setting for this bot</span>
      </div>

      <div class="form-group">
        <label>Loop Interval</label>
        <input type="text" name="agentLoopEvery" value="${escapeHtml(agent.agentLoop?.every || '')}" placeholder="${escapeHtml(defaults.agentLoopInterval || '6h')}">
        <span class="text-dim text-sm">How often this bot runs autonomously (e.g. 30m, 1h, 6h, 1d)</span>
      </div>

      <div class="form-group">
        <label>Standing Directives</label>
        <textarea name="agentLoopDirectives" rows="3" placeholder="One directive per line — ongoing behavioral instructions for the agent loop">${escapeHtml((agent.agentLoop?.directives || []).join('\n'))}</textarea>
        <span class="text-dim text-sm">Ongoing instructions injected into strategist/planner/executor prompts (max 10, 500 chars each)</span>
      </div>

      <div class="form-group">
        <label>Preset Directives</label>
        <div class="checkbox-group">
          <label class="${(agent.agentLoop?.presetDirectives || []).includes('conversation-review') ? 'checked' : ''}">
            <input type="checkbox" name="presetDirectives" value="conversation-review" ${(agent.agentLoop?.presetDirectives || []).includes('conversation-review') ? 'checked' : ''}>
            Conversation Review <span class="text-dim text-sm">— periodically review session logs for quality improvements</span>
          </label>
        </div>
      </div>

      ${
        defaults.ttsEnabled
          ? `
      <div class="form-separator"></div>
      <div class="form-section-title">Voice (TTS) <span class="text-dim text-sm">(empty = use global default)</span></div>

      <div class="form-group">
        <label>Voice</label>
        <div class="input-with-btn">
          <select name="ttsVoiceId" id="tts-voice-select">
            <option value="">Global default${defaults.ttsVoiceId ? ` (${escapeHtml(defaults.ttsVoiceId)})` : ''}</option>
            ${agent.tts?.voiceId ? `<option value="${escapeHtml(agent.tts.voiceId)}" selected>${escapeHtml(agent.tts.voiceId)}</option>` : ''}
          </select>
          <button type="button" class="btn btn-sm" id="btn-load-voices">Load Voices</button>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Speed</label>
          <input type="number" name="ttsSpeed" min="0.5" max="2" step="0.1" value="${agent.tts?.voiceSettings?.speed ?? ''}" placeholder="1.0">
        </div>
        <div class="form-group">
          <label>Stability</label>
          <input type="number" name="ttsStability" min="0" max="1" step="0.1" value="${agent.tts?.voiceSettings?.stability ?? ''}" placeholder="0.5">
        </div>
      </div>
      `
          : ''
      }

      ${
        defaults.availableTools?.length
          ? `
      <div class="form-separator"></div>
      <div class="form-section-title">Tools <span class="text-dim text-sm">(uncheck to disable)</span></div>

      <div class="form-group">
        <div class="checkbox-group" id="tools-group">
          ${defaults.availableTools
            .map((t) => {
              const disabled = (agent.disabledTools || []).includes(t);
              return `
            <label class="${!disabled ? 'checked' : ''}">
              <input type="checkbox" name="tools" value="${escapeHtml(t)}" ${!disabled ? 'checked' : ''}>
              ${escapeHtml(t)}
            </label>`;
            })
            .join('')}
        </div>
      </div>
      `
          : ''
      }

      ${
        defaults.availableSkills?.length
          ? `
      <div class="form-separator"></div>
      <div class="form-section-title">External Skills <span class="text-dim text-sm">(uncheck to disable all tools from a skill)</span></div>

      <div class="form-group">
        <div class="checkbox-group" id="ext-skills-group">
          ${defaults.availableSkills
            .map((s) => {
              const disabled = (agent.disabledSkills || []).includes(s);
              return `
            <label class="${!disabled ? 'checked' : ''}">
              <input type="checkbox" name="extSkills" value="${escapeHtml(s)}" ${!disabled ? 'checked' : ''}>
              ${escapeHtml(s)}
            </label>`;
            })
            .join('')}
        </div>
      </div>
      `
          : ''
      }

      <div class="actions">
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn" id="btn-generate-soul">Generate Soul</button>
        <a href="#/agents/${id}" class="btn">Cancel</a>
      </div>
    </form>
  `;

  // Toggle checkbox styling
  el.querySelectorAll('.checkbox-group input').forEach((inp) => {
    inp.addEventListener('change', () => {
      inp.parentElement.classList.toggle('checked', inp.checked);
    });
  });

  // Skills select all / unselect all
  function setAllSkillCheckboxes(checked) {
    el.querySelectorAll('#skills-group input[type="checkbox"]').forEach((inp) => {
      inp.checked = checked;
      inp.parentElement.classList.toggle('checked', checked);
    });
  }
  document.getElementById('skills-select-all')?.addEventListener('click', (e) => {
    e.preventDefault();
    setAllSkillCheckboxes(true);
  });
  document.getElementById('skills-unselect-all')?.addEventListener('click', (e) => {
    e.preventDefault();
    setAllSkillCheckboxes(false);
  });

  // Init custom soul button
  document.getElementById('btn-init-soul').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Initializing...';
    const result = await api(`/api/agents/${id}/init-soul`, { method: 'POST' });
    if (result.soulDir) {
      const soulDirInput = document.querySelector('input[name="soulDir"]');
      soulDirInput.value = result.soulDir;
    }
    e.target.textContent = 'Done';
    setTimeout(() => {
      e.target.disabled = false;
      e.target.textContent = 'Init Custom Soul';
    }, 2000);
  });

  // Generate soul button (bottom of form)
  document.getElementById('btn-generate-soul').addEventListener('click', () => {
    showGenerateSoulModal(id, agent.name, () => renderAgentEdit(el, id));
  });

  // Soul status banner retry button
  const soulRetryBtn = document.getElementById('btn-soul-retry');
  if (soulRetryBtn) {
    soulRetryBtn.addEventListener('click', () => {
      showGenerateSoulModal(id, agent.name, () => renderAgentEdit(el, id));
    });
  }

  // Load ElevenLabs voices button
  const loadVoicesBtn = document.getElementById('btn-load-voices');
  if (loadVoicesBtn) {
    loadVoicesBtn.addEventListener('click', async () => {
      loadVoicesBtn.disabled = true;
      loadVoicesBtn.textContent = 'Loading...';
      try {
        const data = await api('/api/integrations/elevenlabs/voices');
        if (data.error) {
          alert(`Failed to load voices: ${data.error}`);
          return;
        }
        const select = document.getElementById('tts-voice-select');
        const currentValue = select.value;
        select.innerHTML = `<option value="">Global default${defaults.ttsVoiceId ? ` (${escapeHtml(defaults.ttsVoiceId)})` : ''}</option>`;
        for (const v of data.voices) {
          const labelParts = [v.name];
          if (v.labels) {
            const tags = [v.labels.gender, v.labels.accent, v.labels.age].filter(Boolean);
            if (tags.length) labelParts.push(`(${tags.join(', ')})`);
          }
          const opt = document.createElement('option');
          opt.value = v.voice_id;
          opt.textContent = labelParts.join(' ');
          if (v.voice_id === currentValue) opt.selected = true;
          select.appendChild(opt);
        }
        loadVoicesBtn.textContent = 'Loaded';
      } catch (err) {
        alert(`Failed to load voices: ${err.message}`);
      } finally {
        loadVoicesBtn.disabled = false;
        setTimeout(() => {
          loadVoicesBtn.textContent = 'Load Voices';
        }, 2000);
      }
    });
  }

  document.getElementById('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const patch = { name: form.name.value, enabled: form.enabled.checked };

    if (form.token.value) patch.token = form.token.value;

    patch.skills = Array.from(form.querySelectorAll('input[name="skills"]:checked')).map(
      (i) => i.value
    );
    patch.mentionPatterns = form.mentionPatterns.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Per-agent overrides (use null to clear — undefined is stripped by JSON.stringify)
    const selectedModel = form.model.value.trim();
    if (selectedModel === 'claude-cli') {
      patch.model = null;
      patch.llmBackend = 'claude-cli';
    } else {
      patch.model = selectedModel || null;
      patch.llmBackend = null;
    }
    patch.soulDir = form.soulDir.value.trim() || null;
    patch.workDir = form.workDir.value.trim() || null;

    // Productions toggle
    const productionsEnabledVal = form.productionsEnabled.value;
    patch.productions = { ...agent.productions, enabled: productionsEnabledVal !== 'false' };

    // Build conversation overrides
    const systemPrompt = form.systemPrompt.value.trim() || undefined;
    const temperature =
      form.temperature.value !== '' ? Number.parseFloat(form.temperature.value) : undefined;
    const maxHistory =
      form.maxHistory.value !== '' ? Number.parseInt(form.maxHistory.value, 10) : undefined;

    if (systemPrompt !== undefined || temperature !== undefined || maxHistory !== undefined) {
      patch.conversation = { systemPrompt, temperature, maxHistory };
    } else {
      patch.conversation = undefined;
    }

    // Disabled tools (unchecked = disabled)
    if (defaults.availableTools?.length) {
      const checkedTools = Array.from(form.querySelectorAll('input[name="tools"]:checked')).map(
        (i) => i.value
      );
      const disabledTools = defaults.availableTools.filter((t) => !checkedTools.includes(t));
      patch.disabledTools = disabledTools.length > 0 ? disabledTools : [];
    }

    // Disabled external skills (unchecked = disabled)
    if (defaults.availableSkills?.length) {
      const checkedSkills = Array.from(
        form.querySelectorAll('input[name="extSkills"]:checked')
      ).map((i) => i.value);
      const disabledSkills = defaults.availableSkills.filter((s) => !checkedSkills.includes(s));
      patch.disabledSkills = disabledSkills.length > 0 ? disabledSkills : [];
    }

    // Agent loop overrides
    const agentLoopEvery = form.agentLoopEvery.value.trim() || undefined;
    const agentLoopEnabledVal = form.agentLoopEnabled.value;
    const agentLoopEnabled =
      agentLoopEnabledVal === 'true' ? true : agentLoopEnabledVal === 'false' ? false : undefined;
    const directivesRaw = form.agentLoopDirectives.value.trim();
    const agentLoopDirectives = directivesRaw
      ? directivesRaw
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 10)
      : undefined;
    const presetCheckboxes = form.querySelectorAll
      ? el.querySelectorAll('input[name="presetDirectives"]:checked')
      : [];
    const presetDirectives = Array.from(presetCheckboxes).map((cb) => cb.value);

    const agentLoopPatch = { ...agent.agentLoop };
    let agentLoopChanged = false;

    if (agentLoopEvery !== undefined) {
      agentLoopPatch.every = agentLoopEvery;
      agentLoopChanged = true;
    } else if (agent.agentLoop?.every) {
      agentLoopPatch.every = undefined;
      agentLoopChanged = true;
    }

    if (agentLoopEnabled !== agent.agentLoop?.enabled) {
      agentLoopPatch.enabled = agentLoopEnabled;
      agentLoopChanged = true;
    }
    if (JSON.stringify(agentLoopDirectives) !== JSON.stringify(agent.agentLoop?.directives)) {
      agentLoopPatch.directives = agentLoopDirectives;
      agentLoopChanged = true;
    }
    if (
      JSON.stringify(presetDirectives) !== JSON.stringify(agent.agentLoop?.presetDirectives || [])
    ) {
      agentLoopPatch.presetDirectives = presetDirectives.length > 0 ? presetDirectives : undefined;
      agentLoopChanged = true;
    }

    if (agentLoopChanged) {
      const hasValues = Object.values(agentLoopPatch).some((v) => v !== undefined);
      patch.agentLoop = hasValues ? agentLoopPatch : undefined;
    }

    // TTS overrides
    if (defaults.ttsEnabled) {
      const ttsVoiceId = form.ttsVoiceId?.value || undefined;
      const ttsSpeed =
        form.ttsSpeed?.value !== '' ? Number.parseFloat(form.ttsSpeed.value) : undefined;
      const ttsStability =
        form.ttsStability?.value !== '' ? Number.parseFloat(form.ttsStability.value) : undefined;

      if (ttsVoiceId || ttsSpeed !== undefined || ttsStability !== undefined) {
        patch.tts = { voiceId: ttsVoiceId };
        if (ttsSpeed !== undefined || ttsStability !== undefined) {
          patch.tts.voiceSettings = {};
          if (ttsSpeed !== undefined) patch.tts.voiceSettings.speed = ttsSpeed;
          if (ttsStability !== undefined) patch.tts.voiceSettings.stability = ttsStability;
        }
      } else {
        patch.tts = undefined;
      }
    }

    await api(`/api/agents/${id}`, { method: 'PATCH', body: patch });
    location.hash = `#/agents/${id}`;
  });
}

function showCloneModal(sourceId, el, onDone) {
  showModal(`
    <div class="modal-title">Clone Agent</div>
    <div class="form-group">
      <label>New ID</label>
      <input type="text" id="clone-id" placeholder="e.g. my-new-bot">
    </div>
    <div class="form-group">
      <label>New Name</label>
      <input type="text" id="clone-name" placeholder="e.g. My New Bot">
    </div>
    <div class="modal-actions">
      <button class="btn" id="clone-cancel">Cancel</button>
      <button class="btn btn-primary" id="clone-confirm">Clone</button>
    </div>
  `);

  document.getElementById('clone-cancel').addEventListener('click', closeModal);
  document.getElementById('clone-confirm').addEventListener('click', async () => {
    const id = document.getElementById('clone-id').value.trim();
    const name = document.getElementById('clone-name').value.trim();
    if (!id || !name) return;

    await api(`/api/agents/${sourceId}/clone`, { method: 'POST', body: { id, name } });
    closeModal();
    if (onDone) onDone();
    else renderAgents(el);
  });
}

async function showGenerateSoulModal(agentId, agentName, onComplete) {
  const defaults = await api('/api/agents/defaults');
  const models = defaults.availableModels || ['claude-cli'];

  showModal(`
    <div class="modal-title">Generate Soul with AI</div>
    <div class="form-group">
      <label>Role</label>
      <input type="text" id="gen-role" placeholder="e.g. therapist, coach, assistant, comedian">
    </div>
    <div class="form-group">
      <label>Personality Description</label>
      <textarea id="gen-personality" rows="4" placeholder="Describe the bot's personality, tone, and character traits..."></textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Language</label>
        <select id="gen-language">
          <option value="Spanish" selected>Spanish</option>
          <option value="English">English</option>
        </select>
      </div>
      <div class="form-group">
        <label>Emoji (optional)</label>
        <input type="text" id="gen-emoji" placeholder="AI picks if empty" maxlength="4" style="width:80px">
      </div>
    </div>
    <div class="form-group">
      <label>Generation Model</label>
      <select id="gen-model">
        ${models.map((m) => `<option value="${escapeHtml(m)}"${m === 'claude-cli' ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('')}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn" id="gen-cancel">Cancel</button>
      <button class="btn btn-primary" id="gen-submit">Generate</button>
    </div>
  `);

  document.getElementById('gen-cancel').addEventListener('click', closeModal);
  document.getElementById('gen-submit').addEventListener('click', async () => {
    const role = document.getElementById('gen-role').value.trim();
    const personalityDescription = document.getElementById('gen-personality').value.trim();
    const language = document.getElementById('gen-language').value;
    const emoji = document.getElementById('gen-emoji').value.trim();
    const selectedModel = document.getElementById('gen-model').value;

    if (!role || !personalityDescription) {
      alert('Role and personality description are required.');
      return;
    }

    const llmBackend = selectedModel === 'claude-cli' ? 'claude-cli' : 'ollama';
    const model = selectedModel === 'claude-cli' ? undefined : selectedModel;

    const btn = document.getElementById('gen-submit');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    try {
      const result = await api(`/api/agents/${agentId}/generate-soul`, {
        method: 'POST',
        body: {
          name: agentName,
          role,
          personalityDescription,
          language,
          emoji: emoji || undefined,
          llmBackend,
          model,
        },
      });

      if (result.error) {
        alert(`Generation failed: ${result.error}`);
        btn.disabled = false;
        btn.textContent = 'Generate';
        return;
      }

      showSoulPreviewModal(
        agentId,
        agentName,
        result,
        { role, personalityDescription, language, emoji, llmBackend, model },
        { onComplete }
      );
    } catch (err) {
      alert(`Generation failed: ${err.message || err}`);
      btn.disabled = false;
      btn.textContent = 'Generate';
    }
  });
}

function showSoulPreviewModal(agentId, agentName, soulData, inputData, options = {}) {
  const { onComplete } = options;
  closeModal();
  showModal(`
    <div class="modal-title">Generated Soul Preview</div>
    <div style="max-height:60vh;overflow-y:auto">
      <h4>IDENTITY.md</h4>
      <pre class="code-block">${escapeHtml(soulData.identity)}</pre>
      <h4>SOUL.md</h4>
      <pre class="code-block">${escapeHtml(soulData.soul)}</pre>
      <h4>MOTIVATIONS.md</h4>
      <pre class="code-block">${escapeHtml(soulData.motivations)}</pre>
    </div>
    <div class="modal-actions">
      ${
        onComplete
          ? '<button class="btn" id="preview-skip">Skip</button>'
          : '<button class="btn" id="preview-cancel">Cancel</button>'
      }
      <button class="btn" id="preview-regenerate">Regenerate</button>
      <button class="btn btn-primary" id="preview-apply">Apply</button>
    </div>
  `);

  if (onComplete) {
    document.getElementById('preview-skip').addEventListener('click', () => {
      closeModal();
      onComplete();
    });
  } else {
    document.getElementById('preview-cancel').addEventListener('click', closeModal);
  }

  document.getElementById('preview-regenerate').addEventListener('click', async () => {
    const btn = document.getElementById('preview-regenerate');
    btn.disabled = true;
    btn.textContent = 'Regenerating...';

    try {
      const result = await api(`/api/agents/${agentId}/generate-soul`, {
        method: 'POST',
        body: {
          name: agentName,
          role: inputData.role,
          personalityDescription: inputData.personalityDescription,
          language: inputData.language,
          emoji: inputData.emoji || undefined,
          llmBackend: inputData.llmBackend,
          model: inputData.model,
        },
      });

      if (result.error) {
        alert(`Regeneration failed: ${result.error}`);
        btn.disabled = false;
        btn.textContent = 'Regenerate';
        return;
      }

      showSoulPreviewModal(agentId, agentName, result, inputData, options);
    } catch (err) {
      alert(`Regeneration failed: ${err.message || err}`);
      btn.disabled = false;
      btn.textContent = 'Regenerate';
    }
  });

  document.getElementById('preview-apply').addEventListener('click', async () => {
    const btn = document.getElementById('preview-apply');
    btn.disabled = true;
    btn.textContent = 'Applying...';

    try {
      const result = await api(`/api/agents/${agentId}/apply-soul`, {
        method: 'POST',
        body: soulData,
      });

      if (result.error) {
        alert(`Apply failed: ${result.error}`);
        btn.disabled = false;
        btn.textContent = 'Apply';
        return;
      }

      closeModal();
      if (onComplete) {
        onComplete();
      }
    } catch (err) {
      alert(`Apply failed: ${err.message || err}`);
      btn.disabled = false;
      btn.textContent = 'Apply';
    }
  });
}

async function showNewAgentModal(skills, el) {
  const defaults = await api('/api/agents/defaults');
  const models = defaults.availableModels || ['claude-cli'];

  showModal(`
    <div class="modal-title">New Agent</div>
    <div class="form-group">
      <label>ID</label>
      <input type="text" id="new-id" placeholder="e.g. my-bot">
    </div>
    <div class="form-group">
      <label>Name</label>
      <input type="text" id="new-name" placeholder="e.g. My Bot">
    </div>
    <div class="form-group">
      <label>Token</label>
      <input type="password" id="new-token" placeholder="Telegram bot token">
    </div>
    <div class="form-separator"></div>
    <div class="form-section-title">Soul Generation</div>
    <div class="form-group">
      <label>Role</label>
      <input type="text" id="new-role" placeholder="e.g. therapist, coach, assistant, comedian">
    </div>
    <div class="form-group">
      <label>Personality Description</label>
      <textarea id="new-personality" rows="4" placeholder="Describe the bot's personality, tone, and character traits..."></textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Language</label>
        <select id="new-language">
          <option value="Spanish" selected>Spanish</option>
          <option value="English">English</option>
        </select>
      </div>
      <div class="form-group">
        <label>Emoji (optional)</label>
        <input type="text" id="new-emoji" placeholder="AI picks if empty" maxlength="4" style="width:80px">
      </div>
    </div>
    <div class="form-group">
      <label>Generation Model</label>
      <select id="new-gen-model">
        ${models.map((m) => `<option value="${escapeHtml(m)}"${m === 'claude-cli' ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('')}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn" id="new-cancel">Cancel</button>
      <button class="btn btn-primary" id="new-confirm">Create & Generate Soul</button>
    </div>
  `);

  document.getElementById('new-cancel').addEventListener('click', closeModal);
  document.getElementById('new-confirm').addEventListener('click', async () => {
    const id = document.getElementById('new-id').value.trim();
    const name = document.getElementById('new-name').value.trim();
    const token = document.getElementById('new-token').value.trim();
    const role = document.getElementById('new-role').value.trim();
    const personalityDescription = document.getElementById('new-personality').value.trim();
    const language = document.getElementById('new-language').value;
    const emoji = document.getElementById('new-emoji').value.trim();
    const selectedModel = document.getElementById('new-gen-model').value;

    if (!id || !name || !token || !role || !personalityDescription) {
      alert('ID, Name, Token, Role, and Personality Description are required.');
      return;
    }

    const llmBackend = selectedModel === 'claude-cli' ? 'claude-cli' : 'ollama';
    const model = selectedModel === 'claude-cli' ? undefined : selectedModel;

    const btn = document.getElementById('new-confirm');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
      const createResult = await api('/api/agents', {
        method: 'POST',
        body: { id, name, token, skills: [], enabled: false },
      });
      if (createResult.error) {
        alert(`Failed to create agent: ${createResult.error}`);
        btn.disabled = false;
        btn.textContent = 'Create & Generate Soul';
        return;
      }

      btn.textContent = 'Generating soul...';

      const soulResult = await api(`/api/agents/${id}/generate-soul`, {
        method: 'POST',
        body: {
          name,
          role,
          personalityDescription,
          language,
          emoji: emoji || undefined,
          llmBackend,
          model,
        },
      });

      if (soulResult.error) {
        alert(`Agent created, but soul generation failed: ${soulResult.error}`);
        closeModal();
        location.hash = `#/agents/${id}/edit`;
        return;
      }

      const inputData = { role, personalityDescription, language, emoji, llmBackend, model };
      showSoulPreviewModal(id, name, soulResult, inputData, {
        onComplete: () => {
          location.hash = `#/agents/${id}/edit`;
        },
      });
    } catch (err) {
      alert(`Failed: ${err.message || err}`);
      btn.disabled = false;
      btn.textContent = 'Create & Generate Soul';
    }
  });
}

function showExportModal(botId) {
  showModal(`
    <div class="modal-title">Export Agent: ${escapeHtml(botId)}</div>
    <p class="text-dim mb-16">Select what to include in the export archive (.tar.gz). Soul files are always included.</p>
    <div class="form-group">
      <label><input type="checkbox" id="export-productions"> Include productions</label>
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="export-conversations"> Include conversations</label>
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="export-karma"> Include karma</label>
    </div>
    <div class="modal-actions">
      <button class="btn" id="export-cancel">Cancel</button>
      <button class="btn btn-primary" id="export-confirm">Download Export</button>
    </div>
  `);

  document.getElementById('export-cancel').addEventListener('click', closeModal);
  document.getElementById('export-confirm').addEventListener('click', async () => {
    const productions = document.getElementById('export-productions').checked;
    const conversations = document.getElementById('export-conversations').checked;
    const karma = document.getElementById('export-karma').checked;

    const params = new URLSearchParams();
    if (productions) params.set('productions', 'true');
    if (conversations) params.set('conversations', 'true');
    if (karma) params.set('karma', 'true');

    const url = `/api/agents/${encodeURIComponent(botId)}/export?${params}`;
    const btn = document.getElementById('export-confirm');
    btn.disabled = true;
    btn.textContent = 'Downloading...';

    try {
      const headers = {};
      const token = getAuthToken();
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(url, { headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Export failed' }));
        alert(err.error || 'Export failed');
        btn.disabled = false;
        btn.textContent = 'Download Export';
        return;
      }

      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] || `${botId}-export.tar.gz`;

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      alert(`Export failed: ${err.message || err}`);
      btn.disabled = false;
      btn.textContent = 'Download Export';
      return;
    }

    closeModal();
  });
}

function showImportModal(el) {
  showModal(`
    <div class="modal-title">Import Agent</div>
    <p class="text-dim mb-16">Upload a .tar.gz export archive to import an agent.</p>
    <div class="form-group">
      <label>Archive file</label>
      <input type="file" id="import-file" accept=".tar.gz,.gz">
    </div>
    <div class="form-group">
      <label>New Bot ID (optional, overrides the ID in the archive)</label>
      <input type="text" id="import-bot-id" placeholder="Leave empty to use original ID">
    </div>
    <div class="form-group">
      <label>New Bot Name (optional)</label>
      <input type="text" id="import-bot-name" placeholder="Leave empty to use original name">
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="import-overwrite"> Overwrite if agent already exists</label>
    </div>
    <div class="modal-actions">
      <button class="btn" id="import-cancel">Cancel</button>
      <button class="btn btn-primary" id="import-confirm">Import</button>
    </div>
  `);

  document.getElementById('import-cancel').addEventListener('click', closeModal);
  document.getElementById('import-confirm').addEventListener('click', async () => {
    const fileInput = document.getElementById('import-file');
    const file = fileInput.files?.[0];
    if (!file) {
      alert('Please select a file');
      return;
    }

    const btn = document.getElementById('import-confirm');
    btn.disabled = true;
    btn.textContent = 'Importing...';

    try {
      const newBotId = document.getElementById('import-bot-id').value.trim();
      const newBotName = document.getElementById('import-bot-name').value.trim();
      const overwrite = document.getElementById('import-overwrite').checked;

      const params = new URLSearchParams();
      if (newBotId) params.set('newBotId', newBotId);
      if (newBotName) params.set('newBotName', newBotName);
      if (overwrite) params.set('overwrite', 'true');

      const formData = new FormData();
      formData.append('file', file);

      const headers = {};
      const token = getAuthToken();
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(`/api/agents/import?${params}`, {
        method: 'POST',
        headers,
        body: formData,
      });

      const result = await res.json();
      if (!res.ok) {
        alert(`Import failed: ${result.error}`);
        btn.disabled = false;
        btn.textContent = 'Import';
        return;
      }

      let msg = `Agent "${result.botName}" (${result.botId}) imported successfully.`;
      if (result.warnings?.length) {
        msg += `\n\nWarnings:\n- ${result.warnings.join('\n- ')}`;
      }
      alert(msg);
      closeModal();
      renderAgents(el);
    } catch (err) {
      alert(`Import failed: ${err.message || err}`);
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  });
}
