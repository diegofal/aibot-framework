import { escapeHtml } from './shared.js';

/* ── Constants ─────────────────────────────────────────────── */

const MAX_DOM_EVENTS = 500;
const MAX_DOM_LINES = 2000;

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
  'karma:change': '#eab308',
};

const LEVEL_MAP = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const LEVEL_LABELS = {
  trace: 'TRC',
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
  fatal: 'FTL',
};

/* ── Shared state ──────────────────────────────────────────── */

// Events tab state
let evWs = null;
let evPaused = false;
let evPauseBuffer = [];
let evAutoScroll = true;
let evContainer = null;
let evActiveBot = '';
let evActiveType = '';

// Logs tab state
let logWs = null;
let logPaused = false;
let logPauseBuffer = [];
let logAutoScroll = true;
let logContainer = null;
let logActiveLevels = new Set(['debug', 'info', 'warn', 'error', 'fatal', 'trace']);
let logSearchTerm = '';
let logActiveAgent = '';

// Shared
let countBadge = null;
let activeTab = 'events'; // 'events' | 'logs'

/* ── Shared helpers ────────────────────────────────────────── */

function formatTime(ts) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function updateCount() {
  if (!countBadge) return;
  const c = activeTab === 'events' ? evContainer : logContainer;
  countBadge.textContent = c ? c.children.length : 0;
}

/* ── Events tab ────────────────────────────────────────────── */

function evMatchesFilter(event) {
  if (evActiveBot && event.botId !== evActiveBot) return false;
  if (evActiveType && event.type !== evActiveType) return false;
  return true;
}

function formatData(data) {
  if (!data || Object.keys(data).length === 0) return '';
  const parts = [];
  for (const [k, v] of Object.entries(data)) {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    const truncated = val.length > 120 ? `${val.slice(0, 120)}...` : val;
    parts.push(
      `<span class="activity-prop"><span class="activity-prop-key">${escapeHtml(k)}</span>=${escapeHtml(truncated)}</span>`
    );
  }
  return parts.join(' ');
}

function createEventEl(event) {
  const div = document.createElement('div');
  div.className = 'activity-event';
  if (event.botId) div.dataset.botid = event.botId;
  div.dataset.type = event.type;

  const color = TYPE_COLORS[event.type] || '#8b8d97';
  const phaseLabel = event.phase
    ? ` <span class="activity-phase">${escapeHtml(event.phase)}</span>`
    : '';

  div.innerHTML = `<span class="activity-time">${formatTime(event.timestamp)}</span><span class="activity-type-badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${escapeHtml(event.type)}</span>${event.botId ? `<span class="activity-bot-tag">${escapeHtml(event.botId)}</span>` : ''}${phaseLabel}<span class="activity-data">${formatData(event.data)}</span>`;

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

function evAppendEvents(events) {
  if (!evContainer) return;
  for (const event of events) {
    if (!evMatchesFilter(event)) continue;
    evContainer.appendChild(createEventEl(event));
  }
  while (evContainer.children.length > MAX_DOM_EVENTS) {
    evContainer.removeChild(evContainer.firstChild);
  }
  if (activeTab === 'events') updateCount();
  if (evAutoScroll) {
    evContainer.scrollTop = evContainer.scrollHeight;
  }
}

function evRefilterAll() {
  if (!evContainer) return;
  for (const child of evContainer.children) {
    let visible = true;
    if (evActiveBot) {
      visible = (child.dataset.botid || '') === evActiveBot;
    }
    if (visible && evActiveType) {
      visible = (child.dataset.type || '') === evActiveType;
    }
    child.style.display = visible ? '' : 'none';
  }
  if (activeTab === 'events') updateCount();
}

function evConnectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  evWs = new WebSocket(`${proto}//${location.host}/ws/activity`);

  evWs.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'history') {
        evAppendEvents(data.events || []);
      } else if (data.type === 'activity') {
        const events = [data.event];
        if (evPaused) {
          evPauseBuffer.push(...events);
        } else {
          evAppendEvents(events);
        }
      }
    } catch {
      /* ignore */
    }
  };

  evWs.onclose = () => {
    if (evContainer) setTimeout(evConnectWS, 2000);
  };

  evWs.onerror = () => {
    evWs.close();
  };
}

/* ── Logs tab ──────────────────────────────────────────────── */

function levelName(num) {
  return LEVEL_MAP[num] || 'info';
}

function logMatchesFilter(entry) {
  const lvl = levelName(entry.level);
  if (!logActiveLevels.has(lvl)) return false;
  if (logActiveAgent && (entry.botId || '') !== logActiveAgent) return false;
  if (logSearchTerm) {
    const text = `${entry.msg || ''} ${JSON.stringify(entry)}`;
    if (!text.toLowerCase().includes(logSearchTerm)) return false;
  }
  return true;
}

