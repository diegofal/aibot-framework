import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AREAS,
  REDIRECTS,
  ROUTES,
  activeTab,
  areaFor,
  areaHref,
  areaNav,
  matchRoute,
  needsBadgeCount,
  resolveHash,
  resolveRedirect,
  sidebarLinks,
  visibleAreas,
  visibleTabs,
} from '../../web/nav-routes.js';

const ADMIN = { multiTenant: true, role: 'admin' };
const TENANT = { multiTenant: true, role: 'tenant' };
const SINGLE = { multiTenant: false, role: undefined };

/** Every hash the dashboard ever linked to, with the page it must land on. */
const LEGACY: Array<[string, string, string]> = [
  // [old hash, expected canonical hash, expected handler]
  ['#/', '#/', 'fleetHome'],
  ['#/needs', '#/needs', 'needsYou'],
  ['#/needs/feedback', '#/needs/feedback', 'feedback'],
  ['#/needs/feedback/b1', '#/needs/feedback/b1', 'botFeedback'],
  ['#/inbox', '#/needs/inbox', 'inbox'],
  ['#/inbox/b1/c9', '#/needs/inbox/b1/c9', 'inboxChat'],
  ['#/permissions', '#/needs/permissions', 'permissions'],
  ['#/agent-proposals', '#/needs/proposals', 'agentProposals'],
  ['#/agents', '#/agents', 'agents'],
  ['#/agents/new', '#/agents/new', 'agentWizard'],
  ['#/agents/b1', '#/agents/b1', 'agentHome'],
  ['#/agents/b1/config', '#/agents/b1/config', 'agentDetail'],
  ['#/agents/b1/edit', '#/agents/b1/edit', 'agentEdit'],
  ['#/stats', '#/insights/stats', 'stats'],
  ['#/stats/bot/job%20seeker', '#/insights/stats/bot/job%20seeker', 'statsBot'],
  ['#/stats/behaviour', '#/insights/stats/behaviour', 'statsBehaviour'],
  ['#/stats/infra', '#/insights/stats/infra', 'statsInfra'],
  ['#/stats/hygiene', '#/insights/stats/hygiene', 'statsHygiene'],
  ['#/sessions', '#/work/sessions', 'sessions'],
  ['#/sessions/b1%2Fchat', '#/work/sessions/b1%2Fchat', 'sessionTranscript'],
  ['#/cron', '#/automations/cron', 'cron'],
  ['#/cron/new', '#/automations/cron/new', 'cronCreate'],
  ['#/cron/job-1', '#/automations/cron/job-1', 'cronDetail'],
  ['#/conversations', '#/work/conversations', 'conversations'],
  ['#/conversations/b1', '#/work/conversations/b1', 'botConversations'],
  ['#/conversations/b1/c2', '#/work/conversations/b1/c2', 'conversationChat'],
  ['#/productions', '#/work/productions', 'productions'],
  ['#/productions?tab=x', '#/work/productions?tab=x', 'productions'],
  ['#/productions/b1', '#/work/productions/b1', 'botProductions'],
  ['#/productions/b1?path=a.md', '#/work/productions/b1?path=a.md', 'botProductions'],
  ['#/feedback', '#/insights/feedback', 'feedback'],
  ['#/feedback/b1', '#/insights/feedback/b1', 'botFeedback'],
  ['#/karma', '#/insights/karma', 'karma'],
  ['#/karma/b1', '#/insights/karma/b1', 'botKarma'],
  ['#/skills', '#/automations/skills', 'skills'],
  ['#/skills/new', '#/automations/skills/new', 'skillCreate'],
  ['#/skills/my%20skill', '#/automations/skills/my%20skill', 'skillDetail'],
  ['#/skills/my%20skill/edit', '#/automations/skills/my%20skill/edit', 'skillEdit'],
  ['#/tool-runner', '#/automations/tool-runner', 'toolRunner'],
  ['#/tools', '#/automations/tools', 'tools'],
  ['#/tools/web_search', '#/automations/tools/web_search', 'toolDetail'],
  ['#/activity', '#/insights/activity', 'activity'],
  ['#/activity?tab=llm', '#/insights/activity?tab=llm', 'activity'],
  ['#/logs', '#/insights/activity?tab=logs', 'activity'],
  ['#/integrations', '#/settings/integrations', 'integrations'],
  ['#/settings', '#/settings', 'settings'],
  ['#/baas/templates', '#/settings/baas/templates', 'baasTemplates'],
  ['#/baas/templates/t%201', '#/settings/baas/templates/t%201', 'baasTemplateDetail'],
  ['#/baas/webhooks', '#/settings/baas/webhooks', 'baasWebhooks'],
  ['#/baas/customizations', '#/settings/baas/customizations', 'baasCustomizations'],
  ['#/baas/analytics', '#/settings/baas/analytics', 'baasAnalytics'],
  ['#/baas/tenants', '#/settings/baas/tenants', 'baasTenants'],
  ['#/dashboard', '#/insights/loop', 'loop'],
];

