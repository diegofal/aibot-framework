const overlay = document.getElementById('modal-overlay');
const modal = document.getElementById('modal');

export function showModal(html) {
  modal.innerHTML = html;
  overlay.classList.remove('hidden');
}

export function closeModal() {
  overlay.classList.add('hidden');
  modal.innerHTML = '';
}

// Close modal on overlay click
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeModal();
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal();
});

export function getAuthToken() {
  return sessionStorage.getItem('auth_token');
}

export function getAuthContext() {
  return {
    token: sessionStorage.getItem('auth_token'),
    role: sessionStorage.getItem('auth_role'),
    name: sessionStorage.getItem('auth_name'),
    tenantId: sessionStorage.getItem('auth_tenant_id'),
  };
}

export function clearAuth() {
  sessionStorage.removeItem('auth_token');
  sessionStorage.removeItem('auth_role');
  sessionStorage.removeItem('auth_name');
  sessionStorage.removeItem('auth_tenant_id');
}

export async function api(url, opts = {}) {
  const fetchOpts = { headers: {} };
  if (opts.method) fetchOpts.method = opts.method;
  if (opts.body) {
    fetchOpts.headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(opts.body);
  }
  const token = getAuthToken();
  if (token) {
    fetchOpts.headers.Authorization = `Bearer ${token}`;
  }
  try {
    const res = await fetch(url, fetchOpts);
    if (res.status === 401 && token) {
      clearAuth();
      window.dispatchEvent(new CustomEvent('auth:required'));
      return { error: 'Authentication required' };
    }
    return await res.json();
  } catch (err) {
    console.error('API error:', err);
    return { error: err.message };
  }
}

const _div = document.createElement('div');
export function escapeHtml(str) {
  if (!str) return '';
  _div.textContent = str;
  return _div.innerHTML;
}

