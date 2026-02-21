import { api, escapeHtml, timeAgo } from './shared.js';

let refreshTimer = null;

function formatRemaining(ms) {
  if (ms <= 0) return 'Expired';
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s left`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s left`;
  return `${Math.floor(ms / 3600_000)}h ${Math.floor((ms % 3600_000) / 60_000)}m left`;
}

function timeoutPercent(createdAt, timeoutMs, remainingMs) {
  const elapsed = Date.now() - createdAt;
  const pct = Math.max(0, Math.min(100, (1 - elapsed / timeoutMs) * 100));
  return pct;
}

function renderQuestionCard(q) {
  const pct = timeoutPercent(q.createdAt, q.timeoutMs, q.remainingMs);
  return `<div class="inbox-card" data-id="${escapeHtml(q.id)}">
    <div class="inbox-card-header">
      <span class="inbox-card-bot">${escapeHtml(q.botName)}</span>
      <span class="inbox-card-time">${formatRemaining(q.remainingMs)}</span>
    </div>
    <div class="timeout-bar"><div class="timeout-bar-fill" style="width:${pct}%"></div></div>
    <div class="inbox-card-question">${escapeHtml(q.question)}</div>
    <div class="inbox-answer-form">
      <input type="text" class="inbox-answer-input" placeholder="Type your answer..." />
      <button class="btn btn-primary btn-send">Send</button>
      <button class="btn btn-dismiss">Dismiss</button>
    </div>
  </div>`;
}

async function render(el) {
  const data = await api('/api/ask-human');
  if (data.error) {
    el.innerHTML = `<div class="page-title">Inbox</div><p class="text-dim">Failed to load: ${escapeHtml(data.error)}</p>`;
    return;
  }

  const { questions } = data;

  const questionsHtml = questions.length > 0
    ? questions.map(renderQuestionCard).join('')
    : '<p class="text-dim text-sm">No pending questions</p>';

  el.innerHTML = `
    <div class="page-title">Inbox <span class="count">${data.totalCount} pending</span></div>

    <div style="font-weight:600;font-size:15px;margin-bottom:12px">Pending Questions</div>
    <div id="inbox-questions">${questionsHtml}</div>
  `;

  // Attach send + dismiss handlers
  el.querySelectorAll('.inbox-card').forEach((card) => {
    const id = card.dataset.id;
    const input = card.querySelector('.inbox-answer-input');
    const btnSend = card.querySelector('.btn-send');
    const btnDismiss = card.querySelector('.btn-dismiss');
    if (!input || !btnSend) return;

    async function submit() {
      const answer = input.value.trim();
      if (!answer) return;
      btnSend.disabled = true;
      btnSend.textContent = 'Sending...';
      const res = await api(`/api/ask-human/${encodeURIComponent(id)}/answer`, {
        method: 'POST',
        body: { answer },
      });
      if (res.ok) {
        render(el);
      } else {
        btnSend.disabled = false;
        btnSend.textContent = 'Send';
        input.style.borderColor = 'var(--red)';
      }
    }

    btnSend.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });

    if (btnDismiss) {
      btnDismiss.addEventListener('click', async () => {
        btnDismiss.disabled = true;
        btnDismiss.textContent = 'Dismissing...';
        const res = await api(`/api/ask-human/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          render(el);
        } else {
          btnDismiss.disabled = false;
          btnDismiss.textContent = 'Dismiss';
        }
      });
    }
  });
}

export async function renderInbox(el) {
  await render(el);
  refreshTimer = setInterval(() => render(el), 15_000);
}

export function destroyInbox() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