describe('resolveRedirect / resolveHash', () => {
  it('maps every legacy hash to its canonical hash and a handler', () => {
    for (const [old, canonical, handler] of LEGACY) {
      const resolved = resolveHash(old);
      expect([old, resolved]).toEqual([old, canonical]);
      const hit = matchRoute(resolved);
      expect([old, hit?.route.handler]).toEqual([old, handler]);
    }
  });

  it('returns null for hashes that are already canonical', () => {
    expect(resolveRedirect('#/work/productions')).toBeNull();
    expect(resolveRedirect('#/insights/stats/bot/b1')).toBeNull();
    expect(resolveRedirect('#/agents/b1')).toBeNull();
  });

  it('does not touch look-alike prefixes', () => {
    // "#/statsx" is not "#/stats"; "#/toolsmith" is not "#/tools".
    expect(resolveRedirect('#/statsx')).toBeNull();
    expect(resolveRedirect('#/toolsmith')).toBeNull();
  });

  it('preserves query strings and decodes nothing', () => {
    expect(resolveHash('#/productions/b1?path=a%20b.md')).toBe(
      '#/work/productions/b1?path=a%20b.md'
    );
  });

  it('resolves the bare "#" and unknown hashes to the fleet home', () => {
    expect(resolveHash('#')).toBe('#/');
    expect(resolveHash('')).toBe('#/');
    expect(matchRoute('#/definitely/not/a/page')).toBeNull();
  });

  it('every redirect target is itself routable', () => {
    for (const [old] of LEGACY) {
      const target = resolveHash(old);
      expect(resolveRedirect(target)).toBeNull();
      expect(matchRoute(target)).not.toBeNull();
    }
    expect(REDIRECTS.length).toBeGreaterThan(10);
  });
});

describe('matchRoute args', () => {
  it('decodes the params the page handlers expect', () => {
    expect(matchRoute('#/insights/stats/bot/job%20seeker')?.args).toEqual(['job seeker']);
    expect(matchRoute('#/work/sessions/b1%2Fchat')?.args).toEqual(['b1/chat']);
    expect(matchRoute('#/needs/inbox/b1/c9')?.args).toEqual(['b1', 'c9']);
    expect(matchRoute('#/work/productions/b1?path=x')?.args).toEqual(['b1']);
    expect(matchRoute('#/automations/skills/my%20skill/edit')?.args).toEqual(['my skill']);
    expect(matchRoute('#/')?.args).toEqual([]);
  });

  it('every route handler name exists in app.js', () => {
    const src = readFileSync(join(import.meta.dir, '../../web/app.js'), 'utf-8');
    const names = new Set(ROUTES.map((r) => r.handler));
    for (const name of names) {
      expect([name, new RegExp(`^\\s+${name}:`, 'm').test(src)]).toEqual([name, true]);
    }
  });
});

