import { checkNavGuards, clearNavGuards } from './nav-guard.js';
import {
  AREAS,
  areaNav,
  badgesFromNeedsCount,
  matchRoute,
  notFoundMarkup,
  resolveHash,
  sidebarLinks,
} from './nav-routes.js';
import { createPageLifecycle } from './page-lifecycle.js';
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
import { destroyDashboard, renderDashboard } from './pages/dashboard.js';
import { destroyDispatches, renderDispatches } from './pages/dispatches.js';
import { renderBotFeedback, renderFeedback } from './pages/feedback.js';
import { destroyFleetBoard, renderFleetBoard } from './pages/fleet-board.js';
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
  renderStatsCuriosity,
  renderStatsHygiene,
  renderStatsInfra,
} from './pages/stats.js';
import { renderToolDetail, renderTools } from './pages/tools.js';
import { destroyWork, renderWork } from './pages/work.js';
import { confirmDialog } from './ui/dialog.js';
import { initPalette, openPalette } from './ui/palette.js';
import { closeSheet } from './ui/sheet.js';
import { clearPageShortcuts, initShortcuts } from './ui/shortcuts.js';
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

// Global keys (UX overhaul wave 2): g+letter jumps, / filter, n new, ? help.
// See web/ui/shortcuts.js.
initShortcuts({
  ctx: () => navCtx(),
  navigate: (href) => {
    location.hash = href;
  },
  canUse: () => !document.body.classList.contains('unauthed'),
});

// Per-page cleanup: each handler below declares its page's destroy functions
// (and may return a cleanup, or a promise of one). Leaving a page runs them
// once, plus the hooks every page shares. See web/page-lifecycle.js.
const lifecycle = createPageLifecycle({
  always: [stopAllWatches, closeSheet, clearNavGuards, clearPageShortcuts],
  onError: (err) => console.error('page cleanup failed', err),
});

/** A route handler: `render(...args)` plus the destroy functions of the page it draws. */
function page(render, ...destroys) {
  return Object.assign((...args) => render(...args), { destroys });
}

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
 * Handler name (see ROUTES in nav-routes.js) -> page function + its destroys.
 * The route table is data so tests/web/nav-routes.test.ts can prove every
 * legacy hash still lands on a handler that exists here.
 */
