import { api, escapeHtml } from './shared.js';

export async function renderIntegrations(el) {
  el.innerHTML = '<div class="page-title">Integrations</div><p class="text-dim">Loading...</p>';

  const [status, toolsData] = await Promise.all([
    api('/api/integrations/ollama/status'),
    api('/api/integrations/ollama/tools'),
  ]);

  const availableTools = toolsData.tools || [];

  el.innerHTML = `
    <div class="page-title">Integrations</div>

    <div class="detail-card" id="ollama-status-card">
      <div class="form-section-title">Ollama Status</div>
      <div id="ollama-status-body">
        ${renderStatusBody(status)}
      </div>
      <div style="margin-top:12px">
        <button type="button" class="btn btn-sm" id="ollama-refresh-btn">Refresh</button>
      </div>
    </div>

    <div class="detail-card" id="ollama-chat-card">
      <div class="form-section-title">Test Chat</div>
      <p class="text-dim text-sm mb-16">Send a test message through the same OllamaClient code path the bots use.</p>

      <div class="form-row" style="align-items:flex-end;gap:8px">
        <div class="form-group" style="width:220px;margin-bottom:0">
          <label>Model</label>
          <select id="chat-model">
            ${buildModelOptions(status)}
          </select>
        </div>
        <div class="form-group" style="flex:1;margin-bottom:0">
          <label>Message</label>
          <input type="text" id="chat-message" placeholder="Hello, are you there?" value="Say hi in one sentence.">
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="chat-send-btn" style="margin-bottom:0"${status.ok ? '' : ' disabled'}>Send</button>
      </div>

      <div id="chat-result" style="margin-top:16px"></div>
    </div>

    <div class="detail-card" id="ollama-tools-card">
      <div class="form-section-title">Test Chat with Tools</div>
      <p class="text-dim text-sm mb-16">Send a message with tool definitions attached — same code path as the agent loop. Use this to verify whether a model supports native tool calling.</p>

      <div class="form-row" style="align-items:flex-end;gap:8px">
        <div class="form-group" style="width:220px;margin-bottom:0">
          <label>Model</label>
          <select id="tools-model">
            ${buildModelOptions(status)}
          </select>
        </div>
        <div class="form-group" style="flex:1;margin-bottom:0">
          <label>Message</label>
          <input type="text" id="tools-message" placeholder="What time is it?" value="What time is it?">
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="tools-send-btn" style="margin-bottom:0"${status.ok && availableTools.length > 0 ? '' : ' disabled'}>Send</button>
      </div>

      <div style="margin-top:12px">
        <label class="text-dim text-sm">Tools (${availableTools.length})</label>
        <div style="margin-top:4px;display:flex;align-items:center;gap:8px">
          <button type="button" class="btn btn-sm" id="tools-toggle-btn" style="font-size:11px">Select All</button>
        </div>
        <div id="tools-checklist" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px 16px;max-height:200px;overflow-y:auto">
          ${availableTools.map((t) => `
            <label style="display:flex;align-items:center;gap:4px;font-size:13px;cursor:pointer">
              <input type="checkbox" class="tool-checkbox" value="${escapeHtml(t)}" checked>
              <code style="font-size:12px">${escapeHtml(t)}</code>
            </label>
          `).join('')}
          ${availableTools.length === 0 ? '<span class="text-dim text-sm">No tools registered</span>' : ''}
        </div>
      </div>

      <div id="tools-result" style="margin-top:16px"></div>
    </div>
  `;

  // Refresh button
  document.getElementById('ollama-refresh-btn').addEventListener('click', async () => {
    const btn = document.getElementById('ollama-refresh-btn');
    btn.disabled = true;
    btn.textContent = 'Checking...';

    const freshStatus = await api('/api/integrations/ollama/status');
    document.getElementById('ollama-status-body').innerHTML = renderStatusBody(freshStatus);

    // Update both model dropdowns
    const modelHtml = buildModelOptions(freshStatus);
    document.getElementById('chat-model').innerHTML = modelHtml;
    document.getElementById('tools-model').innerHTML = modelHtml;
    document.getElementById('chat-send-btn').disabled = !freshStatus.ok;
    document.getElementById('tools-send-btn').disabled = !freshStatus.ok || availableTools.length === 0;

    btn.disabled = false;
    btn.textContent = 'Refresh';
  });

  // Send chat (no tools)
  document.getElementById('chat-send-btn').addEventListener('click', sendChat);
  document.getElementById('chat-message').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });

  // Tools toggle (Select All / None)
  document.getElementById('tools-toggle-btn').addEventListener('click', () => {
    const boxes = document.querySelectorAll('.tool-checkbox');
    const allChecked = [...boxes].every((b) => b.checked);
    boxes.forEach((b) => (b.checked = !allChecked));
    document.getElementById('tools-toggle-btn').textContent = allChecked ? 'Select All' : 'Select None';
  });

  // Send chat with tools
  document.getElementById('tools-send-btn').addEventListener('click', sendToolChat);
  document.getElementById('tools-message').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendToolChat(); }
  });
}