describe('areas and visibility', () => {
  it('has exactly the seven areas of the plan, in order', () => {
    expect(AREAS.map((a) => a.id)).toEqual([
      'home',
      'agents',
      'needs',
      'work',
      'automations',
      'insights',
      'settings',
    ]);
    expect(AREAS.map((a) => a.label)).toEqual([
      'Home',
      'Agents',
      'Needs You',
      'Work',
      'Automations',
      'Insights',
      'Settings',
    ]);
  });

  it('every route belongs to a known area', () => {
    const ids = new Set(AREAS.map((a) => a.id));
    for (const r of ROUTES) expect([r.handler, ids.has(r.area)]).toEqual([r.handler, true]);
  });

  it('areaFor follows the canonical hash', () => {
    expect(areaFor('#/')).toBe('home');
    expect(areaFor('#/agents/b1/config')).toBe('agents');
    expect(areaFor('#/needs/permissions')).toBe('needs');
    expect(areaFor('#/work/sessions/x')).toBe('work');
    expect(areaFor('#/automations/tool-runner')).toBe('automations');
    expect(areaFor('#/insights/activity?tab=logs')).toBe('insights');
    expect(areaFor('#/settings/baas/tenants')).toBe('settings');
    expect(areaFor('#/nope')).toBeNull();
  });

  it('hides admin tabs from tenants and BaaS tabs outside multi-tenant', () => {
    const auto = AREAS.find((a) => a.id === 'automations');
    expect(visibleTabs(auto, ADMIN).map((t) => t.id)).toEqual([
      'cron',
      'skills',
      'tools',
      'tool-runner',
    ]);
    expect(visibleTabs(auto, TENANT).map((t) => t.id)).toEqual(['cron', 'skills']);

    const settings = AREAS.find((a) => a.id === 'settings');
    expect(visibleTabs(settings, SINGLE).map((t) => t.id)).toEqual(['settings', 'integrations']);
    expect(visibleTabs(settings, ADMIN).map((t) => t.id)).toEqual([
      'settings',
      'integrations',
      'templates',
      'customizations',
      'webhooks',
      'analytics',
      'tenants',
    ]);
    expect(visibleTabs(settings, TENANT).map((t) => t.id)).toEqual([
      'customizations',
      'webhooks',
      'analytics',
    ]);
  });

  it('keeps the Settings area for tenants only through its visible tabs', () => {
    expect(visibleAreas(TENANT).map((a) => a.id)).toEqual([
      'home',
      'agents',
      'needs',
      'work',
      'automations',
      'insights',
      'settings',
    ]);
    const settings = AREAS.find((a) => a.id === 'settings');
    expect(areaHref(settings, ADMIN)).toBe('#/settings');
    expect(areaHref(settings, TENANT)).toBe('#/settings/baas/customizations');
    expect(areaHref(AREAS[0], TENANT)).toBe('#/');
    // A tenant in single-tenant mode cannot happen, but the area must not vanish silently.
    expect(visibleAreas({ multiTenant: false, role: 'tenant' }).map((a) => a.id)).not.toContain(
      'settings'
    );
  });

  it('picks the longest matching tab as active', () => {
    const insights = AREAS.find((a) => a.id === 'insights');
    expect(activeTab(insights, '#/insights/stats')?.id).toBe('stats');
    expect(activeTab(insights, '#/insights/stats/bot/b1')?.id).toBe('stats');
    expect(activeTab(insights, '#/insights/stats/behaviour')?.id).toBe('behaviour');
    expect(activeTab(insights, '#/insights/activity?tab=logs')?.id).toBe('activity');
    expect(activeTab(insights, '#/insights/loop')?.id).toBe('loop');
    expect(activeTab(insights, '#/insights')?.id).toBe('stats');
    const needs = AREAS.find((a) => a.id === 'needs');
    expect(activeTab(needs, '#/needs')?.id).toBe('queue');
    expect(activeTab(needs, '#/needs/feedback/b1')?.id).toBe('feedback');
    expect(activeTab(needs, '#/needs/inbox/b1/c1')?.id).toBe('inbox');
    expect(activeTab(AREAS[0], '#/')).toBeNull();
  });
});

