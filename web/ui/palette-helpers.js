/**
 * Command palette — the pure half (session S8 of docs/plans/jarvis-fleet-plan.md).
 *
 * Match scoring, ranking with a stable tie-break, the item builders over the
 * nav model (`web/nav-routes.js`) and the agents list, the list markup and
 * the key predicates. `web/ui/palette.js` owns the DOM. Deliberately NOT
 * re-exported from `web/ui/index.js`: nav-routes imports that barrel, and
 * this module imports nav-routes. Tests: tests/web/palette-helpers.test.ts.
 */
import { AREAS, areaHref, visibleTabs } from '../nav-routes.js';
import { rerunSummary } from '../pages/cron-list-helpers.js';
import { summarizeBulk } from '../pages/needs-you-helpers.js';
import { esc } from './escape.js';

/** Age cutoff of the palette's "Clear stale needs" action. */
export const STALE_HOURS = 72;

export const PALETTE_LIMIT = 12;
export const RECENTS_MAX = 6;
export const RECENTS_KEY = 'aibot.palette.recents';
export const KIND_LABEL = { agent: 'Agent', page: 'Page', action: 'Action' };

const SCORE = { exact: 100, prefix: 90, word: 80, substring: 65 };
const FUZZY_BASE = 20;
const FUZZY_SPAN = 30;
const SECONDARY_WEIGHT = 0.85;

/**
 * 0..100 for how well `query` matches `text`: exact > prefix > a word starts
 * with it > substring > fuzzy subsequence (denser is better) > nothing.
 */
export function matchScore(query, text) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  const t = String(text ?? '').toLowerCase();
  if (!q || !t) return 0;
  if (t === q) return SCORE.exact;
  if (t.startsWith(q)) return SCORE.prefix;
  if (t.split(/[\s›/:_\-.]+/).some((w) => w.startsWith(q))) return SCORE.word;
  if (t.includes(q)) return SCORE.substring;
  // Subsequence: every query char in order; score by how tight the span is.
  let pos = -1;
  let first = -1;
  for (const ch of q) {
    pos = t.indexOf(ch, pos + 1);
    if (pos < 0) return 0;
    if (first < 0) first = pos;
  }
  const span = pos - first + 1;
  return Math.round(FUZZY_BASE + FUZZY_SPAN * Math.min(1, q.length / span));
}

function scoreItem(item, query) {
  const label = matchScore(query, item.label);
  const hint = matchScore(query, item.hint) * SECONDARY_WEIGHT;
  const keywords = Array.isArray(item.keywords)
    ? Math.max(0, ...item.keywords.map((k) => matchScore(query, k) * SECONDARY_WEIGHT))
    : 0;
  return Math.max(label, hint, keywords);
}

/**
 * Ranked items for a query. Empty query: the recents (by id, most recent
 * first) then the pages, in their given order. Ties keep the input order
 * (`item.index`, else array position), so the same query always lists the
 * same way.
 */
export function rankItems(items, query, { recents = [], limit = PALETTE_LIMIT } = {}) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query ?? '').trim();
  if (!q) {
    const byId = new Map(list.map((it) => [it.id, it]));
    const out = [];
    const seen = new Set();
    for (const id of Array.isArray(recents) ? recents : []) {
      const it = byId.get(id);
      if (it && !seen.has(id)) {
        out.push(it);
        seen.add(id);
      }
    }
    for (const it of list) {
      if (it.kind === 'page' && !seen.has(it.id)) {
        out.push(it);
        seen.add(it.id);
      }
    }
    return out.slice(0, limit);
  }
  return list
    .map((it, i) => ({
      it,
      score: scoreItem(it, q),
      order: Number.isFinite(it.index) ? it.index : i,
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((r) => r.it);
}

/** One item per agent: name and id searchable, Enter opens the Agent Home. */
export function buildAgentItems(agents) {
  return (Array.isArray(agents) ? agents : []).map((a) => ({
    id: `agent:${a.id}`,
    kind: 'agent',
    label: a.name || a.id,
    hint: a.id,
    keywords: [a.id],
    href: `#/agents/${encodeURIComponent(a.id)}`,
  }));
}

/**
 * One item per visible tab ("Area › Tab") and per tab-less area ("Home",
 * "Agents"), deduped by href. Same visibility rules as the sidebar.
 */
export function buildPageItems(ctx = {}, areas = AREAS) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (seen.has(item.href)) return;
    seen.add(item.href);
    out.push(item);
  };
  for (const area of Array.isArray(areas) ? areas : []) {
    const tabs = visibleTabs(area, ctx);
    if (area.tabs.length === 0) {
      push({
        id: `page:${area.href}`,
        kind: 'page',
        label: area.label,
        hint: area.href,
        keywords: [area.id],
        href: areaHref(area, ctx),
      });
      continue;
    }
    for (const tab of tabs) {
      push({
        id: `page:${tab.href}`,
        kind: 'page',
        label: `${area.label} › ${tab.label}`,
        hint: tab.href,
        keywords: [tab.id, area.id],
        href: tab.href,
      });
    }
  }
  return out;
}