async function sendChat() {
  const btn = document.getElementById('chat-send-btn');
  const msgInput = document.getElementById('chat-message');
  const modelSelect = document.getElementById('chat-model');
  const resultEl = document.getElementById('chat-result');

  const message = msgInput.value.trim();
  if (!message) return;

  btn.disabled = true;
  btn.textContent = 'Sending...';
  resultEl.innerHTML = '<p class="text-dim">Waiting for response...</p>';

  const res = await api('/api/integrations/ollama/chat', {
    method: 'POST',
    body: { message, model: modelSelect.value },
  });

  btn.disabled = false;
  btn.textContent = 'Send';

  if (res.error) {
    resultEl.innerHTML = `
      <div class="detail-card" style="border-left:3px solid var(--red);margin:0">
        <div><strong>Error</strong> <span class="text-dim text-sm">${res.durationMs != null ? `${(res.durationMs / 1000).toFixed(1)}s` : ''}</span></div>
        <pre style="white-space:pre-wrap;margin-top:8px;color:var(--red)">${escapeHtml(res.error)}</pre>
      </div>`;
  } else {
    resultEl.innerHTML = `
      <div class="detail-card" style="border-left:3px solid var(--green);margin:0">
        <div>
          <span class="badge badge-running">${escapeHtml(res.model)}</span>
          <span class="text-dim text-sm" style="margin-left:8px">${(res.durationMs / 1000).toFixed(1)}s</span>
        </div>
        <pre style="white-space:pre-wrap;margin-top:8px">${escapeHtml(res.response)}</pre>
      </div>`;
  }
}