function logExtraProps(entry) {
  const skip = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'botId']);
  const parts = [];
  for (const [k, v] of Object.entries(entry)) {
    if (skip.has(k)) continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(
      `<span class="log-prop"><span class="log-prop-key">${escapeHtml(k)}</span>=${escapeHtml(val)}</span>`
    );
  }
  return parts.join(' ');
}

function createLineEl(entry) {
  const lvl = levelName(entry.level);
  const div = document.createElement('div');
  div.className = `log-line log-level-${lvl}`;
  if (entry.botId) {
    div.dataset.botid = entry.botId;
  }

  const botTag = entry.botId ? `<span class="log-agent-tag">${escapeHtml(entry.botId)}</span>` : '';

  div.innerHTML = `<span class="log-time">${formatTime(entry.time)}</span><span class="log-badge log-badge-${lvl}">${LEVEL_LABELS[lvl] || 'LOG'}</span>${botTag}<span class="log-msg">${escapeHtml(entry.msg || '')}</span><span class="log-extra">${logExtraProps(entry)}</span>`;
  return div;
}

function logAppendLines(entries) {
  if (!logContainer) return;
  for (const entry of entries) {
    if (!logMatchesFilter(entry)) continue;
    logContainer.appendChild(createLineEl(entry));
  }
  while (logContainer.children.length > MAX_DOM_LINES) {
    logContainer.removeChild(logContainer.firstChild);
  }
  if (activeTab === 'logs') updateCount();
  if (logAutoScroll) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

function logRefilterAll() {
  if (!logContainer) return;
  for (const child of logContainer.children) {
    const classes = child.className;
    const lvlMatch = classes.match(/log-level-(\w+)/);
    const lvl = lvlMatch ? lvlMatch[1] : 'info';
    let visible = logActiveLevels.has(lvl);
    if (visible && logActiveAgent) {
      const entryBot = child.dataset.botid || '';
      visible = entryBot === logActiveAgent;
    }
    if (visible && logSearchTerm) {
      const text = child.textContent.toLowerCase();
      visible = text.includes(logSearchTerm);
    }
    child.style.display = visible ? '' : 'none';
  }
  if (activeTab === 'logs') updateCount();
}

function logConnectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  logWs = new WebSocket(`${proto}//${location.host}/ws/logs`);

  logWs.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      const lines = data.lines || [];
      if (logPaused) {
        logPauseBuffer.push(...lines);
      } else {
        logAppendLines(lines);
      }
    } catch {
      /* ignore */
    }
  };

  logWs.onclose = () => {
    if (logContainer) setTimeout(logConnectWS, 2000);
  };

  logWs.onerror = () => {
    logWs.close();
  };
}

/* ── Tab switching ─────────────────────────────────────────── */

