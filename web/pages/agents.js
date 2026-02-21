import { showModal, closeModal, api, escapeHtml } from './shared.js';

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function statusBadge(status) {
  const cls = status === 'completed' ? 'badge-ok'
    : status === 'error' ? 'badge-error'
    : 'badge-disabled';
  return `<span class="badge ${cls}">${status}</span>`;
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
      <ol style="margin:0;padding-left:20px;font-size:13px">${r.plan.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
    </div>`);
  }

  if (r.toolCalls && r.toolCalls.length > 0) {
    sections.push(`<div class="result-section">
      <div class="result-section-title">Tool Calls (${r.toolCalls.length})</div>
      ${r.toolCalls.map(tc => {
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
      }).join('')}
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

  const [agents, skills] = await Promise.all([
    api('/api/agents'),
    api('/api/skills'),
  ]);

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Agents <span class="count">${agents.length}</span></div>
      <button class="btn btn-primary" id="btn-new-agent">+ New Agent</button>
    </div>
    <table>
      <thead><tr><th>Name</th><th>ID</th><th>Status</th><th>Skills</th><th>Actions</th></tr></thead>
      <tbody id="agents-tbody"></tbody>
    </table>
  `;

  const tbody = document.getElementById('agents-tbody');
  for (const agent of agents) {
    const statusBadge = agent.running
      ? '<span class="badge badge-running">Running</span>'
      : '<span class="badge badge-stopped">Stopped</span>';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="#/agents/${agent.id}">${escapeHtml(agent.name)}</a></td>
      <td class="text-dim">${escapeHtml(agent.id)}</td>
      <td>${statusBadge}</td>
      <td class="text-dim">${agent.skills.length}</td>
      <td class="actions">
        ${agent.running
          ? `<button class="btn btn-sm btn-danger" data-action="stop" data-id="${agent.id}">Stop</button>`
          : `<button class="btn btn-sm" data-action="start" data-id="${agent.id}">Start</button>`
        }
        ${agent.running
          ? `<button class="btn btn-sm" data-action="run-loop" data-id="${agent.id}">Run Loop</button>`
          : ''
        }
        <button class="btn btn-sm" data-action="edit" data-id="${agent.id}">Edit</button>
        <button class="btn btn-sm" data-action="clone" data-id="${agent.id}">Clone</button>
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
      if (confirm(`Reset agent "${id}"? This will clear all conversations, memory, goals, and learned facts. Soul and identity are preserved. This cannot be undone.`)) {
        btn.disabled = true;
        btn.textContent = 'Resetting...';
        const res = await api(`/api/agents/${id}/reset`, { method: 'POST' });
        if (res.error) alert(`Reset failed: ${res.error}`);
        renderAgents(el);
      }
    } else if (action === 'delete') {
      if (confirm(`Delete agent "${id}"? This cannot be undone.`)) {
        await api(`/api/agents/${id}`, { method: 'DELETE' });
        renderAgents(el);
      }
    }
  });

  document.getElementById('btn-new-agent').addEventListener('click', () => {
    showNewAgentModal(skills, el);
  });
}

export async function renderAgentDetail(el, id) {
  const [agent, skills, defaults] = await Promise.all([
    api(`/api/agents/${id}`),
    api('/api/skills'),
    api('/api/agents/defaults'),
  ]);

  if (agent.error) {
    el.innerHTML = `<p>Agent not found.</p>`;
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
    : `<span class="text-dim">${escapeHtml((defaults.productionsBaseDir || './productions') + '/' + agent.id)} (default)</span>`;

  const agentLoopEvery = agent.agentLoop?.every;
  const loopIntervalDisplay = agentLoopEvery
    ? escapeHtml(agentLoopEvery)
    : `<span class="text-dim">${escapeHtml(defaults.agentLoopInterval || '6h')} (global)</span>`;

  const systemPromptDisplay = agent.conversation?.systemPrompt
    ? escapeHtml(agent.conversation.systemPrompt).substring(0, 120) + (agent.conversation.systemPrompt.length > 120 ? '...' : '')
    : `<span class="text-dim">Global default</span>`;

  const tempDisplay = agent.conversation?.temperature !== undefined
    ? agent.conversation.temperature
    : `<span class="text-dim">${defaults.temperature} (global)</span>`;

  const maxHistDisplay = agent.conversation?.maxHistory !== undefined
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
        <tr><td class="text-dim">System Prompt</td><td>${systemPromptDisplay}</td></tr>
        <tr><td class="text-dim">Temperature</td><td>${tempDisplay}</td></tr>
        <tr><td class="text-dim">Max History</td><td>${maxHistDisplay}</td></tr>
        <tr><td class="text-dim">Skills</td><td>${agent.skills.map((s) => `<span class="badge">${escapeHtml(s)}</span>`).join(' ')}</td></tr>
        <tr><td class="text-dim">Allowed Users</td><td>${agent.allowedUsers?.length ? agent.allowedUsers.join(', ') : '<span class="text-dim">All</span>'}</td></tr>
        <tr><td class="text-dim">Mention Patterns</td><td>${agent.mentionPatterns?.length ? agent.mentionPatterns.join(', ') : '<span class="text-dim">None</span>'}</td></tr>
        <tr><td class="text-dim">Loop Interval</td><td>${loopIntervalDisplay}</td></tr>
      </table>
    </div>
    <div class="actions">
      ${agent.running
        ? `<button class="btn btn-danger" id="btn-toggle">Stop</button>`
        : `<button class="btn btn-primary" id="btn-toggle">Start</button>`
      }
      <a href="#/agents/${agent.id}/edit" class="btn">Edit</a>
      <button class="btn" id="btn-clone">Clone</button>
      ${agent.running
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
      if (!confirm(`Reset agent "${id}"? This will clear all conversations, memory, goals, and learned facts. Soul and identity are preserved. This cannot be undone.`)) return;
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

export async function renderAgentEdit(el, id) {
  const [agent, skills, defaults] = await Promise.all([
    api(`/api/agents/${id}`),
    api('/api/skills'),
    api('/api/agents/defaults'),
  ]);

  if (agent.error) {
    el.innerHTML = `<p>Agent not found.</p>`;
    return;
  }

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/agents/${id}" class="back">&larr;</a>
      <div class="page-title">Edit ${escapeHtml(agent.name)}</div>
    </div>
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
        <div class="checkbox-group" id="skills-group">
          ${skills.map((s) => `
            <label class="${agent.skills.includes(s.id) ? 'checked' : ''}">
              <input type="checkbox" name="skills" value="${s.id}" ${agent.skills.includes(s.id) ? 'checked' : ''}>
              ${escapeHtml(s.name)}
            </label>
          `).join('')}
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
          ${(defaults.availableModels || []).map((m) => {
            const selected = m === 'claude-cli'
              ? agent.llmBackend === 'claude-cli' ? 'selected' : ''
              : agent.model === m && agent.llmBackend !== 'claude-cli' ? 'selected' : '';
            return `<option value="${escapeHtml(m)}" ${selected}>${escapeHtml(m)}</option>`;
          }).join('')}
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
        <input type="text" name="workDir" value="${escapeHtml(agent.workDir || '')}" placeholder="${escapeHtml((defaults.productionsBaseDir || './productions') + '/' + agent.id)}">
        <span class="text-dim text-sm">File tools and exec operate within this directory. Default: productions/&lt;botId&gt;</span>
      </div>

      <div class="form-separator"></div>
      <div class="form-section-title">Agent Loop <span class="text-dim text-sm">(empty = use global default)</span></div>

      <div class="form-group">
        <label>Loop Interval</label>
        <input type="text" name="agentLoopEvery" value="${escapeHtml(agent.agentLoop?.every || '')}" placeholder="${escapeHtml(defaults.agentLoopInterval || '6h')}">
        <span class="text-dim text-sm">How often this bot runs autonomously (e.g. 30m, 1h, 6h, 1d)</span>
      </div>

      <div class="actions">
        <button type="submit" class="btn btn-primary">Save</button>
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

  document.getElementById('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const patch = { name: form.name.value, enabled: form.enabled.checked };

    if (form.token.value) patch.token = form.token.value;

    patch.skills = Array.from(form.querySelectorAll('input[name="skills"]:checked')).map((i) => i.value);
    patch.mentionPatterns = form.mentionPatterns.value.split(',').map((s) => s.trim()).filter(Boolean);

    // Per-agent overrides (empty string = clear override)
    const selectedModel = form.model.value.trim();
    if (selectedModel === 'claude-cli') {
      patch.model = undefined;
      patch.llmBackend = 'claude-cli';
    } else {
      patch.model = selectedModel || undefined;
      patch.llmBackend = undefined;
    }
    patch.soulDir = form.soulDir.value.trim() || undefined;
    patch.workDir = form.workDir.value.trim() || undefined;

    // Build conversation overrides
    const systemPrompt = form.systemPrompt.value.trim() || undefined;
    const temperature = form.temperature.value !== '' ? parseFloat(form.temperature.value) : undefined;
    const maxHistory = form.maxHistory.value !== '' ? parseInt(form.maxHistory.value, 10) : undefined;

    if (systemPrompt !== undefined || temperature !== undefined || maxHistory !== undefined) {
      patch.conversation = { systemPrompt, temperature, maxHistory };
    } else {
      patch.conversation = undefined;
    }

    // Agent loop overrides
    const agentLoopEvery = form.agentLoopEvery.value.trim() || undefined;
    if (agentLoopEvery !== undefined) {
      patch.agentLoop = { ...agent.agentLoop, every: agentLoopEvery };
    } else if (agent.agentLoop?.every) {
      // Clear the every field but keep other agentLoop settings
      patch.agentLoop = { ...agent.agentLoop, every: undefined };
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
    if (onDone) onDone(); else renderAgents(el);
  });
}

function showGenerateSoulModal(agentId, agentName) {
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

    if (!role || !personalityDescription) {
      alert('Role and personality description are required.');
      return;
    }

    const btn = document.getElementById('gen-submit');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    try {
      const result = await api(`/api/agents/${agentId}/generate-soul`, {
        method: 'POST',
        body: { name: agentName, role, personalityDescription, language, emoji: emoji || undefined },
      });

      if (result.error) {
        alert(`Generation failed: ${result.error}`);
        btn.disabled = false;
        btn.textContent = 'Generate';
        return;
      }

      showSoulPreviewModal(agentId, agentName, result, { role, personalityDescription, language, emoji });
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
      ${onComplete
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

function showNewAgentModal(skills, el) {
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

    if (!id || !name || !token || !role || !personalityDescription) {
      alert('ID, Name, Token, Role, and Personality Description are required.');
      return;
    }

    const btn = document.getElementById('new-confirm');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
      const createResult = await api('/api/agents', { method: 'POST', body: { id, name, token, skills: [], enabled: false } });
      if (createResult.error) {
        alert(`Failed to create agent: ${createResult.error}`);
        btn.disabled = false;
        btn.textContent = 'Create & Generate Soul';
        return;
      }

      btn.textContent = 'Generating soul...';

      const soulResult = await api(`/api/agents/${id}/generate-soul`, {
        method: 'POST',
        body: { name, role, personalityDescription, language, emoji: emoji || undefined },
      });

      if (soulResult.error) {
        alert(`Agent created, but soul generation failed: ${soulResult.error}`);
        closeModal();
        location.hash = `#/agents/${id}/edit`;
        return;
      }

      const inputData = { role, personalityDescription, language, emoji };
      showSoulPreviewModal(id, name, soulResult, inputData, {
        onComplete: () => { location.hash = `#/agents/${id}/edit`; },
      });
    } catch (err) {
      alert(`Failed: ${err.message || err}`);
      btn.disabled = false;
      btn.textContent = 'Create & Generate Soul';
    }
  });
}
