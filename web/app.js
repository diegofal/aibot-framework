import { AREAS, areaNav, matchRoute, resolveHash, sidebarLinks } from './nav-routes.js';
import { destroyActivity, renderActivity } from './pages/activity.js';
import { destroyAgentHome, renderAgentHome } from './pages/agent-home.js';
import { renderAgentProposals } from './pages/agent-proposals.js';
import { destroyAgentWizard, renderAgentWizard } from './pages/agent-wizard.js';
import {
  destroyAgentDetail,
  renderAgentDetail,
  renderAgentEdit,
  renderAgents,
} from './pages/agents.js';
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
import { renderDispatches } from './pages/dispatches.js';
import { renderBotFeedback, renderFeedback } from './pages/feedback.js';
import { destroyFleetHome, renderFleetHome } from './pages/fleet-home.js';
import { destroyInbox, renderInbox, renderInboxChat } from './pages/inbox.js';
import { renderIntegrations } from './pages/integrations.js';
import { renderBotKarma, renderKarma } from './pages/karma.js';
import { stopAllWatches } from './pages/live-presence.js';
import { renderAdminSetup, renderLogin } from './pages/login.js';
import { destroyNeedsYou, renderNeedsYou } from './pages/needs-you.js';
import { destroyPermissions, renderPermissions } from './pages/permissions.js';
import {
  destroyProductions,
  renderBotProductions,
  renderProductions,
} from './pages/productions.js';
import { renderSessionTranscript, renderSessions } from './pages/sessions.js';
import { renderSettings } from './pages/settings.js';
import { api, clearAuth, getAuthContext, getAuthToken } from './pages/shared.js';
import {
  renderSkillCreate,
  renderSkillDetail,
  renderSkillEdit,
  renderSkills,
} from './pages/skills.js';
import {
  renderStats,
  renderStatsBehaviour,
  renderStatsBot,
  renderStatsHygiene,
  renderStatsInfra,
} from './pages/stats.js';
import { renderToolRunner } from './pages/tool-runner.js';
import { destroyWork, renderWork } from './pages/work.js';
import { renderToolDetail, renderTools } from './pages/tools.js';
import { initPalette } from './ui/palette.js';
import { initTheme } from './ui/theme.js';

// #content holds the area tab strip (#area-nav) and the page slot (#page);
// pages render into the slot so the strip survives their innerHTML resets.
const content = document.getElementById('page');
const areaNavEl = document.getElementById('area-nav');
const navAreas = document.getElementById('nav-areas');
const sidebar = document.getElementById('sidebar');
const navToggle = document.getElementById('nav-toggle');
const drawerBackdrop = document.getElementById('drawer-backdrop');

// Off-canvas drawer (sidebar under 900px, see "Responsive shell" in style.css)
function setDrawer(open) {
  sidebar.classList.toggle('open', open);
  drawerBackdrop?.classList.toggle('show', open);
  navToggle?.setAttribute('aria-expanded', String(open));
}
navToggle?.addEventListener('click', () => setDrawer(!sidebar.classList.contains('open')));
drawerBackdrop?.addEventListener('click', () => setDrawer(false));
sidebar.addEventListener('click', (e) => {
  if (e.target.closest('a.nav-link')) setDrawer(false);
});
initTheme();
let multiTenantEnabled = false;
let adminSetupRequired = false;
let badgeCounts = {};

// Command palette (S8): Ctrl+K / Cmd+K anywhere, plus the sidebar's ⌘K button.
initPalette({
  loadAgents: () => api('/api/agents'),
  ctx: () => navCtx(),
  api,
  navigate: (href) => {
    location.hash = href;
  },
  canOpen: () => !document.body.classList.contains('unauthed'),
});

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

/**
 * Handler name (see ROUTES in nav-routes.js) -> page function. The route
 * table is data so tests/web/nav-routes.test.ts can prove every legacy hash
 * still lands on a handler that exists here.
 */
