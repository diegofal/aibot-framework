import { destroyActivity, renderActivity } from './pages/activity.js';
import { renderAgentProposals } from './pages/agent-proposals.js';
import { renderAgentDetail, renderAgentEdit, renderAgents } from './pages/agents.js';
import { renderBaasAnalytics } from './pages/baas-analytics.js';
import { renderBaasCustomizations } from './pages/baas-customizations.js';
import { renderBaasTemplateDetail, renderBaasTemplates } from './pages/baas-templates.js';
import { renderBaasTenants } from './pages/baas-tenants.js';
import { renderBaasWebhooks } from './pages/baas-webhooks.js';
import {
  renderBotConversations,
  renderConversationChat,
  renderConversations,
} from './pages/conversations.js';
import { renderCron, renderCronCreate, renderCronDetail } from './pages/cron.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderBotFeedback, renderFeedback } from './pages/feedback.js';
import { destroyInbox, renderInbox, renderInboxChat } from './pages/inbox.js';
import { renderIntegrations } from './pages/integrations.js';
import { renderBotKarma, renderKarma } from './pages/karma.js';
import { renderAdminSetup, renderLogin } from './pages/login.js';
import { destroyPermissions, renderPermissions } from './pages/permissions.js';
import {
  destroyProductions,
  renderBotProductions,
  renderProductions,
} from './pages/productions.js';
import { renderSessionTranscript, renderSessions } from './pages/sessions.js';
import { renderSettings } from './pages/settings.js';
import { clearAuth, getAuthContext, getAuthToken } from './pages/shared.js';
import {
  renderSkillCreate,
  renderSkillDetail,
  renderSkillEdit,
  renderSkills,
} from './pages/skills.js';
import { renderToolRunner } from './pages/tool-runner.js';
import { renderToolDetail, renderTools } from './pages/tools.js';

const content = document.getElementById('content');
const sidebar = document.getElementById('sidebar');
let multiTenantEnabled = false;
let adminSetupRequired = false;

function authedFetch(url) {
  const token = getAuthToken();
  const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
  return fetch(url, opts);
}

function updateAuthUI() {
  // Remove existing auth info
  const existing = document.getElementById('nav-auth-info');
  if (existing) existing.remove();

  if (!multiTenantEnabled || !getAuthToken()) return;

  const ctx = getAuthContext();
  const div = document.createElement('div');
  div.id = 'nav-auth-info';
  div.className = 'nav-auth-info';
  div.innerHTML = `<span class="auth-name">${ctx.name || ctx.role || 'User'}</span><button class="btn btn-sm" id="auth-logout-btn">Logout</button>`;

  const navStatus = document.getElementById('nav-status');
  navStatus.parentNode.insertBefore(div, navStatus);

  document.getElementById('auth-logout-btn').addEventListener('click', async () => {
    const token = getAuthToken();
    if (token?.startsWith('sess_')) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        /* ignore */
      }
    }
    clearAuth();
    navigate();
  });
}