function switchTab(tab) {
  activeTab = tab;

  // Update tab buttons
  document.querySelectorAll('.activity-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Toggle panels
  const evPanel = document.getElementById('ev-panel');
  const logPanel = document.getElementById('log-panel');
  if (evPanel) evPanel.style.display = tab === 'events' ? '' : 'none';
  if (logPanel) logPanel.style.display = tab === 'logs' ? '' : 'none';

  // Update pause button to reflect active tab's state
  const pauseBtn = document.getElementById('activity-pause');
  if (pauseBtn) {
    const isPaused = tab === 'events' ? evPaused : logPaused;
    pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('btn-primary', isPaused);
  }

  updateCount();
}

/* ── Render ─────────────────────────────────────────────────── */

export async function renderActivity(el) {
  // Reset state
  evPaused = false;
  evPauseBuffer = [];
  evAutoScroll = true;
  evActiveBot = '';
  evActiveType = '';

  logPaused = false;
  logPauseBuffer = [];
  logAutoScroll = true;
  logActiveLevels = new Set(['debug', 'info', 'warn', 'error', 'fatal', 'trace']);
  logSearchTerm = '';
  logActiveAgent = '';

  // Determine initial tab from URL
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  activeTab = params.get('tab') === 'logs' ? 'logs' : 'events';

  // Fetch agents for filter dropdowns
  let agents = [];
  try {
    const res = await fetch('/api/agents');
    agents = await res.json();
  } catch {
    /* ignore */
  }

  const agentOptions = agents
    .map(
      (a) =>
        `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} (${escapeHtml(a.id)})</option>`
    )
    .join('');

  const typeOptions = Object.keys(TYPE_COLORS)
    .map((t) => `<option value="${t}">${t}</option>`)
    .join('');

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Activity <span class="count" id="activity-count">0</span></div>
      <div class="actions">
        <button class="btn btn-sm" id="activity-pause">Pause</button>
        <button class="btn btn-sm" id="activity-clear">Clear</button>
      </div>
    </div>
    <div class="activity-tabs">
      <button class="activity-tab${activeTab === 'events' ? ' active' : ''}" data-tab="events">Events</button>
      <button class="activity-tab${activeTab === 'logs' ? ' active' : ''}" data-tab="logs">System Logs</button>
    </div>
    <div id="ev-panel" style="display:${activeTab === 'events' ? '' : 'none'}">
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
    </div>
    <div id="log-panel" style="display:${activeTab === 'logs' ? '' : 'none'}">
      <div class="log-toolbar">
        <label class="log-filter-label">
          <input type="checkbox" data-level="debug" checked> <span class="log-badge log-badge-debug">DBG</span>
        </label>
        <label class="log-filter-label">
          <input type="checkbox" data-level="info" checked> <span class="log-badge log-badge-info">INF</span>
        </label>
        <label class="log-filter-label">
          <input type="checkbox" data-level="warn" checked> <span class="log-badge log-badge-warn">WRN</span>
        </label>
        <label class="log-filter-label">
          <input type="checkbox" data-level="error" checked> <span class="log-badge log-badge-error">ERR</span>
        </label>
        <select class="log-agent-filter" id="log-agent-filter">
          <option value="">All Agents</option>
          ${agentOptions}
        </select>
        <input type="text" class="log-search" id="log-search" placeholder="Search logs...">
      </div>
      <div class="log-container" id="log-container"></div>
    </div>
  `;

  // Grab DOM refs
  countBadge = document.getElementById('activity-count');
  evContainer = document.getElementById('activity-container');
  logContainer = document.getElementById('log-container');

  // ── Tab click handlers ──
  el.querySelectorAll('.activity-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ── Pause/Resume (shared button, acts on active tab) ──
  const pauseBtn = document.getElementById('activity-pause');
  pauseBtn.addEventListener('click', () => {
    if (activeTab === 'events') {
      evPaused = !evPaused;
      pauseBtn.textContent = evPaused ? 'Resume' : 'Pause';
      pauseBtn.classList.toggle('btn-primary', evPaused);
      if (!evPaused && evPauseBuffer.length > 0) {
        evAppendEvents(evPauseBuffer);
        evPauseBuffer = [];
      }
    } else {
      logPaused = !logPaused;
      pauseBtn.textContent = logPaused ? 'Resume' : 'Pause';
      pauseBtn.classList.toggle('btn-primary', logPaused);
      if (!logPaused && logPauseBuffer.length > 0) {
        logAppendLines(logPauseBuffer);
        logPauseBuffer = [];
      }
    }
  });

  // ── Clear (acts on active tab) ──
  document.getElementById('activity-clear').addEventListener('click', () => {
    if (activeTab === 'events') {
      evContainer.innerHTML = '';
    } else {
      logContainer.innerHTML = '';
    }
    updateCount();
  });

  // ── Events tab filters ──
  document.getElementById('activity-bot-filter').addEventListener('change', (e) => {
    evActiveBot = e.target.value;
    evRefilterAll();
  });

  document.getElementById('activity-type-filter').addEventListener('change', (e) => {
    evActiveType = e.target.value;
    evRefilterAll();
  });

  // ── Logs tab filters ──
  el.querySelectorAll('#log-panel .log-filter-label input').forEach((cb) => {
    cb.addEventListener('change', () => {
      const lvl = cb.dataset.level;
      if (cb.checked) logActiveLevels.add(lvl);
      else logActiveLevels.delete(lvl);
      logRefilterAll();
    });
  });

  document.getElementById('log-agent-filter').addEventListener('change', (e) => {
    logActiveAgent = e.target.value;
    logRefilterAll();
  });

  document.getElementById('log-search').addEventListener('input', (e) => {
    logSearchTerm = e.target.value.toLowerCase();
    logRefilterAll();
  });

  // ── Auto-scroll for both containers ──
  evContainer.addEventListener('scroll', () => {
    const atBottom =
      evContainer.scrollHeight - evContainer.scrollTop - evContainer.clientHeight < 40;
    evAutoScroll = atBottom;
  });

  logContainer.addEventListener('scroll', () => {
    const atBottom =
      logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 40;
    logAutoScroll = atBottom;
  });

  // ── Connect both WebSockets (so neither loses events while on the other tab) ──
  evConnectWS();
  logConnectWS();

  // ── Set initial count ──
  updateCount();
}

export function destroyActivity() {
  if (evWs) {
    const ref = evWs;
    evWs = null;
    ref.onclose = null;
    ref.close();
  }
  if (logWs) {
    const ref = logWs;
    logWs = null;
    ref.onclose = null;
    ref.close();
  }
  evContainer = null;
  logContainer = null;
  countBadge = null;
  evPauseBuffer = [];
  logPauseBuffer = [];
}
