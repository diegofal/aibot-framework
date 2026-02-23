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

export async function api(url, opts = {}) {
  const fetchOpts = { headers: {} };
  if (opts.method) fetchOpts.method = opts.method;
  if (opts.body) {
    fetchOpts.headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(opts.body);
  }
  try {
    const res = await fetch(url, fetchOpts);
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
 * Render a chat-like thread component into a container.
 * @param {HTMLElement} container - Target element
 * @param {object} opts
 * @param {Array} opts.thread - ThreadMessage[] from the API
 * @param {string} [opts.legacyFeedback] - Legacy feedback/content field (first human message)
 * @param {string} [opts.legacyResponse] - Legacy aiResponse/response field (first bot message)
 * @param {function} opts.onSend - Callback when user sends a message
 * @param {boolean} opts.generating - Whether bot is currently generating a reply
 */
export function renderThread(container, opts) {
  const { thread = [], legacyFeedback, legacyResponse, onSend, generating } = opts;

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
    html += '<div class="text-dim text-sm" style="padding:8px 0">No messages yet. Start the discussion below.</div>';
  } else {
    for (const msg of messages) {
      const bubbleClass = msg.role === 'human' ? 'bubble-user' : 'bubble-assistant';
      const roleLabel = msg.role === 'human' ? 'You' : 'Bot';
      const timeStr = msg.createdAt ? `<span class="text-dim text-sm" style="margin-left:8px">${timeAgo(msg.createdAt)}</span>` : '';
      html += `
        <div class="bubble ${bubbleClass}">
          <div class="bubble-role">${roleLabel}${timeStr}</div>
          ${escapeHtml(msg.content)}
        </div>`;
    }
  }

  if (generating) {
    html += '<div class="thread-typing"><span class="bubble-role">Bot</span> is thinking...</div>';
  }

  html += '</div>';

  // Input area
  html += `
    <div class="thread-input-area">
      <textarea class="thread-input" rows="2" placeholder="Type a message..."></textarea>
      <button class="btn btn-primary btn-sm thread-send-btn"${generating ? ' disabled' : ''}>Send</button>
    </div>`;

  container.innerHTML = html;

  // Scroll to bottom of thread messages
  const messagesEl = container.querySelector('.thread-messages');
  if (messagesEl) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Wire send button + Enter key
  const textarea = container.querySelector('.thread-input');
  const sendBtn = container.querySelector('.thread-send-btn');

  function doSend() {
    const text = textarea.value.trim();
    if (!text || generating) return;
    textarea.value = '';
    if (onSend) onSend(text);
  }

  sendBtn.addEventListener('click', doSend);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });
}
