/**
 * Navigation model for the dashboard (session S3 of docs/plans/jarvis-fleet-plan.md).
 *
 * Pure data + pure functions, no DOM, so `tests/web/nav-routes.test.ts` can
 * prove that every hash the dashboard ever linked to still lands somewhere.
 *
 *   AREAS      the seven sidebar areas; each carries its sub-navigation tabs
 *   ROUTES     canonical hash patterns -> handler *name* (app.js maps names to
 *              page functions) + the area the hash belongs to
 *   REDIRECTS  legacy hash -> canonical hash (prefix rewrites that keep the
 *              rest of the hash, query string included)
 *
 * Tab flags: `admin: true` hides the tab from tenant users, `baas: true`
 * shows it only when multi-tenant mode is on. An area with tabs is shown
 * when at least one tab is visible; its sidebar link goes to the first
 * visible tab.
 */
import { esc, tabs } from './ui/index.js';

export const AREAS = [
  { id: 'home', label: 'Home', href: '#/', tabs: [] },
  { id: 'agents', label: 'Agents', href: '#/agents', tabs: [] },
  {
    id: 'needs',
    label: 'Needs You',
    href: '#/needs',
    badge: 'needs',
    tabs: [
      { id: 'queue', label: 'Queue', href: '#/needs', badge: 'needs' },
      { id: 'inbox', label: 'Inbox', href: '#/needs/inbox', badge: 'askHuman' },
      {
        id: 'permissions',
        label: 'Permissions',
        href: '#/needs/permissions',
        badge: 'askPermission',
      },
      { id: 'proposals', label: 'Proposals', href: '#/needs/proposals', badge: 'agentProposals' },
      { id: 'feedback', label: 'Feedback', href: '#/needs/feedback', badge: 'agentFeedback' },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    href: '#/work',
    tabs: [
      { id: 'outputs', label: 'Outputs', href: '#/work' },
      { id: 'dispatches', label: 'Dispatches', href: '#/work/dispatches' },
      { id: 'productions', label: 'Productions', href: '#/work/productions' },
      { id: 'conversations', label: 'Conversations', href: '#/work/conversations' },
      { id: 'sessions', label: 'Sessions', href: '#/work/sessions' },
    ],
  },
  {
    id: 'automations',
    label: 'Automations',
    href: '#/automations',
    tabs: [
      { id: 'cron', label: 'Cron', href: '#/automations/cron' },
      { id: 'loop', label: 'Agent loop', href: '#/automations/loop' },
      { id: 'skills', label: 'Skills', href: '#/automations/skills' },
      { id: 'tools', label: 'Tools', href: '#/automations/tools', admin: true },
    ],
  },
  {
    id: 'insights',
    label: 'Insights',
    href: '#/insights',
    tabs: [
      { id: 'stats', label: 'Stats', href: '#/insights/stats' },
      { id: 'behaviour', label: 'Behaviour', href: '#/insights/stats/behaviour' },
      { id: 'curiosity', label: 'Curiosity', href: '#/insights/stats/curiosity' },
      { id: 'infra', label: 'Infra', href: '#/insights/stats/infra' },
      { id: 'hygiene', label: 'Hygiene', href: '#/insights/stats/hygiene' },
      { id: 'karma', label: 'Karma', href: '#/insights/karma' },
      { id: 'activity', label: 'Activity', href: '#/insights/activity' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    href: '#/settings',
    tabs: [
      { id: 'settings', label: 'Settings', href: '#/settings', admin: true },
      { id: 'integrations', label: 'Integrations', href: '#/settings/integrations', admin: true },
      {
        id: 'templates',
        label: 'Templates',
        href: '#/settings/baas/templates',
        baas: true,
        admin: true,
      },
      {
        id: 'customizations',
        label: 'Customizations',
        href: '#/settings/baas/customizations',
        baas: true,
      },
      { id: 'webhooks', label: 'Webhooks', href: '#/settings/baas/webhooks', baas: true },
      { id: 'analytics', label: 'Analytics', href: '#/settings/baas/analytics', baas: true },
      { id: 'tenants', label: 'Tenants', href: '#/settings/baas/tenants', baas: true, admin: true },
    ],
  },
];

const dec = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const one = (m) => [m[1]];
const two = (m) => [m[1], m[2]];
const oneDecoded = (m) => [dec(m[1])];
const none = () => [];
/** `[bot]` from the hash's query string (`#/needs?bot=<id>`), null when absent. */
const botQuery = (m) => {
  const input = String(m.input ?? '');
  const q = input.includes('?') ? input.slice(input.indexOf('?') + 1) : '';
  return [new URLSearchParams(q).get('bot') || null];
};

/** Canonical routes. Order matters: more specific patterns first. */
export const ROUTES = [
  { pattern: /^#\/$/, handler: 'fleetHome', area: 'home', args: none },
  { pattern: /^#\/board$/, handler: 'fleetBoard', area: 'home', args: none },
  { pattern: /^#\/board\/([^/]+)$/, handler: 'fleetBoard', area: 'home', args: one },

  // Literal `new` must precede the `:id` patterns (an agent cannot be named "new").
  { pattern: /^#\/agents\/new$/, handler: 'agentWizard', area: 'agents', args: none },
  { pattern: /^#\/agents\/([^/]+)\/edit$/, handler: 'agentEdit', area: 'agents', args: one },
  { pattern: /^#\/agents\/([^/]+)\/config$/, handler: 'agentDetail', area: 'agents', args: one },
  { pattern: /^#\/agents\/([^/]+)$/, handler: 'agentHome', area: 'agents', args: one },
  { pattern: /^#\/agents$/, handler: 'agents', area: 'agents', args: none },

  {
    pattern: /^#\/needs\/inbox\/([^/]+)\/([^/]+)$/,
    handler: 'inboxChat',
    area: 'needs',
    args: two,
  },
  { pattern: /^#\/needs\/inbox$/, handler: 'inbox', area: 'needs', args: none },
  { pattern: /^#\/needs\/permissions$/, handler: 'permissions', area: 'needs', args: none },
  { pattern: /^#\/needs\/proposals$/, handler: 'agentProposals', area: 'needs', args: none },
  {
    pattern: /^#\/needs\/feedback\/([^/]+)$/,
    handler: 'botFeedback',
    area: 'needs',
    args: one,
  },
  { pattern: /^#\/needs\/feedback$/, handler: 'feedback', area: 'needs', args: none },
  { pattern: /^#\/needs(?:\?|$)/, handler: 'needsYou', area: 'needs', args: botQuery },

  {
    pattern: /^#\/work\/productions\/([^/?]+)(?:\?|$)/,
    handler: 'botProductions',
    area: 'work',
    args: one,
  },
  { pattern: /^#\/work\/productions(?:\?|$)/, handler: 'productions', area: 'work', args: none },
  {
    pattern: /^#\/work\/conversations\/([^/]+)\/([^/]+)$/,
    handler: 'conversationChat',
    area: 'work',
    args: two,
  },
  {
    pattern: /^#\/work\/conversations\/([^/]+)$/,
    handler: 'botConversations',
    area: 'work',
    args: one,
  },
  { pattern: /^#\/work\/conversations$/, handler: 'conversations', area: 'work', args: none },
  {
    pattern: /^#\/work\/sessions\/(.+)$/,
    handler: 'sessionTranscript',
    area: 'work',
    args: oneDecoded,
  },
  { pattern: /^#\/work\/sessions$/, handler: 'sessions', area: 'work', args: none },
  { pattern: /^#\/work\/dispatches$/, handler: 'dispatches', area: 'work', args: none },
  { pattern: /^#\/work$/, handler: 'work', area: 'work', args: none },

  {
    pattern: /^#\/automations\/cron\/new$/,
    handler: 'cronCreate',
    area: 'automations',
    args: none,
  },
  {
    pattern: /^#\/automations\/cron\/([^/]+)$/,
    handler: 'cronDetail',
    area: 'automations',
    args: one,
  },
  { pattern: /^#\/automations\/cron$/, handler: 'cron', area: 'automations', args: none },
  {
    pattern: /^#\/automations\/skills\/new$/,
    handler: 'skillCreate',
    area: 'automations',
    args: none,
  },
  {
    pattern: /^#\/automations\/skills\/([^/]+)\/edit$/,
    handler: 'skillEdit',
    area: 'automations',
    args: oneDecoded,
  },
  {
    pattern: /^#\/automations\/skills\/([^/]+)$/,
    handler: 'skillDetail',
    area: 'automations',
    args: oneDecoded,
  },
  { pattern: /^#\/automations\/skills$/, handler: 'skills', area: 'automations', args: none },
  { pattern: /^#\/automations\/loop$/, handler: 'loop', area: 'automations', args: none },
  {
    pattern: /^#\/automations\/tools\/([^/]+)$/,
    handler: 'toolDetail',
    area: 'automations',
    args: one,
  },
  { pattern: /^#\/automations\/tools$/, handler: 'tools', area: 'automations', args: none },
  { pattern: /^#\/automations$/, handler: 'cron', area: 'automations', args: none },

  {
    pattern: /^#\/insights\/stats\/bot\/([^/]+)$/,
    handler: 'statsBot',
    area: 'insights',
    args: oneDecoded,
  },
  {
    pattern: /^#\/insights\/stats\/behaviour$/,
    handler: 'statsBehaviour',
    area: 'insights',
    args: none,
  },
  {
    pattern: /^#\/insights\/stats\/curiosity$/,
    handler: 'statsCuriosity',
    area: 'insights',
    args: none,
  },
  { pattern: /^#\/insights\/stats\/infra$/, handler: 'statsInfra', area: 'insights', args: none },
  {
    pattern: /^#\/insights\/stats\/hygiene$/,
    handler: 'statsHygiene',
    area: 'insights',
    args: none,
  },
  { pattern: /^#\/insights\/stats$/, handler: 'stats', area: 'insights', args: none },
  { pattern: /^#\/insights\/karma\/([^/]+)$/, handler: 'botKarma', area: 'insights', args: one },
  { pattern: /^#\/insights\/karma$/, handler: 'karma', area: 'insights', args: none },
  { pattern: /^#\/insights\/activity(?:\?|$)/, handler: 'activity', area: 'insights', args: none },
  { pattern: /^#\/insights$/, handler: 'stats', area: 'insights', args: none },

  {
    pattern: /^#\/settings\/baas\/templates\/([^/]+)$/,
    handler: 'baasTemplateDetail',
    area: 'settings',
    args: oneDecoded,
  },
  {
    pattern: /^#\/settings\/baas\/templates$/,
    handler: 'baasTemplates',
    area: 'settings',
    args: none,
  },
  {
    pattern: /^#\/settings\/baas\/webhooks$/,
    handler: 'baasWebhooks',
    area: 'settings',
    args: none,
  },
  {
    pattern: /^#\/settings\/baas\/customizations$/,
    handler: 'baasCustomizations',
    area: 'settings',
    args: none,
  },
  {
    pattern: /^#\/settings\/baas\/analytics$/,
    handler: 'baasAnalytics',
    area: 'settings',
    args: none,
  },
  { pattern: /^#\/settings\/baas\/tenants$/, handler: 'baasTenants', area: 'settings', args: none },
  {
    pattern: /^#\/settings\/integrations$/,
    handler: 'integrations',
    area: 'settings',
    args: none,
  },
  { pattern: /^#\/settings$/, handler: 'settings', area: 'settings', args: none },
];

/**
 * Legacy hash -> canonical hash. Each `from` is anchored at the start and
 * stops at a segment boundary (`/`, `?` or end), so `#/statsx` is left alone
 * and `#/productions/b1?path=x` keeps its tail.
 */
export const REDIRECTS = [
  { from: /^#\/inbox(?=[/?]|$)/, to: '#/needs/inbox' },
  { from: /^#\/permissions(?=[/?]|$)/, to: '#/needs/permissions' },
  { from: /^#\/agent-proposals(?=[/?]|$)/, to: '#/needs/proposals' },
  { from: /^#\/dispatches(?=[/?]|$)/, to: '#/work/dispatches' },
  { from: /^#\/productions(?=[/?]|$)/, to: '#/work/productions' },
  { from: /^#\/conversations(?=[/?]|$)/, to: '#/work/conversations' },
  { from: /^#\/sessions(?=[/?]|$)/, to: '#/work/sessions' },
  { from: /^#\/cron(?=[/?]|$)/, to: '#/automations/cron' },
  { from: /^#\/skills(?=[/?]|$)/, to: '#/automations/skills' },
  { from: /^#\/tool-runner(?=[/?]|$)/, to: '#/automations/tools' },
  { from: /^#\/automations\/tool-runner(?=[/?]|$)/, to: '#/automations/tools' },
  { from: /^#\/tools(?=[/?]|$)/, to: '#/automations/tools' },
  { from: /^#\/stats(?=[/?]|$)/, to: '#/insights/stats' },
  { from: /^#\/karma(?=[/?]|$)/, to: '#/insights/karma' },
  { from: /^#\/feedback(?=[/?]|$)/, to: '#/needs/feedback' },
  { from: /^#\/insights\/feedback(?=[/?]|$)/, to: '#/needs/feedback' },
  { from: /^#\/logs(?=[/?]|$)/, to: '#/insights/activity?tab=logs' },
  { from: /^#\/activity(?=[/?]|$)/, to: '#/insights/activity' },
  { from: /^#\/dashboard(?=[/?]|$)/, to: '#/automations/loop' },
  { from: /^#\/insights\/loop(?=[/?]|$)/, to: '#/automations/loop' },
  { from: /^#\/integrations(?=[/?]|$)/, to: '#/settings/integrations' },
  { from: /^#\/baas(?=[/?]|$)/, to: '#/settings/baas' },
];

/** Canonical hash for a legacy one, or null when nothing applies. */
export function resolveRedirect(hash) {
  const h = String(hash ?? '');
  for (const r of REDIRECTS) {
    if (r.from.test(h)) return h.replace(r.from, r.to);
  }
  return null;
}

/** The hash the router should render: empty / bare "#" -> "#/", legacy -> canonical. */
export function resolveHash(hash) {
  const h = String(hash ?? '');
  if (h === '' || h === '#') return '#/';
  return resolveRedirect(h) ?? h;
}

/** `{ route, m, args }` for a canonical hash, or null. */
export function matchRoute(hash) {
  const h = String(hash ?? '');
  for (const route of ROUTES) {
    const m = h.match(route.pattern);
    if (m) return { route, m, args: route.args(m) };
  }
  return null;
}

export function areaFor(hash) {
  return matchRoute(hash)?.route.area ?? null;
}

function canSee(tab, ctx = {}) {
  if (tab.admin && ctx.role === 'tenant') return false;
  if (tab.baas && !ctx.multiTenant) return false;
  return true;
}

export function visibleTabs(area, ctx = {}) {
  if (!area || !Array.isArray(area.tabs)) return [];
  return area.tabs.filter((t) => canSee(t, ctx));
}

export function visibleAreas(ctx = {}) {
  return AREAS.filter((a) => a.tabs.length === 0 || visibleTabs(a, ctx).length > 0);
}

/** Where the sidebar link for an area goes: its first visible tab, or its own href. */
export function areaHref(area, ctx = {}) {
  if (!area) return '#/';
  const first = visibleTabs(area, ctx)[0];
  return first ? first.href : area.href;
}

function hashMatchesTab(hash, tab) {
  return hash === tab.href || hash.startsWith(`${tab.href}/`) || hash.startsWith(`${tab.href}?`);
}

/** The area tab that owns `hash` (longest href wins); the first tab for the area root. */
export function activeTab(area, hash) {
  if (!area || area.tabs.length === 0) return null;
  const h = String(hash ?? '');
  const hits = area.tabs.filter((t) => hashMatchesTab(h, t));
  if (hits.length > 0) return hits.sort((a, b) => b.href.length - a.href.length)[0];
  if (h === area.href || h.startsWith(`${area.href}/`) || h.startsWith(`${area.href}?`)) {
    return area.tabs[0];
  }
  return null;
}

/**
 * The "Needs You" sidebar count: everything waiting on a human. Since S5 the
 * server computes it (`GET /api/needs-you/count` -> `badges.needs`, which
 * also counts unreviewed outputs and feedback replies); the sum of the three
 * legacy counters is the fallback while that request is in flight or failing.
 */
export function needsBadgeCount(badges) {
  const b = badges ?? {};
  if (b.needs !== undefined && b.needs !== null && Number.isFinite(Number(b.needs))) {
    return Number(b.needs);
  }
  return (
    (Number(b.askHuman) || 0) + (Number(b.askPermission) || 0) + (Number(b.agentProposals) || 0)
  );
}

/**
 * Badge counts from `GET /api/needs-you/count` (`{ count, byKind }`) in the
 * keys the tab strip reads, so one request feeds both the sidebar and the
 * tabs. null when the response is missing or malformed (the caller then
 * falls back to `/api/dashboard/badges`).
 */
export function badgesFromNeedsCount(res) {
  if (!res || typeof res !== 'object' || res.error) return null;
  const count = Number(res.count);
  if (res.count === undefined || res.count === null || !Number.isFinite(count)) return null;
  const k = res.byKind ?? {};
  const n = (v) => Number(v) || 0;
  return {
    needs: count,
    askHuman: n(k.ask),
    askPermission: n(k.permission),
    agentProposals: n(k.proposal),
    agentFeedback: n(k.feedback),
  };
}

/** The view for a hash no route matches: what was asked for, a way home, the palette. */
export function notFoundMarkup(hash) {
  return `<div class="not-found">
  <div class="page-title">Page not found</div>
  <p class="text-dim">Nothing lives at <code>${esc(String(hash ?? ''))}</code>.</p>
  <div class="not-found-actions">
    <a class="btn btn-primary" href="#/">Go to Home</a>
    <button type="button" class="btn" data-palette-open>Search pages <kbd>Ctrl</kbd><kbd>K</kbd></button>
  </div>
</div>`;
}

function badgeSpan(id, count) {
  const n = Number(count) || 0;
  return n > 0
    ? `<span class="inbox-badge" id="${id}">${n}</span>`
    : `<span class="inbox-badge" id="${id}" hidden></span>`;
}

/** Sidebar links for the areas the viewer can use; the one owning `hash` is active. */
export function sidebarLinks(hash, ctx = {}, badges = {}) {
  const current = areaFor(hash);
  return visibleAreas(ctx)
    .map((a) => {
      const cls = a.id === current ? 'nav-link active' : 'nav-link';
      const badge =
        a.badge === 'needs' ? ` ${badgeSpan('needs-badge', needsBadgeCount(badges))}` : '';
      return `<a class="${cls}" href="${esc(areaHref(a, ctx))}" data-area="${esc(a.id)}">${esc(
        a.label
      )}${badge}</a>`;
    })
    .join('');
}

/** Tab strip for the area owning `hash`; '' when the area has no sub-navigation. */
export function areaNav(hash, ctx = {}, badges = {}) {
  const id = areaFor(hash);
  const area = AREAS.find((a) => a.id === id);
  if (!area || area.tabs.length === 0) return '';
  const items = visibleTabs(area, ctx).map((t) => ({
    id: t.id,
    label: t.label,
    href: t.href,
    badge:
      t.badge === 'needs' ? needsBadgeCount(badges) : t.badge ? Number(badges?.[t.badge]) || 0 : 0,
  }));
  if (items.length === 0) return '';
  return tabs(items, activeTab(area, hash)?.id, { class: 'area-tabs' });
}
