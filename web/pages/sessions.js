import { confirmDialog, emptyState, showToast } from '../ui/index.js';
import {
  TRANSCRIPT_PAGE,
  earlierWindow,
  latestWindow,
  normalizeSessionList,
  parseSessionKey,
  transcriptText,
} from './sessions-helpers.js';
import { api, escapeHtml, timeAgo } from './shared.js';

const sessionHref = (key) => `#/work/sessions/${encodeURIComponent(key)}`;

export async function renderSessions(el) {
  el.innerHTML = '<div class="page-title">Sessions</div><p class="text-dim">Loading...</p>';

  const res = await api('/api/sessions').catch((err) => ({ error: err?.message }));
  const { error, sessions } = normalizeSessionList(res);
  if (error) {
    el.innerHTML = `<div class="page-title">Sessions</div>${emptyState({
      icon: '∅',
      title: 'Could not load sessions',
      hint: error,
    })}`;
    return;
  }

  el.innerHTML = `
    <div class="page-title">Sessions <span class="count">${sessions.length}</span></div>
    ${
      sessions.length === 0
        ? '<p class="text-dim">No sessions yet.</p>'
        : `<table>
          <thead><tr><th>Session</th><th>Messages</th><th>Last Activity</th><th>Actions</th></tr></thead>
          <tbody id="sessions-tbody"></tbody>
        </table>`
    }
  `;

  if (sessions.length === 0) return;

  const tbody = document.getElementById('sessions-tbody');
  for (const s of sessions) {
    const parsed = parseSessionKey(s.key);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <a href="${sessionHref(s.key)}">${escapeHtml(parsed.label)}</a>
        <div class="text-dim text-sm">${escapeHtml(s.key)}</div>
      </td>
      <td>${Number(s.messageCount) || 0}</td>
      <td class="text-dim">${timeAgo(s.lastActivityAt)}</td>
      <td class="actions">
        <a href="${sessionHref(s.key)}" class="btn btn-sm">View</a>
        <button class="btn btn-sm btn-danger" data-action="clear" data-key="${escapeHtml(s.key)}">Clear</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action="clear"]');
    if (!btn) return;
    const key = btn.dataset.key;
    const ok = await confirmDialog({
      title: 'Clear session',
      message: `Clear "${parseSessionKey(key).label}"? The transcript will be deleted.`,
      confirmLabel: 'Clear session',
      tone: 'danger',
    });
    if (!ok) return;
    const r = await api(`/api/sessions/${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (r?.error) {
      showToast(`Could not clear: ${r.error}`, { tone: 'danger' });
      return;
    }
    showToast('Session cleared', { tone: 'ok' });
    renderSessions(el);
  });
}

function bubble(msg) {
  const div = document.createElement('div');
  const role = msg.role || 'system';
  div.className = `bubble bubble-${role}`;
  const content = transcriptText(msg);
  if (role !== 'system') {
    div.innerHTML = `<div class="bubble-role">${escapeHtml(role)}</div>${escapeHtml(content)}`;
  } else {
    div.textContent = content;
  }
  return div;
}

const transcriptUrl = (key, offset, limit) =>
  `/api/sessions/${encodeURIComponent(key)}/transcript?limit=${limit}&offset=${offset}`;

export async function renderSessionTranscript(el, key) {
  el.innerHTML = '<div class="page-title">Transcript</div><p class="text-dim">Loading...</p>';

  // The API pages oldest-first; open on the newest page.
  let data = await api(transcriptUrl(key, 0, TRANSCRIPT_PAGE)).catch((err) => ({
    error: err?.message,
  }));
  if (!data?.error && data.total > TRANSCRIPT_PAGE) {
    data = await api(transcriptUrl(key, latestWindow(data.total), TRANSCRIPT_PAGE)).catch(
      (err) => ({ error: err?.message })
    );
  }
  if (!data || data.error) {
    el.innerHTML = `<div class="detail-header"><a href="#/work/sessions" class="back">&larr;</a><div class="page-title">Transcript</div></div>${emptyState(
      { icon: '∅', title: 'Session not found', hint: data?.error || '' }
    )}`;
    return;
  }

  const parsed = parseSessionKey(key);
  let start = Number(data.offset) || 0;

  el.innerHTML = `
    <div class="detail-header">
      <a href="#/work/sessions" class="back">&larr;</a>
      <div class="page-title">${escapeHtml(parsed.label)}</div>
      <span class="count">${Number(data.total) || 0} messages</span>
    </div>
    <div class="transcript" id="transcript"></div>
  `;

  const container = document.getElementById('transcript');
  const more = document.createElement('button');
  more.className = 'btn btn-sm transcript-load-more';
  const syncMore = () => {
    more.hidden = start <= 0;
    more.textContent = `Load earlier messages (${start} more)`;
  };
  container.appendChild(more);
  for (const msg of data.messages ?? []) container.appendChild(bubble(msg));
  syncMore();

  more.addEventListener('click', async () => {
    const win = earlierWindow(start);
    if (!win) return;
    more.disabled = true;
    const page = await api(transcriptUrl(key, win.offset, win.limit)).catch((err) => ({
      error: err?.message,
    }));
    more.disabled = false;
    if (!page || page.error) {
      showToast(`Could not load more: ${page?.error || 'no answer'}`, { tone: 'danger' });
      return;
    }
    const prevHeight = container.scrollHeight;
    const frag = document.createDocumentFragment();
    for (const msg of page.messages ?? []) frag.appendChild(bubble(msg));
    more.after(frag);
    start = win.offset;
    syncMore();
    // Keep the reader where they were.
    container.scrollTop += container.scrollHeight - prevHeight;
  });

  container.scrollTop = container.scrollHeight;
}