const handlers = {
  fleetHome: () => renderFleetHome(content),
  agents: () => renderAgents(content),
  agentWizard: () => renderAgentWizard(content),
  agentHome: (id) => renderAgentHome(content, id),
  agentDetail: (id) => renderAgentDetail(content, id),
  agentEdit: (id) => renderAgentEdit(content, id),
  needsYou: () => renderNeedsYou(content),
  inbox: () => renderInbox(content),
  inboxChat: (botId, id) => renderInboxChat(content, botId, id),
  permissions: () => renderPermissions(content),
  agentProposals: () => renderAgentProposals(content),
  work: () => renderWork(content),
  dispatches: () => renderDispatches(content),
  productions: () => renderProductions(content),
  botProductions: (botId) => renderBotProductions(content, botId),
  conversations: () => renderConversations(content),
  botConversations: (botId) => renderBotConversations(content, botId),
  conversationChat: (botId, id) => renderConversationChat(content, botId, id),
  sessions: () => renderSessions(content),
  sessionTranscript: (id) => renderSessionTranscript(content, id),
  cron: () => renderCron(content),
  cronCreate: () => renderCronCreate(content),
  cronDetail: (id) => renderCronDetail(content, id),
  skills: () => renderSkills(content),
  skillCreate: () => renderSkillCreate(content),
  skillDetail: (id) => renderSkillDetail(content, id),
  skillEdit: (id) => renderSkillEdit(content, id),
  tools: () => renderTools(content),
  toolDetail: (name) => renderToolDetail(content, name),
  toolRunner: () => renderToolRunner(content),
  stats: () => renderStats(content),
  statsBot: (id) => renderStatsBot(content, id),
  statsBehaviour: () => renderStatsBehaviour(content),
  statsInfra: () => renderStatsInfra(content),
  statsHygiene: () => renderStatsHygiene(content),
  karma: () => renderKarma(content),
  botKarma: (id) => renderBotKarma(content, id),
  activity: () => renderActivity(content),
  loop: () => renderDashboard(content),
  feedback: () => renderFeedback(content),
  botFeedback: (id) => renderBotFeedback(content, id),
  settings: () => renderSettings(content),
  integrations: () => renderIntegrations(content),
  baasTemplates: () => renderBaasTemplates(content),
  baasTemplateDetail: (id) => renderBaasTemplateDetail(content, id),
  baasWebhooks: () => renderBaasWebhooks(content),
  baasCustomizations: () => renderBaasCustomizations(content),
  baasAnalytics: () => renderBaasAnalytics(content),
  baasTenants: () => renderBaasTenants(content),
};

function navCtx() {
  return { multiTenant: multiTenantEnabled, role: getAuthContext().role };
}

/** Sidebar areas + the area tab strip for the current hash (visibility rules live in nav-routes.js). */
function renderChrome(hash) {
  const ctx = navCtx();
  if (navAreas) navAreas.innerHTML = sidebarLinks(hash, ctx, badgeCounts);
  if (areaNavEl) areaNavEl.innerHTML = areaNav(hash, ctx, badgeCounts);
}

function navigate() {
  setDrawer(false);
  destroyFleetHome();
  destroyAgentHome();
  destroyAgentWizard();
  destroyAgentDetail();
  stopAllWatches();
  destroyNeedsYou();
  destroyInbox();
  destroyPermissions();
  destroyActivity();
  destroyProductions();
  destroyWork();
  content._dashboardCleanup?.();
  content._dashboardCleanup = null;

  // Auth gate: require login in multi-tenant mode
  if (multiTenantEnabled && !getAuthToken()) {
    sidebar.style.display = 'none';
    document.body.classList.add('unauthed');
    if (areaNavEl) areaNavEl.innerHTML = '';
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
  document.body.classList.remove('unauthed');
  updateAuthUI();

  // Legacy hashes (#/karma, #/stats/bot/x, #/inbox/...) redirect to their
  // canonical place; replace() keeps the back button sane. hashchange re-enters.
  const raw = location.hash || '#/';
  const hash = resolveHash(raw);
  if (hash !== raw) {
    location.replace(hash);
    return;
  }

  renderChrome(hash);

  const hit = matchRoute(hash);
  if (hit) {
    handlers[hit.route.handler](...hit.args);
    return;
  }

  // Default fallback
  renderFleetHome(content);
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
    const label = `${data.bots.running}/${data.bots.configured} bots`;
    document.getElementById('nav-status').textContent = label;
    const top = document.getElementById('topbar-status');
    if (top) top.textContent = label;
  } catch {
    /* ignore */
  }
}

// Badge polling. /api/dashboard/badges feeds the per-queue tab counts; the
// sidebar's single "Needs You" count comes from /api/needs-you/count (S5), which
// also counts unreviewed outputs and feedback replies. The two requests run in
// parallel; either failing leaves the other's numbers in place.
async function loadBadges() {
  const [legacy, needs] = await Promise.all([
    authedFetch('/api/dashboard/badges')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    authedFetch('/api/needs-you/count')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  if (!legacy && !needs) return;
  const data = { ...badgeCounts, ...(legacy ?? {}) };
  if (needs && Number.isFinite(Number(needs.count))) data.needs = Number(needs.count);
  const changed = JSON.stringify(data) !== JSON.stringify(badgeCounts);
  badgeCounts = data;
  if (changed && !document.body.classList.contains('unauthed')) {
    renderChrome(resolveHash(location.hash || '#/'));
  }
}
// Pages that resolve an item (Needs You) ask for an immediate re-count.
window.addEventListener('badges:refresh', () => loadBadges());

// Listen for auth:required events (401 from api())
window.addEventListener('auth:required', () => navigate());

export { AREAS };

// Boot: load auth status first (multi-tenant + admin setup), then bot status, then navigate
await loadAuthStatus();
loadStatus();
setInterval(loadStatus, 10000);

loadBadges();
setInterval(loadBadges, 10000);

// Initial route
navigate();
