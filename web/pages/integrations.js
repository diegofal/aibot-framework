import { api, escapeHtml } from './shared.js';

export async function renderIntegrations(el) {
  el.innerHTML = '<div class="page-title">Integrations</div><p class="text-dim">Loading...</p>';

  const status = await api('/api/integrations/ollama/status');

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
  `;

  // Refresh button
  document.getElementById('ollama-refresh-btn').addEventListener('click', async () => {
    const btn = document.getElementById('ollama-refresh-btn');
    btn.disabled = true;
    btn.textContent = 'Checking...';

    const freshStatus = await api('/api/integrations/ollama/status');
    document.getElementById('ollama-status-body').innerHTML = renderStatusBody(freshStatus);

    // Update model dropdown
    const select = document.getElementById('chat-model');
    select.innerHTML = buildModelOptions(freshStatus);
    document.getElementById('chat-send-btn').disabled = !freshStatus.ok;

    btn.disabled = false;
    btn.textContent = 'Refresh';
  });

  // Send chat
  document.getElementById('chat-send-btn').addEventListener('click', sendChat);
  document.getElementById('chat-message').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChat();
    }
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