export function renderContent(content, filename) {
  if (filename?.endsWith('.md') && window.marked) {
    return `<div class="md-preview">${marked.parse(content)}</div>`;
  }
  if (filename?.endsWith('.html') || filename?.endsWith('.htm')) {
    const escaped = escapeHtml(content).replace(/"/g, '&quot;');
    return `<iframe sandbox="allow-same-origin allow-scripts" srcdoc="${escaped}" style="width:100%;height:calc(100vh - 120px);min-height:400px;border:1px solid var(--border);border-radius:6px;background:var(--bg, #0f1117)"></iframe>`;
  }
  return `<pre>${escapeHtml(content)}</pre>`;
}

export function timeAgo(isoOrDate, future = false) {
  const d = new Date(isoOrDate);
  const diff = future ? d - Date.now() : Date.now() - d;
  const abs = Math.abs(diff);
  const suffix = future ? (diff > 0 ? 'from now' : 'ago') : 'ago';

  if (abs < 60_000) return 'just now';
  if (abs < 3600_000) return `${Math.floor(abs / 60_000)}m ${suffix}`;
  if (abs < 86400_000) return `${Math.floor(abs / 3600_000)}h ${suffix}`;
  return `${Math.floor(abs / 86400_000)}d ${suffix}`;
}

/**
 * Preview a file from a bot's workDir in a modal.
 * @param {string} botId
 * @param {string} path - Relative path within the bot's workDir
 */
export async function previewFile(botId, path) {
  showModal('<p class="text-dim">Loading file...</p>');
  const data = await api(`/api/files/${encodeURIComponent(botId)}/${encodeURIComponent(path)}`);
  if (data.error) {
    showModal(`
      <div class="modal-title">${escapeHtml(path)}</div>
      <p class="text-dim">${escapeHtml(data.error)}</p>
      <div class="modal-actions"><button class="btn" id="file-preview-close">Close</button></div>
    `);
    document.getElementById('file-preview-close')?.addEventListener('click', closeModal);
    return;
  }
  const sizeStr = data.size != null ? ` (${formatFileSize(data.size)})` : '';
  const modal = document.getElementById('modal');
  modal.style.maxWidth = '700px';
  showModal(`
    <div class="modal-title">${escapeHtml(data.path)}${sizeStr}</div>
    <div class="file-preview-content">${renderContent(data.content, data.path || path)}</div>
    <div class="modal-actions"><button class="btn" id="file-preview-close">Close</button></div>
  `);
  document.getElementById('file-preview-close')?.addEventListener('click', closeModal);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Render a chat-like thread component into a container.
 * @param {HTMLElement} container - Target element
 * @param {object} opts
 * @param {Array} opts.thread - ThreadMessage[] from the API
 * @param {string} [opts.legacyFeedback] - Legacy feedback/content field (first human message)
 * @param {string} [opts.legacyResponse] - Legacy aiResponse/response field (first bot message)
 * @param {function} opts.onSend - Callback when user sends a message
 * @param {boolean} opts.generating - Whether bot is currently generating a reply
 * @param {string} [opts.error] - Error message to display (replaces "is thinking")
 * @param {function} [opts.onRetry] - Callback when user clicks retry button
 * @param {string} [opts.botId] - Bot ID for file previews
 * @param {function} [opts.onApprove] - Callback(action, messageId) when user clicks approve/deny
 */
export function renderThread(container, opts) {
  const {
    thread = [],
    legacyFeedback,
    legacyResponse,
    onSend,
    generating,
    error,
    onRetry,
    botId,
    onApprove,
  } = opts;

  // Build messages list: legacy fields first (if no thread array), then thread
  const messages = [];
  if (legacyFeedback) {
    messages.push({ role: 'human', content: legacyFeedback, createdAt: null });
  }
  if (legacyResponse) {
    messages.push({ role: 'bot', content: legacyResponse, createdAt: null });
  }
  for (const msg of thread) {
    messages.push(msg);
  }

  let html = '<div class="transcript thread-messages">';

  if (messages.length === 0) {
    html +=
      '<div class="text-dim text-sm" style="padding:8px 0">No messages yet. Start the discussion below.</div>';
  } else {
    for (const msg of messages) {
      const bubbleClass = msg.role === 'human' ? 'bubble-user' : 'bubble-assistant';
      const roleLabel = msg.role === 'human' ? 'You' : 'Bot';
      const timeStr = msg.createdAt
        ? `<span class="text-dim text-sm" style="margin-left:8px">${timeAgo(msg.createdAt)}</span>`
        : '';
      let imageHtml = '';
      if (msg.images && msg.images.length > 0) {
        imageHtml =
          '<div class="bubble-images" style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">';
        for (const img of msg.images) {
          const src = img.startsWith('data:') ? img : `data:image/png;base64,${img}`;
          imageHtml += `<img src="${src}" style="max-width:180px;max-height:140px;border-radius:6px;cursor:pointer" onclick="window.open(this.src)">`;
        }
        imageHtml += '</div>';
      }
      let docHtml = '';
      if (msg.documents && msg.documents.length > 0) {
        docHtml =
          '<div class="bubble-docs" style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">';
        for (const doc of msg.documents) {
          const sizeStr = doc.size != null ? ` (${formatFileSize(doc.size)})` : '';
          docHtml += `<div class="file-chip" style="cursor:default">&#128196; ${escapeHtml(doc.name)}${sizeStr}</div>`;
        }
        docHtml += '</div>';
      }
      let approvalHtml = '';
      if (msg.approval) {
        const isPending = msg.approval.status === 'pending';
        approvalHtml = `
          <div class="approval-card ${msg.approval.status}">
            <div class="approval-header">Tool Permission Request</div>
            <div class="approval-tool">${escapeHtml(msg.approval.toolName)}</div>
            <div class="approval-desc">${escapeHtml(msg.approval.description)}</div>
            ${
              isPending
                ? `
              <div class="approval-actions">
                <button class="btn btn-primary btn-sm approval-btn" data-action="approve" data-msg-id="${msg.id}">Approve</button>
                <button class="btn btn-sm approval-btn" data-action="deny" data-msg-id="${msg.id}" style="background:var(--red);color:#fff">Deny</button>
              </div>
            `
                : `
              <div class="approval-resolved">
                <span class="badge ${msg.approval.status === 'approved' ? 'badge-success' : 'badge-error'}">
                  ${msg.approval.status === 'approved' ? 'Approved' : 'Denied'}
                </span>
              </div>
            `
            }
          </div>`;
      }

      html += `
        <div class="bubble ${bubbleClass}">
          <div class="bubble-role">${roleLabel}${timeStr}</div>
          ${escapeHtml(msg.content)}${imageHtml}${docHtml}${approvalHtml}
        </div>`;

      // Render file attachments
      if (msg.files && msg.files.length > 0 && botId) {
        html += '<div class="message-files">';
        html += '<div class="message-files-label">Files</div>';
        html += '<div class="message-files-list">';
        for (const file of msg.files) {
          const fileName = file.path.split('/').pop() || file.path;
          const sizeStr =
            file.size != null ? ` <span class="text-dim">${formatFileSize(file.size)}</span>` : '';
          html += `<div class="file-chip" data-path="${escapeHtml(file.path)}" data-bot="${escapeHtml(botId)}">&#128196; ${escapeHtml(fileName)}${sizeStr}</div>`;
        }
        html += '</div></div>';
      }
    }
  }

  if (error) {
    html += `<div class="thread-error">
      <span class="badge badge-error">Error</span>
      <span>${escapeHtml(error)}</span>
      ${onRetry ? '<button class="btn btn-retry btn-sm thread-retry-btn">Retry</button>' : ''}
    </div>`;
  } else if (generating) {
    html += '<div class="thread-typing"><span class="bubble-role">Bot</span> is thinking...</div>';
  }

  html += '</div>';

  // Input area
  html += `
    <div class="thread-input-area">
      <div class="thread-img-preview" style="display:flex;gap:4px;flex-wrap:wrap;padding:0 0 4px"></div>
      <div class="thread-doc-preview" style="display:flex;gap:4px;flex-wrap:wrap;padding:0 0 4px"></div>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <button class="btn btn-sm thread-attach-btn" title="Attach file" style="padding:4px 8px;font-size:16px"${generating || error ? ' disabled' : ''}>&#128206;</button>
        <input type="file" class="thread-file-input" accept="image/*,.pdf,.txt,.md,.csv,.json,.html,.htm" multiple style="display:none">
        <textarea class="thread-input" rows="2" placeholder="Type a message..."></textarea>
        <button class="btn btn-primary btn-sm thread-send-btn"${generating || error ? ' disabled' : ''}>Send</button>
      </div>
    </div>`;

  container.innerHTML = html;

  // Scroll to bottom of thread messages
  const messagesEl = container.querySelector('.thread-messages');
  if (messagesEl) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Wire file chip click handlers
  for (const chip of container.querySelectorAll('.file-chip')) {
    chip.addEventListener('click', () => {
      const filePath = chip.dataset.path;
      const fileBotId = chip.dataset.bot;
      if (filePath && fileBotId) previewFile(fileBotId, filePath);
    });
  }

  // File upload state
  const threadPendingImages = [];
  const threadPendingDocs = []; // { name, mimeType, content, size }
  const imgPreviewEl = container.querySelector('.thread-img-preview');
  const docPreviewEl = container.querySelector('.thread-doc-preview');
  const fileInput = container.querySelector('.thread-file-input');
  const attachBtn = container.querySelector('.thread-attach-btn');

  const ALLOWED_DOC_TYPES = [
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html',
    'application/json',
  ];
  const MAX_TOTAL_ATTACHMENTS = 4;
  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

  function totalAttachments() {
    return threadPendingImages.length + threadPendingDocs.length;
  }

  function renderImgPreviews() {
    if (!imgPreviewEl) return;
    imgPreviewEl.innerHTML = '';
    threadPendingImages.forEach((img, i) => {
      const chip = document.createElement('div');
      chip.style.cssText = 'position:relative;display:inline-block';
      chip.innerHTML = `<img src="${img.dataUrl}" style="width:48px;height:48px;object-fit:cover;border-radius:4px"><button style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;border:none;background:rgba(0,0,0,0.6);color:#fff;font-size:10px;cursor:pointer;padding:0;line-height:1;display:flex;align-items:center;justify-content:center">&times;</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        threadPendingImages.splice(i, 1);
        renderImgPreviews();
      });
      imgPreviewEl.appendChild(chip);
    });
  }

  function renderDocPreviews() {
    if (!docPreviewEl) return;
    docPreviewEl.innerHTML = '';
    threadPendingDocs.forEach((doc, i) => {
      const chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.style.cssText =
        'position:relative;display:inline-flex;align-items:center;gap:4px;padding:4px 8px;cursor:default';
      const sizeStr = doc.size != null ? ` (${formatFileSize(doc.size)})` : '';
      chip.innerHTML = `&#128196; ${escapeHtml(doc.name)}${sizeStr} <button style="margin-left:4px;width:16px;height:16px;border-radius:50%;border:none;background:rgba(0,0,0,0.6);color:#fff;font-size:10px;cursor:pointer;padding:0;line-height:1;display:flex;align-items:center;justify-content:center">&times;</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        threadPendingDocs.splice(i, 1);
        renderDocPreviews();
      });
      docPreviewEl.appendChild(chip);
    });
  }

  function handleThreadFiles(files) {
    for (const file of files) {
      if (totalAttachments() >= MAX_TOTAL_ATTACHMENTS) break;
      if (file.size > MAX_FILE_SIZE) continue;

      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          const base64 = dataUrl.split(',')[1];
          threadPendingImages.push({ base64, dataUrl });
          renderImgPreviews();
        };
        reader.readAsDataURL(file);
      } else if (
        ALLOWED_DOC_TYPES.includes(file.type) ||
        file.name.match(/\.(txt|md|csv|json|html|htm|pdf)$/i)
      ) {
        const mimeType = file.type || guessMimeType(file.name);
        if (mimeType === 'application/pdf') {
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = btoa(
              new Uint8Array(reader.result).reduce((s, b) => s + String.fromCharCode(b), '')
            );
            threadPendingDocs.push({ name: file.name, mimeType, content: base64, size: file.size });
            renderDocPreviews();
          };
          reader.readAsArrayBuffer(file);
        } else {
          const reader = new FileReader();
          reader.onload = () => {
            threadPendingDocs.push({
              name: file.name,
              mimeType,
              content: reader.result,
              size: file.size,
            });
            renderDocPreviews();
          };
          reader.readAsText(file);
        }
      }
    }
  }

  function guessMimeType(name) {
    const ext = name.split('.').pop()?.toLowerCase();
    const map = {
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      html: 'text/html',
      htm: 'text/html',
      pdf: 'application/pdf',
    };
    return map[ext] || 'text/plain';
  }

  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) handleThreadFiles(fileInput.files);
      fileInput.value = '';
    });
  }

  // Wire send button + Enter key
  const textarea = container.querySelector('.thread-input');
  const sendBtn = container.querySelector('.thread-send-btn');

  function doSend() {
    const text = textarea.value.trim();
    const images = threadPendingImages.map((img) => img.base64);
    const docs = threadPendingDocs.map((d) => ({
      name: d.name,
      mimeType: d.mimeType,
      content: d.content,
    }));
    if ((!text && images.length === 0 && docs.length === 0) || generating) return;
    textarea.value = '';
    threadPendingImages.length = 0;
    threadPendingDocs.length = 0;
    renderImgPreviews();
    renderDocPreviews();
    if (onSend)
      onSend(
        text || (docs.length > 0 ? '(document attached)' : '(image)'),
        images.length > 0 ? images : undefined,
        docs.length > 0 ? docs : undefined
      );
  }

  sendBtn.addEventListener('click', doSend);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  // Paste support on textarea (images and files)
  if (textarea) {
    textarea.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const pasteFiles = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) pasteFiles.push(file);
        }
      }
      if (pasteFiles.length > 0) {
        e.preventDefault();
        handleThreadFiles(pasteFiles);
      }
    });
  }

  // Wire retry button
  const retryBtn = container.querySelector('.thread-retry-btn');
  if (retryBtn && onRetry) {
    retryBtn.addEventListener('click', onRetry);
  }

  // Wire approval buttons
  if (onApprove) {
    for (const btn of container.querySelectorAll('.approval-btn')) {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        const msgId = btn.dataset.msgId;
        if (action && msgId) {
          // Disable buttons immediately to prevent double-click
          for (const b of container.querySelectorAll(`.approval-btn[data-msg-id="${msgId}"]`)) {
            b.disabled = true;
          }
          onApprove(action, msgId);
        }
      });
    }
  }
}