/**
 * Actions: start / stop / run now / open config per agent, plus new agent,
 * Needs You and the theme switch. `api` items are POSTed by the palette,
 * `href` items navigate, `theme` toggles.
 */
export function buildActionItems(agents, { theme = 'dark' } = {}) {
  const out = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    const name = a.name || a.id;
    const id = encodeURIComponent(a.id);
    if (a.running) {
      out.push({
        id: `action:stop:${a.id}`,
        kind: 'action',
        label: `Stop ${name}`,
        hint: a.id,
        api: { path: `/api/agents/${id}/stop`, method: 'POST' },
      });
      out.push({
        id: `action:run:${a.id}`,
        kind: 'action',
        label: `Run ${name} now`,
        hint: a.id,
        api: { path: `/api/agent-loop/run/${id}`, method: 'POST' },
      });
    } else {
      out.push({
        id: `action:start:${a.id}`,
        kind: 'action',
        label: `Start ${name}`,
        hint: a.id,
        api: {
          path: `/api/agents/${id}/start${a.enabled === false ? '?enable=true' : ''}`,
          method: 'POST',
        },
      });
    }
    out.push({
      id: `action:config:${a.id}`,
      kind: 'action',
      label: `Open ${name} config`,
      hint: a.id,
      href: `#/agents/${id}/config`,
    });
    out.push({
      id: `action:stats:${a.id}`,
      kind: 'action',
      label: `${name} stats`,
      hint: a.id,
      keywords: ['stats', 'insights'],
      href: `#/insights/stats/bot/${id}`,
    });
    out.push({
      id: `action:karma:${a.id}`,
      kind: 'action',
      label: `${name} karma`,
      hint: a.id,
      keywords: ['karma', 'score'],
      href: `#/insights/karma/${id}`,
    });
    out.push({
      id: `action:logs:${a.id}`,
      kind: 'action',
      label: `${name} logs`,
      hint: a.id,
      keywords: ['logs', 'activity'],
      href: `#/insights/activity?tab=logs&bot=${id}`,
    });
  }
  out.push({
    id: 'action:new-agent',
    kind: 'action',
    label: 'New agent',
    hint: 'Agents',
    keywords: ['create', 'wizard'],
    href: '#/agents/new',
  });
  out.push({
    id: 'action:needs',
    kind: 'action',
    label: 'Open Needs You',
    hint: 'Queue',
    keywords: ['inbox', 'asks', 'queue'],
    href: '#/needs',
  });
  out.push({
    id: 'action:clear-stale',
    kind: 'action',
    label: `Clear stale needs (older than ${STALE_HOURS}h)`,
    hint: 'Needs You',
    keywords: ['clear', 'stale', 'dismiss', 'queue'],
    api: {
      path: '/api/needs-you/clear-stale',
      method: 'POST',
      body: { olderThanHours: STALE_HOURS },
    },
    confirm: {
      title: `Clear everything older than ${STALE_HOURS} h?`,
      message:
        'Questions are dismissed, permissions denied, proposals rejected, outputs archived (no karma) and feedback replies closed. Nothing is approved; pending tools are left alone.',
      confirmLabel: 'Clear stale',
    },
    summary: 'clear-stale',
  });
  out.push({
    id: 'action:new-cron',
    kind: 'action',
    label: 'New cron job',
    hint: 'Automations',
    keywords: ['cron', 'schedule', 'create', 'job'],
    href: '#/automations/cron/new',
  });
  out.push({
    id: 'action:run-loop',
    kind: 'action',
    label: 'Run agent loop now',
    hint: 'Automations',
    keywords: ['loop', 'run', 'agents'],
    api: { path: '/api/agent-loop/run', method: 'POST' },
  });
  out.push({
    id: 'action:rerun-crons',
    kind: 'action',
    label: 'Re-run failed crons',
    hint: 'Automations',
    keywords: ['cron', 'retry', 'failed'],
    api: { path: '/api/cron/rerun-failed', method: 'POST' },
    summary: 'cron-rerun',
  });
  out.push({
    id: 'action:theme',
    kind: 'action',
    label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`,
    hint: 'Theme',
    keywords: ['theme', 'light', 'dark'],
    theme: true,
  });
  return out;
}

/** Agents, pages, actions — with `index` stamped for the stable tie-break. */
export function buildItems({ agents = [], ctx = {}, theme = 'dark' } = {}) {
  return [
    ...buildAgentItems(agents),
    ...buildPageItems(ctx),
    ...buildActionItems(agents, { theme }),
  ].map((it, index) => ({ ...it, index }));
}

/** `{ text, tone }` for the toast after an `api` action resolved with `res`. */
export function actionResultToast(item, res) {
  if (item?.summary === 'cron-rerun') return rerunSummary(res);
  if (res?.error) return { text: String(res.error), tone: 'danger' };
  if (item?.summary === 'clear-stale') {
    const list = Array.isArray(res?.results) ? res.results : [];
    if (list.length === 0) return { text: `Nothing older than ${STALE_HOURS} h`, tone: 'muted' };
    const sum = summarizeBulk(list, 'Cleared');
    return { text: sum.text, tone: sum.failed > 0 ? 'warn' : 'ok' };
  }
  return { text: item?.label ?? 'Done', tone: 'ok' };
}

export function moveIndex(i, delta, n) {
  if (!n) return 0;
  return (((i + delta) % n) + n) % n;
}

export function pushRecent(recents, id, max = RECENTS_MAX) {
  const list = Array.isArray(recents) ? recents.filter((r) => r !== id) : [];
  return [id, ...list].slice(0, max);
}

/** Ctrl+K or Cmd+K, without Alt/Shift. */
export function isPaletteHotkey(e) {
  if (!e || String(e.key).toLowerCase() !== 'k') return false;
  if (e.altKey || e.shiftKey) return false;
  return Boolean(e.ctrlKey || e.metaKey);
}

export function isEditableTarget(el) {
  if (!el) return false;
  const tag = String(el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** The result list. */
export function paletteMarkup(items, activeIndex, { query = '' } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return `<div class="ui-palette-empty">${
      String(query).trim() ? 'No matches' : 'Type to search agents, pages and actions'
    }</div>`;
  }
  const rows = list
    .map((it, i) => {
      const active = i === activeIndex;
      return `<li class="ui-palette-row${active ? ' active' : ''}" role="option" aria-selected="${
        active ? 'true' : 'false'
      }" data-index="${i}" data-id="${esc(it.id)}"><span class="ui-palette-kind ui-palette-kind-${esc(
        it.kind
      )}">${esc(KIND_LABEL[it.kind] ?? it.kind)}</span><span class="ui-palette-label">${esc(
        it.label
      )}</span>${it.hint ? `<span class="ui-palette-hint">${esc(it.hint)}</span>` : ''}</li>`;
    })
    .join('');
  return `<ul class="ui-palette-rows" role="listbox">${rows}</ul>`;
}

/** The dialog: backdrop, input, list slot, key hints. */
export function paletteShell() {
  return `<div class="ui-palette-backdrop" data-palette-close></div>
<div class="ui-palette" role="dialog" aria-modal="true" aria-label="Command palette">
  <input id="ui-palette-input" class="ui-palette-input" type="text" placeholder="Jump to an agent, a page or an action…" autocomplete="off" spellcheck="false" aria-controls="ui-palette-list" aria-autocomplete="list">
  <div id="ui-palette-list" class="ui-palette-list"></div>
  <div class="ui-palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
</div>`;
}