const handlers = {
  fleetHome: page(() => renderFleetHome(content), destroyFleetHome),
  fleetBoard: page(() => renderFleetBoard(content), destroyFleetBoard),
  agents: page(() => renderAgents(content), destroyAgentDetail),
  agentWizard: page(() => renderAgentWizard(content), destroyAgentWizard),
  agentHome: page((id) => renderAgentHome(content, id), destroyAgentHome),
  agentDetail: page((id) => renderAgentDetail(content, id), destroyAgentDetail),
  agentEdit: page((id) => renderAgentEdit(content, id), destroyAgentDetail),
  needsYou: page((bot) => renderNeedsYou(content, { bot }), destroyNeedsYou),
  inbox: page(() => renderInbox(content), destroyInbox),
  inboxChat: page((botId, id) => renderInboxChat(content, botId, id), destroyInbox),
  permissions: page(() => renderPermissions(content), destroyPermissions),
  agentProposals: page(() => renderAgentProposals(content)),
  work: page(() => renderWork(content), destroyWork),
  dispatches: page(() => renderDispatches(content), destroyDispatches),
  productions: page(() => renderProductions(content), destroyProductions),
  botProductions: page((botId) => renderBotProductions(content, botId), destroyProductions),
  conversations: page(() => renderConversations(content)),
  botConversations: page((botId) => renderBotConversations(content, botId)),
  conversationChat: page((botId, id) => renderConversationChat(content, botId, id)),
  sessions: page(() => renderSessions(content)),
  sessionTranscript: page((id) => renderSessionTranscript(content, id)),
  cron: page(() => renderCron(content)),
  cronCreate: page(() => renderCronCreate(content)),
  cronDetail: page((id) => renderCronDetail(content, id)),
  skills: page(() => renderSkills(content)),
  skillCreate: page(() => renderSkillCreate(content)),
  skillDetail: page((id) => renderSkillDetail(content, id)),
  skillEdit: page((id) => renderSkillEdit(content, id)),
  tools: page(() => renderTools(content)),
  toolDetail: page((name) => renderToolDetail(content, name)),
  stats: page(() => renderStats(content)),
  statsBot: page((id) => renderStatsBot(content, id)),
  statsBehaviour: page(() => renderStatsBehaviour(content)),
  statsCuriosity: page(() => renderStatsCuriosity(content)),
  statsInfra: page(() => renderStatsInfra(content)),
  statsHygiene: page(() => renderStatsHygiene(content)),
  karma: page(() => renderKarma(content)),
  botKarma: page((id) => renderBotKarma(content, id)),
  activity: page(() => renderActivity(content), destroyActivity),
  loop: page(() => renderDashboard(content), destroyDashboard),
  feedback: page(() => renderFeedback(content)),
  botFeedback: page((id) => renderBotFeedback(content, id)),
  settings: page(() => renderSettings(content)),
  integrations: page(() => renderIntegrations(content)),
  baasTemplates: page(() => renderBaasTemplates(content)),
  baasTemplateDetail: page((id) => renderBaasTemplateDetail(content, id)),
  baasWebhooks: page(() => renderBaasWebhooks(content)),
  baasCustomizations: page(() => renderBaasCustomizations(content)),
  baasAnalytics: page(() => renderBaasAnalytics(content)),
  baasTenants: page(() => renderBaasTenants(content)),
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
  lifecycle.leave();

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

  // Legacy hashes (see REDIRECTS in nav-routes.js) redirect to their canonical
  // place; replace() keeps the back button sane. hashchange re-enters.
  const raw = location.hash || '#/';
  const hash = resolveHash(raw);
  if (hash !== raw) {
    location.replace(hash);
    return;
  }

  renderChrome(hash);

  const hit = matchRoute(hash);
  if (hit) {
    const handler = handlers[hit.route.handler];
    lifecycle.enter(handler.destroys, handler(...hit.args));
    return;
  }

  // No route: a real 404 instead of silently showing Home.
  content.innerHTML = notFoundMarkup(hash);
  for (const el of content.querySelectorAll('[data-palette-open]')) {
    el.addEventListener('click', () => openPalette());
  }
}

// Navigation guard (wave 2): a page with unsaved edits registers a guard
// (web/nav-guard.js). Any hashchange (link, back button, typed hash) puts the
// old hash back while the confirm dialog is open and follows the new one only
// if the operator discards.
let lastUrl = location.href;
let bypassGuards = false;
async function onHashChange(e) {
  const fromUrl = e?.oldURL || lastUrl;
  const to = location.hash;
  if (!bypassGuards) {
    let asked = false;
    const ok = await checkNavGuards(to, (prompt) => {
      asked = true;
      history.replaceState(null, '', fromUrl);
      return confirmDialog(prompt);
    });
    if (!ok) return;
    if (asked) {
      // replaceState put the old hash back; following `to` fires hashchange again.
      bypassGuards = true;
      location.hash = to;
      return;
    }
  }
  bypassGuards = false;
  lastUrl = location.href;
  navigate();
}
window.addEventListener('hashchange', onHashChange);

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

// Load status (public endpoint, no auth needed). One place shows it: the
// sidebar foot (inside the drawer on narrow screens).
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

// Badge polling. One request: /api/needs-you/count (`{ count, byKind }`) feeds
// the sidebar's "Needs You" count and every queue tab (badgesFromNeedsCount).
// /api/dashboard/badges is only the fallback when that request fails.
const getJson = (url) =>
  authedFetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
async function loadBadges() {
  let fresh = badgesFromNeedsCount(await getJson('/api/needs-you/count'));
  if (!fresh) fresh = await getJson('/api/dashboard/badges');
  if (!fresh) return;
  const data = { ...badgeCounts, ...fresh };
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