/**
 * Resolve tenantId for BaaS pages.
 * - Tenant users: returns their tenantId directly.
 * - Admin users: renders a tenant selector dropdown and calls onChange(tenantId).
 *   Returns null initially; the page should re-render when onChange fires.
 *
 * @param {HTMLElement} container - Where to render the selector (admin only)
 * @param {function} onChange - Called with selected tenantId
 * @returns {Promise<string|null>} tenantId or null if admin needs to pick
 */
export async function resolveTenantId(container, onChange) {
  const ctx = getAuthContext();

  // Tenant user — already has tenantId
  if (ctx.tenantId) {
    container.innerHTML = '';
    return ctx.tenantId;
  }

  // Admin — fetch tenant list and show selector
  if (ctx.role === 'admin') {
    const data = await api('/api/admin/tenants');
    const tenants = Array.isArray(data?.tenants) ? data.tenants : Array.isArray(data) ? data : [];

    if (tenants.length === 0) {
      container.innerHTML = '<p class="text-dim">No tenants registered yet.</p>';
      return null;
    }

    // Check if there's a previously selected tenant in sessionStorage
    const saved = sessionStorage.getItem('admin_selected_tenant');
    const savedValid = saved && tenants.some((t) => t.id === saved);

    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
        <span class="text-dim text-sm" style="white-space:nowrap">Viewing as tenant:</span>
        <select id="admin-tenant-select" style="padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px;flex:1">
          <option value="">Select a tenant...</option>
          ${tenants.map((t) => `<option value="${escapeHtml(t.id)}"${t.id === saved ? ' selected' : ''}>${escapeHtml(t.name)} (${escapeHtml(t.id)})</option>`).join('')}
        </select>
      </div>`;

    const select = container.querySelector('#admin-tenant-select');
    select.addEventListener('change', () => {
      const val = select.value;
      if (val) sessionStorage.setItem('admin_selected_tenant', val);
      onChange(val);
    });

    // If we have a saved valid selection, fire immediately
    if (savedValid) {
      return saved;
    }

    return null;
  }

  // No tenantId and not admin
  container.innerHTML = '<p class="text-dim">No tenant context available. Please log in.</p>';
  return null;
}
