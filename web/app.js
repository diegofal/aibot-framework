import { renderDashboard } from './pages/dashboard.js';
import { renderAgents, renderAgentDetail, renderAgentEdit } from './pages/agents.js';
import { renderSessions, renderSessionTranscript } from './pages/sessions.js';
import { renderCron, renderCronDetail, renderCronCreate } from './pages/cron.js';
import { renderTools, renderToolDetail } from './pages/tools.js';
import { renderLogs, destroyLogs } from './pages/logs.js';
import { renderSettings } from './pages/settings.js';
import { renderInbox, destroyInbox, renderInboxChat } from './pages/inbox.js';
import { renderPermissions, destroyPermissions } from './pages/permissions.js';
import { renderProductions, renderBotProductions } from './pages/productions.js';
import { renderConversations, renderBotConversations, renderConversationChat } from './pages/conversations.js';
import { renderFeedback, renderBotFeedback } from './pages/feedback.js';
import { renderKarma, renderBotKarma } from './pages/karma.js';
import { renderSkills, renderSkillDetail, renderSkillEdit, renderSkillCreate } from './pages/skills.js';
import { renderIntegrations } from './pages/integrations.js';
import { renderToolRunner } from './pages/tool-runner.js';

const content = document.getElementById('content');

const routes = [
  { pattern: /^#\/$/, handler: () => renderDashboard(content) },
  { pattern: /^#\/inbox\/([^/]+)\/([^/]+)$/, handler: (m) => renderInboxChat(content, m[1], m[2]) },
  { pattern: /^#\/inbox$/, handler: () => renderInbox(content) },
  { pattern: /^#\/permissions$/, handler: () => renderPermissions(content) },
  { pattern: /^#\/agents\/([^/]+)\/edit$/, handler: (m) => renderAgentEdit(content, m[1]) },
  { pattern: /^#\/agents\/([^/]+)$/,        handler: (m) => renderAgentDetail(content, m[1]) },
  { pattern: /^#\/agents$/,                  handler: () => renderAgents(content) },
  { pattern: /^#\/sessions\/(.+)$/,          handler: (m) => renderSessionTranscript(content, decodeURIComponent(m[1])) },
  { pattern: /^#\/sessions$/,                handler: () => renderSessions(content) },
  { pattern: /^#\/cron\/new$/,               handler: () => renderCronCreate(content) },
  { pattern: /^#\/cron\/([^/]+)$/,           handler: (m) => renderCronDetail(content, m[1]) },
  { pattern: /^#\/cron$/,                    handler: () => renderCron(content) },
  { pattern: /^#\/conversations\/([^/]+)\/([^/]+)$/, handler: (m) => renderConversationChat(content, m[1], m[2]) },
  { pattern: /^#\/conversations\/([^/]+)$/,  handler: (m) => renderBotConversations(content, m[1]) },
  { pattern: /^#\/conversations$/,           handler: () => renderConversations(content) },
  { pattern: /^#\/productions\/([^/]+)$/,     handler: (m) => renderBotProductions(content, m[1]) },
  { pattern: /^#\/productions$/,             handler: () => renderProductions(content) },
  { pattern: /^#\/feedback\/([^/]+)$/,       handler: (m) => renderBotFeedback(content, m[1]) },
  { pattern: /^#\/feedback$/,                handler: () => renderFeedback(content) },
  { pattern: /^#\/karma\/([^/]+)$/,          handler: (m) => renderBotKarma(content, m[1]) },
  { pattern: /^#\/karma$/,                   handler: () => renderKarma(content) },
  { pattern: /^#\/skills\/new$/,              handler: () => renderSkillCreate(content) },
  { pattern: /^#\/skills\/([^/]+)\/edit$/,   handler: (m) => renderSkillEdit(content, decodeURIComponent(m[1])) },
  { pattern: /^#\/skills\/([^/]+)$/,         handler: (m) => renderSkillDetail(content, decodeURIComponent(m[1])) },
  { pattern: /^#\/skills$/,                  handler: () => renderSkills(content) },
  { pattern: /^#\/tool-runner$/,              handler: () => renderToolRunner(content) },
  { pattern: /^#\/tools\/([^/]+)$/,          handler: (m) => renderToolDetail(content, m[1]) },
  { pattern: /^#\/tools$/,                   handler: () => renderTools(content) },
  { pattern: /^#\/logs$/,                    handler: () => renderLogs(content) },
  { pattern: /^#\/integrations$/,            handler: () => renderIntegrations(content) },
  { pattern: /^#\/settings$/,               handler: () => renderSettings(content) },
];

function navigate() {
  destroyLogs();
  destroyInbox();
  destroyPermissions();
  const hash = location.hash || '#/';
  if (hash === '#') { location.hash = '#/'; return; }

  // Update active nav link
  document.querySelectorAll('.nav-link').forEach((el) => {
    const page = el.dataset.page;
    const isActive = page === ''
      ? hash === '#/' || hash === '#'
      : hash.startsWith(`#/${page}`);
    el.classList.toggle('active', isActive);
  });

  for (const route of routes) {
    const m = hash.match(route.pattern);
    if (m) { route.handler(m); return; }
  }

  // Default fallback
  renderDashboard(content);
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

// Inbox badge polling
async function loadInboxBadge() {
  try {
    const res = await fetch('/api/ask-human/count');
    const data = await res.json();
    const badge = document.getElementById('inbox-badge');
    if (badge) {
      if (data.count > 0) {
        badge.textContent = data.count;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
  } catch { /* ignore */ }
}

loadInboxBadge();
setInterval(loadInboxBadge, 10000);

// Feedback badge polling
async function loadFeedbackBadge() {
  try {
    const res = await fetch('/api/agent-feedback/count');
    const data = await res.json();
    const badge = document.getElementById('feedback-badge');
    if (badge) {
      if (data.count > 0) {
        badge.textContent = data.count;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
  } catch { /* ignore */ }
}

loadFeedbackBadge();
setInterval(loadFeedbackBadge, 10000);

// Permissions badge polling
async function loadPermissionsBadge() {
  try {
    const res = await fetch('/api/ask-permission/count');
    const data = await res.json();
    const badge = document.getElementById('permissions-badge');
    if (badge) {
      if (data.count > 0) {
        badge.textContent = data.count;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
  } catch { /* ignore */ }
}

loadPermissionsBadge();
setInterval(loadPermissionsBadge, 10000);

// Initial route
navigate();