const routes = [
  { pattern: /^#\/$/, handler: () => renderDashboard(content) },
  { pattern: /^#\/inbox\/([^/]+)\/([^/]+)$/, handler: (m) => renderInboxChat(content, m[1], m[2]) },
  { pattern: /^#\/inbox$/, handler: () => renderInbox(content) },
  { pattern: /^#\/permissions$/, handler: () => renderPermissions(content) },
  { pattern: /^#\/agents\/([^/]+)\/edit$/, handler: (m) => renderAgentEdit(content, m[1]) },
  { pattern: /^#\/agents\/([^/]+)$/, handler: (m) => renderAgentDetail(content, m[1]) },
  { pattern: /^#\/agents$/, handler: () => renderAgents(content) },
  {
    pattern: /^#\/sessions\/(.+)$/,
    handler: (m) => renderSessionTranscript(content, decodeURIComponent(m[1])),
  },
  { pattern: /^#\/sessions$/, handler: () => renderSessions(content) },
  { pattern: /^#\/cron\/new$/, handler: () => renderCronCreate(content) },
  { pattern: /^#\/cron\/([^/]+)$/, handler: (m) => renderCronDetail(content, m[1]) },
  { pattern: /^#\/cron$/, handler: () => renderCron(content) },
  {
    pattern: /^#\/conversations\/([^/]+)\/([^/]+)$/,
    handler: (m) => renderConversationChat(content, m[1], m[2]),
  },
  { pattern: /^#\/conversations\/([^/]+)$/, handler: (m) => renderBotConversations(content, m[1]) },
  { pattern: /^#\/conversations$/, handler: () => renderConversations(content) },
  {
    pattern: /^#\/productions\/([^/?]+)(?:\?|$)/,
    handler: (m) => renderBotProductions(content, m[1]),
  },
  { pattern: /^#\/productions(?:\?|$)/, handler: () => renderProductions(content) },
  { pattern: /^#\/feedback\/([^/]+)$/, handler: (m) => renderBotFeedback(content, m[1]) },
  { pattern: /^#\/feedback$/, handler: () => renderFeedback(content) },
  { pattern: /^#\/karma\/([^/]+)$/, handler: (m) => renderBotKarma(content, m[1]) },
  { pattern: /^#\/karma$/, handler: () => renderKarma(content) },
  { pattern: /^#\/skills\/new$/, handler: () => renderSkillCreate(content) },
  {
    pattern: /^#\/skills\/([^/]+)\/edit$/,
    handler: (m) => renderSkillEdit(content, decodeURIComponent(m[1])),
  },
  {
    pattern: /^#\/skills\/([^/]+)$/,
    handler: (m) => renderSkillDetail(content, decodeURIComponent(m[1])),
  },
  { pattern: /^#\/skills$/, handler: () => renderSkills(content) },
  { pattern: /^#\/tool-runner$/, handler: () => renderToolRunner(content) },
  { pattern: /^#\/tools\/([^/]+)$/, handler: (m) => renderToolDetail(content, m[1]) },
  { pattern: /^#\/tools$/, handler: () => renderTools(content) },
  { pattern: /^#\/agent-proposals$/, handler: () => renderAgentProposals(content) },
  { pattern: /^#\/activity/, handler: () => renderActivity(content) },
  { pattern: /^#\/integrations$/, handler: () => renderIntegrations(content) },
  { pattern: /^#\/settings$/, handler: () => renderSettings(content) },
  {
    pattern: /^#\/baas\/templates\/([^/]+)$/,
    handler: (m) => renderBaasTemplateDetail(content, decodeURIComponent(m[1])),
  },
  { pattern: /^#\/baas\/templates$/, handler: () => renderBaasTemplates(content) },
  { pattern: /^#\/baas\/webhooks$/, handler: () => renderBaasWebhooks(content) },
  { pattern: /^#\/baas\/customizations$/, handler: () => renderBaasCustomizations(content) },
  { pattern: /^#\/baas\/analytics$/, handler: () => renderBaasAnalytics(content) },
  { pattern: /^#\/baas\/tenants$/, handler: () => renderBaasTenants(content) },
];

function navigate() {
  destroyInbox();
  destroyPermissions();
  destroyActivity();
  destroyProductions();

  // Auth gate: require login in multi-tenant mode
  if (multiTenantEnabled && !getAuthToken()) {
    sidebar.style.display = 'none';
    const existing = document.getElementById('nav-auth-info');
    if (existing) existing.remove();
    if (adminSetupRequired) {
      renderAdminSetup(content, () => {
        adminSetupRequired = false;
        navigate();
      });
      return;
    }
    renderLogin(content, () => {
      sidebar.style.display = '';
      updateAuthUI();
      navigate();
    });
    return;
  }
  sidebar.style.display = '';
  updateAuthUI();

  // Toggle BaaS sidebar links based on multi-tenant mode
  const baasDisplay = multiTenantEnabled ? '' : 'none';
  document.querySelectorAll('.nav-link-baas').forEach((el) => {
    el.style.display = baasDisplay;
  });

  // Hide admin-only BaaS pages from tenant users
  const auth = getAuthContext();
  if (auth.role === 'tenant') {
    document.querySelectorAll('.nav-link-baas-admin').forEach((el) => {
      el.style.display = 'none';
    });
    // Hide admin-only nav links (Settings, Integrations, Tools, Tool Runner)
    document.querySelectorAll('.nav-link-admin').forEach((el) => {
      el.style.display = 'none';
    });
  }

  const hash = location.hash || '#/';
  if (hash === '#') {
    location.hash = '#/';
    return;
  }

  // Redirect legacy #/logs to unified activity page
  if (hash === '#/logs') {
    location.hash = '#/activity?tab=logs';
    return;
  }

  // Update active nav link
  document.querySelectorAll('.nav-link').forEach((el) => {
    const page = el.dataset.page;
    const isActive = page === '' ? hash === '#/' || hash === '#' : hash.startsWith(`#/${page}`);
    el.classList.toggle('active', isActive);
  });

  for (const route of routes) {
    const m = hash.match(route.pattern);
    if (m) {
      route.handler(m);
      return;
    }
  }

  // Default fallback
  renderDashboard(content);
}

window.addEventListener('hashchange', navigate);

// Load auth status (public endpoint)
async function loadAuthStatus() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    multiTenantEnabled = data.multiTenantEnabled ?? false;
    adminSetupRequired = data.adminSetupRequired ?? false;
  } catch {
    /* ignore */
  }
}

// Load status (public endpoint, no auth needed)
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    document.getElementById('nav-status').textContent =
      `${data.bots.running}/${data.bots.configured} bots`;
  } catch {
    /* ignore */
  }
}

// Batched badge polling — single request for all badge counts
async function loadBadges() {
  try {
    const res = await authedFetch('/api/dashboard/badges');
    if (!res.ok) return;
    const data = await res.json();
    const badges = [
      ['inbox-badge', data.askHuman],
      ['feedback-badge', data.agentFeedback],
      ['permissions-badge', data.askPermission],
      ['agent-proposals-badge', data.agentProposals],
    ];
    for (const [id, count] of badges) {
      const badge = document.getElementById(id);
      if (badge) {
        if (count > 0) {
          badge.textContent = count;
          badge.style.display = '';
        } else {
          badge.style.display = 'none';
        }
      }
    }
  } catch {
    /* ignore */
  }
}

// Listen for auth:required events (401 from api())
window.addEventListener('auth:required', () => navigate());

// Boot: load auth status first (multi-tenant + admin setup), then bot status, then navigate
await loadAuthStatus();
loadStatus();
setInterval(loadStatus, 10000);

loadBadges();
setInterval(loadBadges, 10000);

// Initial route
navigate();
