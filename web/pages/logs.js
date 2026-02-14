import { escapeHtml } from './shared.js';

const LEVEL_MAP = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const LEVEL_LABELS = { trace: 'TRC', debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', fatal: 'FTL' };
const MAX_DOM_LINES = 2000;

let ws = null;
let paused = false;
let pauseBuffer = [];
let autoScroll = true;
let lineCount = 0;
let activeLevels = new Set(['debug', 'info', 'warn', 'error', 'fatal', 'trace']);
let searchTerm = '';

// DOM references (set in render)
let container = null;
let countBadge = null;

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function levelName(num) {
  return LEVEL_MAP[num] || 'info';
}

function matchesFilter(entry) {
  const lvl = levelName(entry.level);
  if (!activeLevels.has(lvl)) return false;
  if (searchTerm) {
    const text = (entry.msg || '') + ' ' + JSON.stringify(entry);
    if (!text.toLowerCase().includes(searchTerm)) return false;
  }
  return true;
}

function extraProps(entry) {
  const skip = new Set(['level', 'time', 'pid', 'hostname', 'msg']);
  const parts = [];
  for (const [k, v] of Object.entries(entry)) {
    if (skip.has(k)) continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`<span class="log-prop"><span class="log-prop-key">${escapeHtml(k)}</span>=${escapeHtml(val)}</span>`);
  }
  return parts.join(' ');
}

function createLineEl(entry) {
  const lvl = levelName(entry.level);
  const div = document.createElement('div');
  div.className = `log-line log-level-${lvl}`;
  div.innerHTML =
    `<span class="log-time">${formatTime(entry.time)}</span>` +
    `<span class="log-badge log-badge-${lvl}">${LEVEL_LABELS[lvl] || 'LOG'}</span>` +
    `<span class="log-msg">${escapeHtml(entry.msg || '')}</span>` +
    `<span class="log-extra">${extraProps(entry)}</span>`;
  return div;
}

function appendLines(entries) {
  if (!container) return;
  for (const entry of entries) {
    if (!matchesFilter(entry)) continue;
    container.appendChild(createLineEl(entry));
    lineCount++;
  }
  // Trim old lines
  while (container.children.length > MAX_DOM_LINES) {
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
  // Re-render not possible without original data, so we just hide/show
  if (!container) return;
  for (const child of container.children) {
    const classes = child.className;
    const lvlMatch = classes.match(/log-level-(\w+)/);
    const lvl = lvlMatch ? lvlMatch[1] : 'info';
    let visible = activeLevels.has(lvl);
    if (visible && searchTerm) {
      const text = child.textContent.toLowerCase();
      visible = text.includes(searchTerm);
    }
    child.style.display = visible ? '' : 'none';
  }
  updateCount();
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/logs`);

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      const lines = data.lines || [];
      if (paused) {
        pauseBuffer.push(...lines);
      } else {
        appendLines(lines);
      }
    } catch { /* ignore */ }
  };

  ws.onclose = () => {
    // Reconnect after 2s if not destroyed
    if (container) setTimeout(connectWS, 2000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

export function renderLogs(el) {
  paused = false;
  pauseBuffer = [];
  autoScroll = true;
  lineCount = 0;
  searchTerm = '';
  activeLevels = new Set(['debug', 'info', 'warn', 'error', 'fatal', 'trace']);

  el.innerHTML = `
    <div class="flex-between mb-16">
      <div class="page-title">Logs <span class="count" id="log-count">0</span></div>
      <div class="actions">
        <button class="btn btn-sm" id="log-pause">Pause</button>
        <button class="btn btn-sm" id="log-clear">Clear</button>
      </div>
    </div>
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
      <input type="text" class="log-search" id="log-search" placeholder="Search logs...">
    </div>
    <div class="log-container" id="log-container"></div>
  `;

  container = document.getElementById('log-container');
  countBadge = document.getElementById('log-count');

  // Pause/resume
  const pauseBtn = document.getElementById('log-pause');
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('btn-primary', paused);
    if (!paused && pauseBuffer.length > 0) {
      appendLines(pauseBuffer);
      pauseBuffer = [];
    }
  });

  // Clear
  document.getElementById('log-clear').addEventListener('click', () => {
    container.innerHTML = '';
    lineCount = 0;
    updateCount();
  });

  // Level filters
  el.querySelectorAll('.log-filter-label input').forEach((cb) => {
    cb.addEventListener('change', () => {
      const lvl = cb.dataset.level;
      if (cb.checked) activeLevels.add(lvl);
      else activeLevels.delete(lvl);
      refilterAll();
    });
  });

  // Search
  document.getElementById('log-search').addEventListener('input', (e) => {
    searchTerm = e.target.value.toLowerCase();
    refilterAll();
  });

  // Auto-scroll detection
  container.addEventListener('scroll', () => {
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
    autoScroll = atBottom;
  });

  // Connect WebSocket
  connectWS();
}

export function destroyLogs() {
  if (ws) {
    const ref = ws;
    ws = null;
    ref.onclose = null; // prevent reconnect
    ref.close();
  }
  container = null;
  countBadge = null;
  pauseBuffer = [];
}
