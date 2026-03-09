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
  };

  let config = {};
  let ws = null;
  let chatId = null;
  let isOpen = false;
  let container = null;

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
    .aibot-widget-typing {\n\
      align-self: flex-start; padding: 10px 14px; border-radius: 14px; font-size: 14px;\n\
    }\n\
    .aibot-widget-typing span {\n\
      display: inline-block; animation: aibot-dot 1.4s infinite;\n\
    }\n\
    .aibot-widget-typing span:nth-child(2) { animation-delay: 0.2s; }\n\
    .aibot-widget-typing span:nth-child(3) { animation-delay: 0.4s; }\n\
    @keyframes aibot-dot { 0%,60%,100% { opacity: 0.3; } 30% { opacity: 1; } }\n\
    .aibot-widget-input {\n\
      display: flex; padding: 10px 12px; gap: 8px;\n\
      border-top: 1px solid;\n\
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
    .aibot-theme-light .aibot-widget-input { border-color: #e5e7eb; background: #fff; }\n\
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
    .aibot-theme-dark .aibot-widget-input { border-color: #333; background: #1e1e2e; }\n\
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

  // --- Widget ---
  function init(opts) {
    config = Object.assign({}, defaults, opts || {});
    if (!config.botId) {
      console.error('[AIBotWidget] Missing botId');
      return;
    }

    chatId = config.chatId || `widget-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (!config.senderId) {
      config.senderId = `widget-user-${Math.random().toString(36).slice(2, 8)}`;
    }

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
    const textarea = el('textarea', { rows: '1', placeholder: 'Type a message...' });
    const sendBtn = el('button', { disabled: 'true', onClick: sendMessage }, '\u27A4');
    const inputBar = el('div', { className: 'aibot-widget-input' }, [textarea, sendBtn]);

    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(status);
    panel.appendChild(inputBar);
    container.appendChild(panel);

    // Store refs
    container._panel = panel;
    container._fab = fab;
    container._messages = messages;
    container._status = status;
    container._textarea = textarea;
    container._sendBtn = sendBtn;
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

    ws = new WebSocket(`${serverUrl}/ws/chat?${params}`);

    ws.onopen = () => {
      setStatus('Connected');
      container._sendBtn.disabled = false;
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

  function sendMessage() {
    const text = container._textarea.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    addMessage('user', text);
    ws.send(JSON.stringify({ type: 'message', message: text }));
    container._textarea.value = '';
    container._textarea.style.height = 'auto';
  }

  function addMessage(role, content) {
    const msg = el('div', { className: `aibot-widget-msg ${role}` }, content);
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