async function sendToolChat() {
  const btn = document.getElementById('tools-send-btn');
  const msgInput = document.getElementById('tools-message');
  const modelSelect = document.getElementById('tools-model');
  const resultEl = document.getElementById('tools-result');

  const message = msgInput.value.trim();
  if (!message) return;

  const selected = [...document.querySelectorAll('.tool-checkbox:checked')].map((b) => b.value);
  if (selected.length === 0) {
    resultEl.innerHTML = '<p style="color:var(--red)">Select at least one tool.</p>';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending...';
  resultEl.innerHTML = '<p class="text-dim">Waiting for response (tool calls may take a while)...</p>';

  const res = await api('/api/integrations/ollama/chat-with-tools', {
    method: 'POST',
    body: { message, model: modelSelect.value, tools: selected },
  });

  btn.disabled = false;
  btn.textContent = 'Send';

  if (res.error) {
    resultEl.innerHTML = `
      <div class="detail-card" style="border-left:3px solid var(--red);margin:0">
        <div><strong>Error</strong> <span class="text-dim text-sm">${res.durationMs != null ? `${(res.durationMs / 1000).toFixed(1)}s` : ''}</span></div>
        <pre style="white-space:pre-wrap;margin-top:8px;color:var(--red)">${escapeHtml(res.error)}</pre>
        ${renderToolCalls(res.toolCalls)}
      </div>`;
  } else {
    resultEl.innerHTML = `
      <div class="detail-card" style="border-left:3px solid var(--green);margin:0">
        <div>
          <span class="badge badge-running">${escapeHtml(res.model)}</span>
          <span class="text-dim text-sm" style="margin-left:8px">${(res.durationMs / 1000).toFixed(1)}s</span>
          <span class="text-dim text-sm" style="margin-left:8px">${res.toolCalls?.length || 0} tool call(s)</span>
        </div>
        ${renderToolCalls(res.toolCalls)}
        <div style="margin-top:12px">
          <label class="text-dim text-sm">LLM Response</label>
          <pre style="white-space:pre-wrap;margin-top:4px">${escapeHtml(res.response)}</pre>
        </div>
      </div>`;
  }
}

function renderToolCalls(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return '';
  return `
    <div style="margin-top:12px">
      <label class="text-dim text-sm">Tool Calls</label>
      ${toolCalls.map((tc) => `
        <div style="margin-top:6px;padding:8px;border-radius:6px;background:var(--bg-secondary);border:1px solid var(--border)">
          <div>
            <code style="font-weight:600">${escapeHtml(tc.name)}</code>
            <span class="badge ${tc.success ? 'badge-running' : 'badge-error'}" style="margin-left:6px;font-size:10px">${tc.success ? 'OK' : 'FAIL'}</span>
          </div>
          <div style="margin-top:4px">
            <span class="text-dim text-sm">Args:</span>
            <pre style="white-space:pre-wrap;font-size:12px;margin-top:2px">${escapeHtml(JSON.stringify(tc.args, null, 2))}</pre>
          </div>
          <div style="margin-top:4px">
            <span class="text-dim text-sm">Result:</span>
            <pre style="white-space:pre-wrap;font-size:12px;margin-top:2px;max-height:120px;overflow-y:auto">${escapeHtml(tc.result)}</pre>
          </div>
        </div>
      `).join('')}
    </div>`;
}

function renderStatusBody(status) {
  if (status.error && !status.ok) {
    return `
      <div class="form-row">
        <div class="form-group">
          <label>Base URL</label>
          <code>${escapeHtml(status.baseUrl || '?')}</code>
        </div>
        <div class="form-group">
          <label>Status</label>
          <span class="badge badge-error">Offline</span>
        </div>
      </div>
      <div style="margin-top:8px">
        <span class="text-dim text-sm">Error:</span>
        <code class="text-sm" style="color:var(--red)">${escapeHtml(status.error)}</code>
      </div>`;
  }

  const modelList = (status.models || [])
    .map((m) => `<span class="badge badge-disabled">${escapeHtml(m)}</span>`)
    .join(' ');

  return `
    <div class="form-row">
      <div class="form-group">
        <label>Base URL</label>
        <code>${escapeHtml(status.baseUrl)}</code>
      </div>
      <div class="form-group">
        <label>Status</label>
        <span class="badge badge-running">Online</span>
      </div>
      <div class="form-group">
        <label>Latency</label>
        <span>${status.latencyMs}ms</span>
      </div>
      <div class="form-group">
        <label>Timeout</label>
        <span>${(status.timeout / 1000).toFixed(0)}s</span>
      </div>
    </div>
    <div style="margin-top:8px">
      <label class="text-dim text-sm">Models (${status.models?.length || 0})</label>
      <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px">
        ${modelList || '<span class="text-dim text-sm">No models found</span>'}
      </div>
    </div>`;
}

function buildModelOptions(status) {
  const models = status.models || [];
  if (models.length === 0) {
    return '<option value="">No models available</option>';
  }
  return models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
}
