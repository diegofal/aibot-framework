/**
 * AIBot Embeddable Chat Widget
 *
 * Usage:
 *   <script src="https://your-server.com/widget.js"
 *     data-bot-id="your-bot-id"
 *     data-server="https://your-server.com"
 *     data-title="Chat with us"
 *     data-token="your-api-key"
 *     data-theme="light"
 *     data-position="right"
 *   ></script>
 *
 * Or programmatic:
 *   AIBotWidget.init({ botId: '...', server: '...', token: '...' });
 */
(() => {
  const WIDGET_VERSION = '1.0.0';

  // Prevent double-init
  if (window.AIBotWidget?._initialized) return;

  // --- Config ---
  const scriptTag = document.currentScript;
  const defaults = {
    botId: scriptTag?.getAttribute('data-bot-id') || '',
    server: scriptTag?.getAttribute('data-server') || window.location.origin,
    title: scriptTag?.getAttribute('data-title') || 'Chat',
    token: scriptTag?.getAttribute('data-token') || '',
    theme: scriptTag?.getAttribute('data-theme') || 'light',
    position: scriptTag?.getAttribute('data-position') || 'right',
    senderId: scriptTag?.getAttribute('data-sender-id') || '',
    senderName: scriptTag?.getAttribute('data-sender-name') || '',
    userHash: scriptTag?.getAttribute('data-user-hash') || '',
  };

  const MAX_ATTACHMENTS = 4;
  const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB per file
  const ALLOWED_DOC_TYPES = [
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html',
    'application/json',
  ];

  let config = {};
  let ws = null;
  let chatId = null;
  let isOpen = false;
  let container = null;
  let pendingImages = []; // { base64, dataUrl }
  let pendingDocs = []; // { name, mimeType, content }

  // --- Styles ---
  const STYLES =
    '\n\
    .aibot-widget-btn {\n\
      position: fixed; bottom: 24px; z-index: 99999;\n\
      width: 56px; height: 56px; border-radius: 50%;\n\
      border: none; cursor: pointer;\n\
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);\n\
      display: flex; align-items: center; justify-content: center;\n\
      transition: transform 0.2s, box-shadow 0.2s;\n\
      font-size: 24px;\n\
    }\n\
    .aibot-widget-btn:hover { transform: scale(1.1); box-shadow: 0 6px 20px rgba(0,0,0,0.2); }\n\
    .aibot-widget-btn.right { right: 24px; }\n\
    .aibot-widget-btn.left { left: 24px; }\n\
    .aibot-widget-panel {\n\
      position: fixed; bottom: 92px; z-index: 99999;\n\
      width: 380px; max-width: calc(100vw - 32px); height: 520px; max-height: calc(100vh - 120px);\n\
      border-radius: 16px;\n\
      display: flex; flex-direction: column;\n\
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);\n\
      overflow: hidden;\n\
      transition: opacity 0.2s, transform 0.2s;\n\
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n\
    }\n\
    .aibot-widget-panel.right { right: 24px; }\n\
    .aibot-widget-panel.left { left: 24px; }\n\
    .aibot-widget-panel.hidden { opacity: 0; transform: translateY(12px); pointer-events: none; }\n\
    .aibot-widget-header {\n\
      padding: 14px 16px; font-size: 15px; font-weight: 600;\n\
      display: flex; align-items: center; justify-content: space-between;\n\
    }\n\
    .aibot-widget-header button {\n\
      background: none; border: none; cursor: pointer; font-size: 18px; padding: 4px; line-height: 1;\n\
    }\n\
    .aibot-widget-messages {\n\
      flex: 1; overflow-y: auto; padding: 12px 16px;\n\
      display: flex; flex-direction: column; gap: 8px;\n\
    }\n\
    .aibot-widget-msg {\n\
      max-width: 85%; padding: 10px 14px; border-radius: 14px;\n\
      font-size: 14px; line-height: 1.45; word-wrap: break-word; white-space: pre-wrap;\n\
    }\n\
    .aibot-widget-msg.user { align-self: flex-end; }\n\
    .aibot-widget-msg.bot { align-self: flex-start; }\n\
    .aibot-widget-msg img {\n\
      max-width: 100%; max-height: 200px; border-radius: 8px; margin-top: 6px; display: block;\n\
    }\n\
    .aibot-widget-typing {\n\
      align-self: flex-start; padding: 10px 14px; border-radius: 14px; font-size: 14px;\n\
    }\n\
    .aibot-widget-typing span {\n\
      display: inline-block; animation: aibot-dot 1.4s infinite;\n\
    }\n\
    .aibot-widget-typing span:nth-child(2) { animation-delay: 0.2s; }\n\
    .aibot-widget-typing span:nth-child(3) { animation-delay: 0.4s; }\n\
    @keyframes aibot-dot { 0%,60%,100% { opacity: 0.3; } 30% { opacity: 1; } }\n\
    .aibot-widget-input-wrap {\n\
      border-top: 1px solid;\n\
    }\n\
    .aibot-widget-img-preview {\n\
      display: flex; gap: 6px; padding: 6px 12px 0; flex-wrap: wrap;\n\
    }\n\
    .aibot-widget-img-preview:empty { display: none; }\n\
    .aibot-widget-img-chip {\n\
      position: relative; display: inline-block;\n\
    }\n\
    .aibot-widget-img-chip img {\n\
      width: 48px; height: 48px; object-fit: cover; border-radius: 6px;\n\
    }\n\
    .aibot-widget-img-chip button {\n\
      position: absolute; top: -4px; right: -4px;\n\
      width: 18px; height: 18px; border-radius: 50%; border: none;\n\
      background: rgba(0,0,0,0.6); color: #fff; font-size: 11px; line-height: 1;\n\
      cursor: pointer; display: flex; align-items: center; justify-content: center;\n\
      padding: 0;\n\
    }\n\
    .aibot-widget-input {\n\
      display: flex; padding: 10px 12px; gap: 8px;\n\
    }\n\
    .aibot-widget-input textarea {\n\
      flex: 1; border: none; outline: none; resize: none;\n\
      font-family: inherit; font-size: 14px; padding: 8px 12px;\n\
      border-radius: 20px; min-height: 20px; max-height: 100px;\n\
    }\n\
    .aibot-widget-input button {\n\
      border: none; cursor: pointer; border-radius: 50%;\n\
      width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;\n\
      font-size: 16px; flex-shrink: 0;\n\
    }\n\
    .aibot-widget-input button:disabled { opacity: 0.5; cursor: default; }\n\
    .aibot-widget-attach-btn {\n\
      background: transparent !important; opacity: 0.6;\n\
    }\n\
    .aibot-widget-attach-btn:hover { opacity: 1; }\n\
    .aibot-widget-status {\n\
      font-size: 11px; text-align: center; padding: 4px;\n\
    }\n\
    /* Light theme */\n\
    .aibot-theme-light .aibot-widget-btn { background: #2563eb; color: #fff; }\n\
    .aibot-theme-light .aibot-widget-panel { background: #fff; border: 1px solid #e5e7eb; }\n\
    .aibot-theme-light .aibot-widget-header { background: #2563eb; color: #fff; }\n\
    .aibot-theme-light .aibot-widget-header button { color: #fff; }\n\
    .aibot-theme-light .aibot-widget-msg.user { background: #2563eb; color: #fff; }\n\
    .aibot-theme-light .aibot-widget-msg.bot { background: #f3f4f6; color: #1f2937; }\n\
    .aibot-theme-light .aibot-widget-typing { background: #f3f4f6; color: #6b7280; }\n\
    .aibot-theme-light .aibot-widget-input-wrap { border-color: #e5e7eb; background: #fff; }\n\
    .aibot-theme-light .aibot-widget-input textarea { background: #f3f4f6; color: #1f2937; }\n\
    .aibot-theme-light .aibot-widget-input button { background: #2563eb; color: #fff; }\n\
    .aibot-theme-light .aibot-widget-status { color: #9ca3af; }\n\
    /* Dark theme */\n\
    .aibot-theme-dark .aibot-widget-btn { background: #6366f1; color: #fff; }\n\
    .aibot-theme-dark .aibot-widget-panel { background: #1e1e2e; border: 1px solid #333; }\n\
    .aibot-theme-dark .aibot-widget-header { background: #6366f1; color: #fff; }\n\
    .aibot-theme-dark .aibot-widget-header button { color: #fff; }\n\
    .aibot-theme-dark .aibot-widget-msg.user { background: #6366f1; color: #fff; }\n\
    .aibot-theme-dark .aibot-widget-msg.bot { background: #2a2a3e; color: #e5e7eb; }\n\
    .aibot-theme-dark .aibot-widget-typing { background: #2a2a3e; color: #9ca3af; }\n\
    .aibot-theme-dark .aibot-widget-input-wrap { border-color: #333; background: #1e1e2e; }\n\
    .aibot-theme-dark .aibot-widget-input textarea { background: #2a2a3e; color: #e5e7eb; }\n\
    .aibot-theme-dark .aibot-widget-input button { background: #6366f1; color: #fff; }\n\
    .aibot-theme-dark .aibot-widget-status { color: #6b7280; }\n\
  ';

  // --- DOM helpers ---
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs)
      for (const k of Object.keys(attrs)) {
        if (k === 'className') e.className = attrs[k];
        else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else e.setAttribute(k, attrs[k]);
      }
    if (children) {
      if (typeof children === 'string') e.textContent = children;
      else if (Array.isArray(children))
        for (const c of children) {
          if (c) e.appendChild(c);
        }
      else e.appendChild(children);
    }
    return e;
  }

  // --- File helpers ---
  function totalAttachments() {
    return pendingImages.length + pendingDocs.length;
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      if (file.size > MAX_FILE_BYTES) {
        reject(new Error(`File exceeds ${MAX_FILE_BYTES / 1024 / 1024}MB limit`));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const base64 = dataUrl.split(',')[1];
        resolve({ base64, dataUrl });
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
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

  function addPendingImage(imgData) {
    if (totalAttachments() >= MAX_ATTACHMENTS) return;
    pendingImages.push(imgData);
    renderImagePreviews();
  }

  function removePendingImage(index) {
    pendingImages.splice(index, 1);
    renderImagePreviews();
  }

  function addPendingDoc(docData) {
    if (totalAttachments() >= MAX_ATTACHMENTS) return;
    pendingDocs.push(docData);
    renderDocPreviews();
  }

  function removePendingDoc(index) {
    pendingDocs.splice(index, 1);
    renderDocPreviews();
  }

  function renderImagePreviews() {
    const previewArea = container._imgPreview;
    if (!previewArea) return;
    previewArea.innerHTML = '';
    pendingImages.forEach((img, i) => {
      const chip = el('div', { className: 'aibot-widget-img-chip' }, [
        el('img', { src: img.dataUrl }),
        el('button', { onClick: () => removePendingImage(i) }, '\u2715'),
      ]);
      previewArea.appendChild(chip);
    });
  }

  function renderDocPreviews() {
    const previewArea = container._docPreview;
    if (!previewArea) return;
    previewArea.innerHTML = '';
    pendingDocs.forEach((doc, i) => {
      const chip = el(
        'div',
        {
          className: 'aibot-widget-img-chip',
          style:
            'display:flex;align-items:center;gap:4px;padding:4px 8px;background:rgba(0,0,0,0.05);border-radius:8px;font-size:12px',
        },
        [
          document.createTextNode(`\uD83D\uDCC4 ${doc.name}`),
          el('button', { onClick: () => removePendingDoc(i) }, '\u2715'),
        ]
      );
      previewArea.appendChild(chip);
    });
  }

  async function handleFiles(files) {
    for (const file of files) {
      if (totalAttachments() >= MAX_ATTACHMENTS) break;
      if (file.size > MAX_FILE_BYTES) {
        console.warn('[AIBotWidget] File too large:', file.name);
        continue;
      }

      if (file.type.startsWith('image/')) {
        try {
          const imgData = await readFileAsBase64(file);
          addPendingImage(imgData);
        } catch (err) {
          console.warn('[AIBotWidget]', err.message);
        }
      } else if (
        ALLOWED_DOC_TYPES.includes(file.type) ||
        file.name.match(/\.(txt|md|csv|json|html|htm|pdf)$/i)
      ) {
        const mimeType = file.type || guessMimeType(file.name);
        try {
          if (mimeType === 'application/pdf') {
            const buffer = await file.arrayBuffer();
            const base64 = btoa(
              new Uint8Array(buffer).reduce((s, b) => s + String.fromCharCode(b), '')
            );
            addPendingDoc({ name: file.name, mimeType, content: base64 });
          } else {
            const text = await file.text();
            addPendingDoc({ name: file.name, mimeType, content: text });
          }
        } catch (err) {
          console.warn('[AIBotWidget]', err.message);
        }
      }
    }
  }

  // --- Widget ---
  function init(opts) {
    config = Object.assign({}, defaults, opts || {});
    if (!config.botId) {
      console.error('[AIBotWidget] Missing botId');
      return;
    }

    // Persist chatId/senderId in localStorage for session continuity
    const storageKey = `aibot_widget_${config.botId}`;
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
    } catch {}

    chatId =
      config.chatId ||
      stored.chatId ||
      `widget-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (!config.senderId) {
      config.senderId = stored.senderId || `widget-user-${Math.random().toString(36).slice(2, 8)}`;
    }

    try {
      localStorage.setItem(storageKey, JSON.stringify({ chatId, senderId: config.senderId }));
    } catch {}

    // Inject styles
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);

    // Create container
    const themeClass = `aibot-theme-${config.theme || 'light'}`;
    container = el('div', { className: themeClass });
    document.body.appendChild(container);

    // FAB button
    const fab = el(
      'button',
      {
        className: `aibot-widget-btn ${config.position}`,
        onClick: togglePanel,
        'aria-label': 'Open chat',
      },
      '\uD83D\uDCAC'
    );
    container.appendChild(fab);

    // Panel
    const panel = el('div', { className: `aibot-widget-panel hidden ${config.position}` });
    const header = el('div', { className: 'aibot-widget-header' }, [
      el('span', null, config.title),
      el('button', { onClick: togglePanel, 'aria-label': 'Close chat' }, '\u2715'),
    ]);
    const messages = el('div', { className: 'aibot-widget-messages' });
    const status = el('div', { className: 'aibot-widget-status' }, 'Connecting...');

    // File input (hidden)
    const fileInput = el('input', {
      type: 'file',
      accept: 'image/*,.pdf,.txt,.md,.csv,.json,.html,.htm',
      multiple: 'true',
      style: 'display:none',
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) handleFiles(fileInput.files);
      fileInput.value = '';
    });

    const textarea = el('textarea', { rows: '1', placeholder: 'Type a message...' });
    const attachBtn = el(
      'button',
      {
        className: 'aibot-widget-attach-btn',
        onClick: () => fileInput.click(),
        'aria-label': 'Attach file',
      },
      '\uD83D\uDCCE'
    );
    const sendBtn = el('button', { disabled: 'true', onClick: sendMessage }, '\u27A4');
    const imgPreview = el('div', { className: 'aibot-widget-img-preview' });
    const docPreview = el('div', { className: 'aibot-widget-img-preview' });
    const inputWrap = el('div', { className: 'aibot-widget-input-wrap' }, [
      imgPreview,
      docPreview,
      el('div', { className: 'aibot-widget-input' }, [attachBtn, textarea, sendBtn]),
    ]);

    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(status);
    panel.appendChild(inputWrap);
    panel.appendChild(fileInput);
    container.appendChild(panel);

    // Store refs
    container._panel = panel;
    container._fab = fab;
    container._messages = messages;
    container._status = status;
    container._textarea = textarea;
    container._sendBtn = sendBtn;
    container._imgPreview = imgPreview;
    container._docPreview = docPreview;
    container._typing = null;

    // Textarea auto-resize + enter to send
    textarea.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = `${Math.min(this.scrollHeight, 100)}px`;
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Paste support (images and files)
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
        handleFiles(pasteFiles);
      }
    });

    // Drag & drop support on the messages area
    messages.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    messages.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [];
      for (const item of e.dataTransfer.items || []) {
        if (item.kind === 'file') {
          files.push(item.getAsFile());
        }
      }
      if (files.length > 0) handleFiles(files);
    });

    connect();
    window.AIBotWidget._initialized = true;
  }

  function togglePanel() {
    isOpen = !isOpen;
    container._panel.classList.toggle('hidden', !isOpen);
    if (isOpen) {
      container._textarea.focus();
      scrollToBottom();
    }
  }

  function connect() {
    const serverUrl = config.server.replace(/^http/, 'ws');
    let params = `botId=${encodeURIComponent(config.botId)}&chatId=${encodeURIComponent(chatId)}&senderId=${encodeURIComponent(config.senderId)}`;
    if (config.senderName) params += `&senderName=${encodeURIComponent(config.senderName)}`;
    if (config.token) params += `&token=${encodeURIComponent(config.token)}`;
    if (config.userHash) params += `&userHash=${encodeURIComponent(config.userHash)}`;

    ws = new WebSocket(`${serverUrl}/ws/chat?${params}`);

    ws.onopen = () => {
      setStatus('Connected');
      container._sendBtn.disabled = false;
      // Fetch history on first connect (not on every reconnect)
      if (!container._historyLoaded) {
        fetchHistory();
      }
    };

    ws.onmessage = (evt) => {
      let data;
      try {
        data = JSON.parse(evt.data);
      } catch {
        return;
      }

      if (data.type === 'message' && data.role === 'bot') {
        removeTyping();
        if (data.approval) {
          addApprovalMessage(data.content, data.approval);
        } else {
          addMessage('bot', data.content);
        }
      } else if (data.type === 'approval_result') {
        addMessage('bot', data.content);
      } else if (data.type === 'typing') {
        showTyping();
      } else if (data.type === 'error') {
        removeTyping();
        addMessage('bot', data.error || 'An error occurred.');
      } else if (data.type === 'connected') {
        setStatus('Connected');
      }
    };

    ws.onclose = () => {
      setStatus('Disconnected');
      container._sendBtn.disabled = true;
      // Auto-reconnect after 3s
      setTimeout(() => {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
          setStatus('Reconnecting...');
          connect();
        }
      }, 3000);
    };

    ws.onerror = () => {
      setStatus('Connection error');
    };
  }

  function fetchHistory() {
    const proto = config.server.replace(/^ws/, 'http');
    let url = `${proto}/api/v1/chat/${encodeURIComponent(config.botId)}/history?chatId=${encodeURIComponent(chatId)}&senderId=${encodeURIComponent(config.senderId)}&limit=50`;
    if (config.token) url += `&token=${encodeURIComponent(config.token)}`;

    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.messages && data.messages.length > 0) {
          // Clear any existing messages and render history
          container._messages.innerHTML = '';
          for (const msg of data.messages) {
            addMessage(msg.role === 'bot' ? 'bot' : 'user', msg.content);
          }
          container._historyLoaded = true;
        }
      })
      .catch(() => {
        /* ignore history fetch errors */
      });
  }

  function sendMessage() {
    const text = container._textarea.value.trim();
    const images = pendingImages.map((img) => img.base64);
    const docs = pendingDocs.map((d) => ({
      name: d.name,
      mimeType: d.mimeType,
      content: d.content,
    }));
    if (
      (!text && images.length === 0 && docs.length === 0) ||
      !ws ||
      ws.readyState !== WebSocket.OPEN
    )
      return;

    const displayText = text || (docs.length > 0 ? '(document attached)' : '(image)');
    addMessage(
      'user',
      displayText,
      pendingImages.map((img) => img.dataUrl)
    );

    const payload = { type: 'message', message: displayText };
    if (images.length > 0) payload.images = images;
    if (docs.length > 0) payload.documents = docs;
    ws.send(JSON.stringify(payload));

    container._textarea.value = '';
    container._textarea.style.height = 'auto';
    pendingImages = [];
    pendingDocs = [];
    renderImagePreviews();
    renderDocPreviews();
  }

  function addMessage(role, content, imageDataUrls) {
    const msg = el('div', { className: `aibot-widget-msg ${role}` });
    if (content) {
      const textNode = document.createTextNode(content);
      msg.appendChild(textNode);
    }
    if (imageDataUrls && imageDataUrls.length > 0) {
      for (const dataUrl of imageDataUrls) {
        const img = el('img', { src: dataUrl });
        msg.appendChild(img);
      }
    }
    container._messages.appendChild(msg);
    scrollToBottom();
  }

  function addApprovalMessage(content, approval) {
    const msg = el('div', { className: 'aibot-widget-msg bot' });
    if (content) {
      msg.appendChild(document.createTextNode(content));
    }
    const card = el('div', {
      className: 'aibot-widget-approval',
      style:
        'border-left:3px solid #6366f1;background:rgba(99,102,241,0.08);padding:10px;border-radius:6px;margin-top:8px;font-size:13px',
    });
    card.appendChild(
      el('div', { style: 'font-weight:600;margin-bottom:4px' }, 'Tool Permission Request')
    );
    card.appendChild(
      el('div', { style: 'font-family:monospace;color:#6366f1' }, approval.toolName)
    );
    card.appendChild(
      el('div', { style: 'opacity:0.7;font-size:12px;margin:4px 0 8px' }, approval.description)
    );

    const actions = el('div', { style: 'display:flex;gap:8px' });
    const approveBtn = el(
      'button',
      {
        style:
          'padding:4px 14px;border:none;border-radius:6px;background:#22c55e;color:#fff;cursor:pointer;font-size:13px',
        onClick: () => {
          approveBtn.disabled = true;
          denyBtn.disabled = true;
          ws.send(JSON.stringify({ type: 'approval_response', action: 'approve' }));
          card.style.opacity = '0.6';
          card.querySelector('div:last-child').innerHTML =
            '<span style="color:#22c55e">Approved</span>';
        },
      },
      'Approve'
    );
    const denyBtn = el(
      'button',
      {
        style:
          'padding:4px 14px;border:none;border-radius:6px;background:#ef4444;color:#fff;cursor:pointer;font-size:13px',
        onClick: () => {
          approveBtn.disabled = true;
          denyBtn.disabled = true;
          ws.send(JSON.stringify({ type: 'approval_response', action: 'deny' }));
          card.style.opacity = '0.6';
          card.querySelector('div:last-child').innerHTML =
            '<span style="color:#ef4444">Denied</span>';
        },
      },
      'Deny'
    );
    actions.appendChild(approveBtn);
    actions.appendChild(denyBtn);
    card.appendChild(actions);

    msg.appendChild(card);
    container._messages.appendChild(msg);
    scrollToBottom();
  }

  function showTyping() {
    if (container._typing) return;
    const dots = el('div', { className: 'aibot-widget-typing' }, [
      el('span', null, '\u2022'),
      el('span', null, '\u2022'),
      el('span', null, '\u2022'),
    ]);
    container._typing = dots;
    container._messages.appendChild(dots);
    scrollToBottom();
  }

  function removeTyping() {
    if (container._typing) {
      container._typing.remove();
      container._typing = null;
    }
  }

  function setStatus(text) {
    if (container?._status) {
      container._status.textContent = text;
    }
  }

  function scrollToBottom() {
    const m = container._messages;
    setTimeout(() => {
      m.scrollTop = m.scrollHeight;
    }, 50);
  }

  // --- Public API ---
  window.AIBotWidget = {
    init: init,
    open: () => {
      if (!isOpen) togglePanel();
    },
    close: () => {
      if (isOpen) togglePanel();
    },
    version: WIDGET_VERSION,
    _initialized: false,
  };

  // Auto-init if script tag has data-bot-id
  if (defaults.botId) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        init();
      });
    } else {
      init();
    }
  }
})();