describe('sidebarLinks / areaNav', () => {
  const badges = { askHuman: 2, askPermission: 1, agentProposals: 0, agentFeedback: 4 };

  it('needsBadgeCount sums the human-facing queues only', () => {
    expect(needsBadgeCount(badges)).toBe(3);
    expect(needsBadgeCount({})).toBe(0);
    expect(needsBadgeCount(undefined)).toBe(0);
    // S5: the server-side queue count wins over the legacy sum when present.
    expect(needsBadgeCount({ ...badges, needs: 7 })).toBe(7);
    expect(needsBadgeCount({ ...badges, needs: 0 })).toBe(0);
    expect(needsBadgeCount({ ...badges, needs: null })).toBe(3);
  });

  it('renders one link per visible area with the active one marked', () => {
    const html = sidebarLinks('#/work/productions', ADMIN, badges);
    expect(html.match(/class="nav-link[^"]*"/g)?.length).toBe(7);
    expect(html).toContain('class="nav-link active" href="#/work" data-area="work"');
    expect(html).toContain('data-area="needs"');
    expect(html).toContain('<span class="inbox-badge" id="needs-badge">3</span>');
    expect(html).not.toContain('style="display:none"');
  });

  it('hides the badge at zero and drops areas the viewer cannot use', () => {
    const html = sidebarLinks('#/', { multiTenant: false, role: 'tenant' }, {});
    expect(html).toContain('<span class="inbox-badge" id="needs-badge" hidden></span>');
    expect(html).not.toContain('data-area="settings"');
  });

  it('renders the area tab strip with per-tab badges and nothing for tab-less areas', () => {
    const html = areaNav('#/needs/permissions', ADMIN, badges);
    expect(html).toContain('ui-tabs');
    expect(html).toContain('href="#/needs">Queue<span class="ui-tab-badge">3</span>');
    expect(html).toContain('href="#/needs/inbox">Inbox<span class="ui-tab-badge">2</span>');
    expect(html).toContain('href="#/needs/feedback">Feedback<span class="ui-tab-badge">4</span>');
    expect(html).toContain('class="ui-tab active" href="#/needs/permissions"');
    expect(html).toContain('>Proposals<');
    expect(html).not.toContain('Proposals<span');
    expect(areaNav('#/', ADMIN, badges)).toBe('');
    expect(areaNav('#/agents/b1', ADMIN, badges)).toBe('');
    expect(areaNav('#/nope', ADMIN, badges)).toBe('');
  });

  it('hides admin-only tabs from a tenant in the strip too', () => {
    const html = areaNav('#/automations/cron', TENANT, {});
    expect(html).toContain('>Cron<');
    expect(html).not.toContain('Tool Runner');
  });
});

describe('Work outputs landing (S3.5)', () => {
  it('#/work is its own handler and the first Work tab', () => {
    expect(matchRoute('#/work')?.route.handler).toBe('work');
    expect(matchRoute('#/work/productions')?.route.handler).toBe('productions');
    const work = AREAS.find((a) => a.id === 'work');
    expect(work?.tabs[0]).toEqual({ id: 'outputs', label: 'Outputs', href: '#/work' });
  });
});

describe('Dispatches inbox (curiosity C7)', () => {
  it('#/work/dispatches is a Work tab with its own handler; #/dispatches redirects', () => {
    expect(matchRoute('#/work/dispatches')?.route.handler).toBe('dispatches');
    expect(resolveHash('#/dispatches')).toBe('#/work/dispatches');
    const work = AREAS.find((a) => a.id === 'work');
    expect(work?.tabs.map((t) => t.id)).toContain('dispatches');
  });
});
