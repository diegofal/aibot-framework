import { renderAgents, renderAgentDetail, renderAgentEdit } from './pages/agents.js';
import { renderSessions, renderSessionTranscript } from './pages/sessions.js';
import { renderCron, renderCronDetail, renderCronCreate } from './pages/cron.js';

const content = document.getElementById('content');

const routes = [
  { pattern: /^#\/agents\/([^/]+)\/edit$/, handler: (m) => renderAgentEdit(content, m[1]) },
  { pattern: /^#\/agents\/([^/]+)$/,        handler: (m) => renderAgentDetail(content, m[1]) },
  { pattern: /^#\/agents$/,                  handler: () => renderAgents(content) },
  { pattern: /^#\/sessions\/(.+)$/,          handler: (m) => renderSessionTranscript(content, decodeURIComponent(m[1])) },
  { pattern: /^#\/sessions$/,                handler: () => renderSessions(content) },
  { pattern: /^#\/cron\/new$/,               handler: () => renderCronCreate(content) },
  { pattern: /^#\/cron\/([^/]+)$/,           handler: (m) => renderCronDetail(content, m[1]) },
  { pattern: /^#\/cron$/,                    handler: () => renderCron(content) },
];

function navigate() {
  const hash = location.hash || '#/agents';
  if (hash === '#/' || hash === '#') { location.hash = '#/agents'; return; }

  // Update active nav link
  document.querySelectorAll('.nav-link').forEach((el) => {
    const page = el.dataset.page;
    el.classList.toggle('active', hash.startsWith(`#/${page}`));
  });

  for (const route of routes) {
    const m = hash.match(route.pattern);
    if (m) { route.handler(m); return; }
  }

  // Default fallback
  renderAgents(content);
}

window.addEventListener('hashchange', navigate);

// Load status
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    document.getElementById('nav-status').textContent =
      `${data.bots.running}/${data.bots.configured} bots`;
  } catch { /* ignore */ }
}

loadStatus();
setInterval(loadStatus, 10000);

// Initial route
navigate();
