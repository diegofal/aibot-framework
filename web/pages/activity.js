import { escapeHtml } from './shared.js';

const MAX_DOM_EVENTS = 500;

const TYPE_COLORS = {
  'tool:start': '#6c8cff',
  'tool:end': '#34d399',
  'tool:error': '#f87171',
  'llm:start': '#a78bfa',
  'llm:end': '#818cf8',
  'agent:phase': '#fbbf24',
  'agent:idle': '#8b8d97',
  'agent:result': '#34d399',
  'memory:flush': '#f472b6',
  'memory:rag': '#fb923c',
  'collab:start': '#22d3ee',
  'collab:end': '#06b6d4',
};

let ws = null;
let paused = false;
let pauseBuffer = [];
let autoScroll = true;
let container = null;
let countBadge = null;
let activeBot = '';
let activeType = '';

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function matchesFilter(event) {
  if (activeBot && event.botId !== activeBot) return false;
  if (activeType && event.type !== activeType) return false;
  return true;
}

function formatData(data) {
  if (!data || Object.keys(data).length === 0) return '';
  const parts = [];
  for (const [k, v] of Object.entries(data)) {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    const truncated = val.length > 120 ? val.slice(0, 120) + '...' : val;
    parts.push(`<span class="activity-prop"><span class="activity-prop-key">${escapeHtml(k)}</span>=${escapeHtml(truncated)}</span>`);
  }
  return parts.join(' ');
}

function createEventEl(event) {
  const div = document.createElement('div');
  div.className = 'activity-event';
  if (event.botId) div.dataset.botid = event.botId;
  div.dataset.type = event.type;

  const color = TYPE_COLORS[event.type] || '#8b8d97';
  const phaseLabel = event.phase ? ` <span class="activity-phase">${escapeHtml(event.phase)}</span>` : '';

  div.innerHTML =
    `<span class="activity-time">${formatTime(event.timestamp)}</span>` +
    `<span class="activity-type-badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${escapeHtml(event.type)}</span>` +
    (event.botId ? `<span class="activity-bot-tag">${escapeHtml(event.botId)}</span>` : '') +
    phaseLabel +
    `<span class="activity-data">${formatData(event.data)}</span>`;

  // Expandable detail on click
  div.addEventListener('click', () => {
    const existing = div.querySelector('.activity-detail');
    if (existing) {
      existing.remove();
      return;
    }
    const detail = document.createElement('pre');
    detail.className = 'activity-detail';
    detail.textContent = JSON.stringify(event, null, 2);
    div.appendChild(detail);
  });

  return div;
}

function appendEvents(events) {
  if (!container) return;
  for (const event of events) {
    if (!matchesFilter(event)) continue;
    container.appendChild(createEventEl(event));
  }
  while (container.children.length > MAX_DOM_EVENTS) {
    container.removeChild(container.firstChild);
  }
  updateCount();
  if (autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function updateCount() {
  if (countBadge) countBadge.textContent = container ? container.children.length : 0;
}

function refilterAll() {
  if (!container) return;
  for (const child of container.children) {
    let visible = true;
    if (activeBot) {
      visible = (child.dataset.botid || '') === activeBot;
    }
    if (visible && activeType) {
      visible = (child.dataset.type || '') === activeType;
    }
    child.style.display = visible ? '' : 'none';
  }
  updateCount();
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/activity`);

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'history') {
        appendEvents(data.events || []);
      } else if (data.type === 'activity') {
        const events = [data.event];
        if (paused) {
          pauseBuffer.push(...events);
        } else {
          appendEvents(events);
        }
      }
    } catch { /* ignore */ }
  };

  ws.onclose = () => {
    if (container) setTimeout(connectWS, 2000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

export async function renderActivity(el) {
  paused = false;
  pauseBuffer = [];
  autoScroll = true;
  activeBot = '';
  activeType = '';

  // Fetch agents for filter
  let agents = [];
  try {
    const res = await fetch('/api/agents');
    agents = await res.json();
  } catch { /* ignore */ }

  const agentOptions = agents.map(
    (a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} (${escapeHtml(a.id)})</option>`
  ).join('');

  const typeOptions = Object.keys(TYPE_COLORS).map(
    (t) => `<option value="${t}">${t}</option>`
  ).join('');

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Activity <span class="count" id="activity-count">0</span></div>
      <div class="actions">
        <button class="btn btn-sm" id="activity-pause">Pause</button>
        <button class="btn btn-sm" id="activity-clear">Clear</button>
      </div>
    </div>
    <div class="activity-toolbar">
      <select class="activity-filter" id="activity-bot-filter">
        <option value="">All Agents</option>
        ${agentOptions}
      </select>
      <select class="activity-filter" id="activity-type-filter">
        <option value="">All Types</option>
        ${typeOptions}
      </select>
    </div>
    <div class="activity-container" id="activity-container"></div>
  `;

  container = document.getElementById('activity-container');
  countBadge = document.getElementById('activity-count');

  // Pause/resume
  const pauseBtn = document.getElementById('activity-pause');
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('btn-primary', paused);
    if (!paused && pauseBuffer.length > 0) {
      appendEvents(pauseBuffer);
      pauseBuffer = [];
    }
  });

  // Clear
  document.getElementById('activity-clear').addEventListener('click', () => {
    container.innerHTML = '';
    updateCount();
  });

  // Bot filter
  document.getElementById('activity-bot-filter').addEventListener('change', (e) => {
    activeBot = e.target.value;
    refilterAll();
  });

  // Type filter
  document.getElementById('activity-type-filter').addEventListener('change', (e) => {
    activeType = e.target.value;
    refilterAll();
  });

  // Auto-scroll detection
  container.addEventListener('scroll', () => {
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
    autoScroll = atBottom;
  });

  connectWS();
}

export function destroyActivity() {
  if (ws) {
    const ref = ws;
    ws = null;
    ref.onclose = null;
    ref.close();
  }
  container = null;
  countBadge = null;
  pauseBuffer = [];
}
