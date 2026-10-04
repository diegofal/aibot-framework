/**
 * Fleet Home pieces (session S3 of docs/plans/jarvis-fleet-plan.md).
 *
 * Pure string helpers for the fleet grid and the event ticker so
 * `tests/web/fleet-home-helpers.test.ts` covers them without a DOM. The page
 * (`fleet-home.js`) owns fetching, the live link and DOM updates.
 */
import { avatar, badge, emptyState, esc } from '../ui/index.js';
import { ago, formatNext, postureTone } from './agent-home-helpers.js';

/** Raw events kept for the ticker; condensing turns ~30 events into a handful of lines. */
export const TICKER_LIMIT = 30;
/** Condensed lines shown before "N more". */
export const TICKER_SHOW = 5;
/** Two tool runs of the same agent further apart than this start a new line. */
export const TICKER_GROUP_GAP_MS = 15 * 60_000;
/** Event types that never earn a ticker line on their own. */
export const NOISE_EVENTS = new Set([
  'llm:start',
  'llm:end',
  'memory:rag',
  'memory:flush',
  'compaction',
  'agent:idle',
  'agent:phase',
]);

/** Lower sorts first: what needs eyes, then what is alive, then what sleeps. */
export const POSTURE_ORDER = {
  blocked: 0,
  active: 1,
  standby: 2,
  idle: 3,
  unknown: 4,
  dormant: 5,
};

function presenceOf(map, id) {
  return map?.[id] ?? null;
}

/** Executing first, then posture severity, then name. Never mutates `agents`. */
export function sortFleet(agents, presence = {}) {
  const key = (a) => {
    const p = presenceOf(presence, a.id);
    const order = POSTURE_ORDER[p?.posture] ?? POSTURE_ORDER.unknown;
    return [p?.isExecuting ? 0 : 1, order, String(a.name ?? a.id).toLowerCase()];
  };
  return [...(agents ?? [])]
    .map((a, i) => ({ a, k: key(a), i }))
    .sort((x, y) => {
      for (let j = 0; j < 3; j++) {
        if (x.k[j] < y.k[j]) return -1;
        if (x.k[j] > y.k[j]) return 1;
      }
      return x.i - y.i;
    })
    .map((x) => x.a);
}

/**
 * `needsYou` prefers the server's Needs You count (the same number the
 * sidebar badge shows) when the page passes one; the per-agent sum is the
 * fallback while that request is in flight or failing.
 */
export function fleetSummary(agents = [], presence = {}, { needsYou } = {}) {
  const s = { total: 0, running: 0, executing: 0, blocked: 0, needsYou: 0 };
  for (const a of agents) {
    s.total++;
    const p = presenceOf(presence, a.id);
    if (p ? p.running : a.running) s.running++;
    if (p?.isExecuting) s.executing++;
    if (p?.posture === 'blocked') s.blocked++;
    s.needsYou += (Number(p?.pendingAsks) || 0) + (Number(p?.unreviewed) || 0);
  }
  if (needsYou != null && Number.isFinite(Number(needsYou))) s.needsYou = Number(needsYou);
  return s;
}

function karmaLabel(p) {
  return p && p.karma != null && Number.isFinite(Number(p.karma))
    ? `Karma ${Math.round(Number(p.karma))}`
    : 'Karma —';
}

function outputLabel(p, nowMs) {
  return p?.lastOutputAt ? `Output ${ago(p.lastOutputAt, nowMs)}` : 'No output yet';
}

/**
 * One agent card. `p` is the fleet presence entry (may be missing while
 * loading). `avatarSrc` decorates the uploaded face url (session S4: the page
 * appends the auth token so `<img>` can load it).
 */
export function fleetCard(agent, p, nowMs = Date.now(), { avatarSrc = (u) => u } = {}) {
  const id = String(agent?.id ?? '');
  const name = agent?.name ?? p?.name ?? id;
  const faceUrl = p?.avatarUrl ?? agent?.avatarUrl ?? null;
  const src = faceUrl ? avatarSrc(faceUrl) : undefined;
  const running = p ? p.running : Boolean(agent?.running);
  const enabled = p ? p.enabled : agent?.enabled !== false;
  const posture = p?.posture ?? 'unknown';
  const tone = postureTone(posture);
  const nowTone = p?.tone ?? tone;
  const href = `#/agents/${encodeURIComponent(id)}`;
  const classes = ['fleet-card'];
  if (p?.isExecuting) classes.push('fleet-card-executing');
  if (!running) classes.push('fleet-card-off');
  const state = running ? '' : badge(enabled ? 'stopped' : 'disabled', 'muted');
  const asks = Number(p?.pendingAsks) || 0;
  const review = Number(p?.unreviewed) || 0;
  const needs = [];
  if (asks > 0) {
    needs.push(
      `<a class="fleet-need" href="#/needs?bot=${encodeURIComponent(id)}" title="Open this agent's items in Needs You">${asks} ask${asks === 1 ? '' : 's'}</a>`
    );
  }
  if (review > 0) {
    needs.push(
      `<a class="fleet-need" href="#/work/productions/${encodeURIComponent(id)}">${review} to review</a>`
    );
  }
  const meta = [karmaLabel(p), outputLabel(p, nowMs)];
  if (p?.channel?.kind) meta.push(p.channel.kind);
  if (p && !p.isExecuting) {
    const next = formatNext(p.nextRunAt, nowMs);
    if (next) meta.push(next);
  }
  return `<article class="${classes.join(' ')}" data-bot-id="${esc(id)}">
    <a class="fleet-card-link" href="${href}" aria-label="${esc(name)}">
      <div class="fleet-card-top">
        <span class="fleet-avatar">${avatar({ seed: id, name, src, size: 44, status: tone })}</span>
        <div class="fleet-card-title">
          <span class="fleet-name">${esc(name)}</span>
          <span class="fleet-badges"><span class="fleet-posture">${badge(posture, tone, {
            dot: true,
          })}</span>${state}</span>
        </div>
      </div>
      <div class="fleet-now fleet-now-${esc(nowTone)}">${esc(p?.nowLine ?? 'Loading…')}</div>
      <div class="fleet-meta text-dim">${esc(meta.join(' · '))}</div>
    </a>
    <div class="fleet-needs">${needs.join('')}</div>
    ${fleetQuickActions(agent, p)}
  </article>`;
}

export function fleetGrid(agents = [], presence = {}, nowMs = Date.now(), opts = {}) {
  if (!agents || agents.length === 0) {
    if (opts.filtered) {
      return emptyState({
        icon: '⌕',
        title: 'No agents match',
        hint: 'No agent fits this filter right now.',
        action:
          '<button type="button" class="btn" data-fleet-filter="all" aria-pressed="false">Show all</button>',
      });
    }
    return emptyState({
      icon: '◎',
      title: 'No agents yet',
      hint: 'Create your first agent and it will show up here as soon as it has a pulse.',
      action: '<a class="btn btn-primary" href="#/agents/new">Create an agent</a>',
    });
  }
  return `<div class="fleet-grid">${sortFleet(agents, presence)
    .map((a) => fleetCard(a, presenceOf(presence, a.id), nowMs, opts))
    .join('')}</div>`;
}

// ── Filters, quick actions, error state (UX overhaul phase 5) ────────────────

export const FLEET_FILTER_KEY = 'aibot.fleet.filter';
export const FLEET_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'needs', label: 'Needs you' },
];

function fleetMatches(agent, p, filter) {
  switch (filter) {
    case 'running':
      return p ? Boolean(p.running) : Boolean(agent?.running);
    case 'blocked':
      return p?.posture === 'blocked';
    case 'needs':
      return (Number(p?.pendingAsks) || 0) + (Number(p?.unreviewed) || 0) > 0;
    default:
      return true;
  }
}

/** Agents passing the chip; order preserved. */
export function filterFleet(agents = [], presence = {}, filter = 'all') {
  return (agents ?? []).filter((a) => fleetMatches(a, presenceOf(presence, a.id), filter));
}

export function fleetFilterCounts(agents = [], presence = {}) {
  const c = {};
  for (const f of FLEET_FILTERS) c[f.id] = filterFleet(agents, presence, f.id).length;
  return c;
}

export function readFleetFilter(storage) {
  try {
    const v = storage?.getItem?.(FLEET_FILTER_KEY);
    return FLEET_FILTERS.some((f) => f.id === v) ? v : 'all';
  } catch {
    return 'all';
  }
}

export function writeFleetFilter(storage, filter) {
  try {
    storage?.setItem?.(
      FLEET_FILTER_KEY,
      FLEET_FILTERS.some((f) => f.id === filter) ? filter : 'all'
    );
  } catch {
    /* private mode */
  }
}

export function fleetFilterChips(active = 'all', counts = {}) {
  return `<div class="fleet-chips" role="group" aria-label="Filter agents">${FLEET_FILTERS.map(
    (f) => {
      const on = f.id === active;
      const n = counts[f.id];
      return `<button type="button" class="agents-chip${on ? ' agents-chip-active' : ''}" data-fleet-filter="${f.id}" aria-pressed="${on ? 'true' : 'false'}">${esc(
        f.label
      )}${n != null ? ` <span class="agents-chip-n">${esc(String(n))}</span>` : ''}</button>`;
    }
  ).join('')}</div>`;
}

/**
 * Hover / focus actions on a card. They sit outside the card link; the page
 * delegates `[data-quick]` clicks and stops them from reaching the link.
 */
export function fleetQuickActions(agent, p) {
  const id = esc(String(agent?.id ?? ''));
  const running = p ? Boolean(p.running) : Boolean(agent?.running);
  const enabled = p ? p.enabled !== false : agent?.enabled !== false;
  const btn = (action, label, extra = '') =>
    `<button type="button" class="btn btn-sm${extra}" data-quick="${action}" data-id="${id}">${esc(label)}</button>`;
  const buttons = running
    ? btn('run', 'Run now') + btn('stop', 'Stop', ' btn-danger')
    : enabled
      ? btn('start', 'Start')
      : btn('enable-start', 'Enable & Start');
  return `<div class="fleet-quick" aria-label="Quick actions">${buttons}</div>`;
}

/** The fleet request failed: say so, with Retry — never "No agents yet". */
export function fleetErrorState(message = '') {
  return emptyState({
    icon: '⚠',
    title: 'Could not load the fleet',
    hint: message || 'The server did not answer.',
    action:
      '<button type="button" class="btn btn-primary" data-action="fleet-retry">Retry</button>',
  });
}

// ── Ticker ──────────────────────────────────────────────────────────────────

function botName(ev, names) {
  return names?.[ev?.botId] ?? ev?.botId ?? 'Someone';
}

function phaseWords(phase) {
  return String(phase ?? '')
    .replace(/[:_-]+/g, ' ')
    .trim();
}

/** `{ text, tone }` for one activity event; `names` maps bot id -> display name. */
export function describeEvent(ev, names = {}) {
  if (!ev || typeof ev.type !== 'string') return { text: '', tone: 'muted' };
  const who = botName(ev, names);
  const d = ev.data ?? {};
  const tool = d.toolName ? String(d.toolName) : 'a tool';
  const caller = d.caller ? ` (${d.caller})` : '';
  switch (ev.type) {
    case 'tool:start':
      return { text: `${who} is running ${tool}`, tone: 'info' };
    case 'tool:end':
      return d.success === false
        ? { text: `${who}: ${tool} failed`, tone: 'danger' }
        : { text: `${who} finished ${tool}`, tone: 'ok' };
    case 'tool:error':
      return {
        text: `${who}: ${tool} failed${d.error ? ` — ${String(d.error).slice(0, 80)}` : ''}`,
        tone: 'danger',
      };
    case 'llm:start':
      return { text: `${who} is thinking${caller}`, tone: 'info' };
    case 'llm:end':
      return { text: `${who} got an answer${caller}`, tone: 'muted' };
    case 'llm:error':
      return {
        text: `${who}: LLM call failed${caller}${d.error ? ` — ${String(d.error).slice(0, 80)}` : ''}`,
        tone: 'danger',
      };
    case 'llm:fallback':
      return {
        text: `${who} fell back from ${d.primaryBackend ?? '?'} to ${d.fallbackBackend ?? '?'}`,
        tone: 'warn',
      };
    case 'agent:phase':
      return { text: `${who}: ${phaseWords(ev.phase ?? d.phase) || 'new phase'}`, tone: 'info' };
    case 'agent:idle':
      return { text: `${who} is idle`, tone: 'muted' };
    case 'agent:result':
      return { text: `${who} finished a cycle`, tone: 'ok' };
    case 'memory:flush':
      return { text: `${who} saved memory`, tone: 'muted' };
    case 'memory:rag':
      return { text: `${who} recalled memory`, tone: 'muted' };
    case 'collab:start': {
      const target = d.targetBotId ? ` with ${names?.[d.targetBotId] ?? d.targetBotId}` : '';
      return { text: `${who} started collaborating${target}`, tone: 'accent' };
    }
    case 'collab:end':
      return { text: `${who} finished collaborating`, tone: 'accent' };
    case 'compaction':
      return { text: `${who} compacted its context`, tone: 'muted' };
    case 'karma:change': {
      const delta = Number(d.delta) || 0;
      const sign = delta > 0 ? '+' : '';
      const why = d.reason ? ` (${d.reason})` : '';
      return { text: `${who} karma ${sign}${delta}${why}`, tone: delta >= 0 ? 'ok' : 'warn' };
    }
    case 'security:audit':
      return { text: 'Security audit ran', tone: 'muted' };
    default:
      return { text: `${who}: ${ev.type}`, tone: 'muted' };
  }
}

function eventKey(ev) {
  return `${ev.timestamp}|${ev.botId}|${ev.type}|${ev.phase ?? ''}|${ev.data?.toolName ?? ''}`;
}

/** Newest first, deduplicated, capped at `limit`. Returns the same array when nothing changes. */
export function pushTicker(list, ev, limit = TICKER_LIMIT) {
  if (!ev || typeof ev.type !== 'string') return list;
  const k = eventKey(ev);
  if ((list ?? []).some((e) => eventKey(e) === k)) return list;
  return [ev, ...(list ?? [])].slice(0, limit);
}

export function tickerRow(ev, names = {}, nowMs = Date.now()) {
  const { text, tone } = describeEvent(ev, names);
  const id = encodeURIComponent(String(ev?.botId ?? ''));
  return `<li class="fleet-tick fleet-tick-${esc(tone)}" data-ts="${esc(ev?.timestamp ?? '')}">
    <span class="fleet-tick-dot"></span>
    <a class="fleet-tick-text" href="#/agents/${id}">${esc(text)}</a>
    <span class="fleet-tick-time">${esc(ago(ev?.timestamp, nowMs))}</span>
  </li>`;
}

export function tickerBody(events = [], names = {}, nowMs = Date.now()) {
  if (!events || events.length === 0) {
    return '<p class="fleet-tick-empty text-dim">Nothing has happened yet — events appear here as the fleet works.</p>';
  }
  return `<ul class="fleet-ticker-list">${events.map((e) => tickerRow(e, names, nowMs)).join('')}</ul>`;
}

// ── Condensed ticker (session S3.5) ──────────────────────────────────────────
//
// The raw stream says "X is running file_read", "X finished file_read", … ten
// times per cycle. The Home page wants one line per agent per burst of work:
// "X ran file_read, read_production_log and manage_goals". LLM chatter and
// phase changes are dropped; failures, cycle results, karma and collaboration
// keep their own line; a tool that started and has not finished shows as
// "is running".

function tsOf(ev) {
  const t = typeof ev?.timestamp === 'number' ? ev.timestamp : Date.parse(ev?.timestamp);
  return Number.isFinite(t) ? t : 0;
}

function toolList(tools) {
  if (tools.length <= 3) {
    if (tools.length === 1) return tools[0];
    return `${tools.slice(0, -1).join(', ')} and ${tools[tools.length - 1]}`;
  }
  const rest = tools.length - 2;
  return `${tools[0]}, ${tools[1]} and ${rest} more tool${rest === 1 ? '' : 's'}`;
}

/**
 * Newest-first condensed lines `{ key, text, tone, timestamp, botId }` from a
 * newest-first raw event list (what `pushTicker` keeps).
 */
export function condenseEvents(events, names = {}) {
  const items = [];
  const groups = new Map(); // botId -> { tools: [], ts, item }
  const pending = new Map(); // botId -> tool:start event with no end yet
  const raw = (events ?? []).filter((e) => e && typeof e.type === 'string');
  const oldestFirst = [...raw].sort((a, b) => tsOf(a) - tsOf(b));

  const closeGroup = (botId) => groups.delete(botId);

  for (const ev of oldestFirst) {
    if (NOISE_EVENTS.has(ev.type)) continue;
    const botId = String(ev.botId ?? '');
    const who = botName(ev, names);
    const d = ev.data ?? {};
    const ts = tsOf(ev);

    if (ev.type === 'tool:start') {
      pending.set(botId, ev);
      continue;
    }
    if (ev.type === 'tool:end' && d.success !== false) {
      pending.delete(botId);
      const tool = d.toolName ? String(d.toolName) : 'a tool';
      const g = groups.get(botId);
      if (g && ts - g.ts <= TICKER_GROUP_GAP_MS) {
        if (!g.tools.includes(tool)) g.tools.push(tool);
        g.ts = ts;
        g.item.timestamp = ts;
        g.item.text = `${who} ran ${toolList(g.tools)}`;
      } else {
        const item = { key: '', text: `${who} ran ${tool}`, tone: 'ok', timestamp: ts, botId };
        items.push(item);
        groups.set(botId, { tools: [tool], ts, item });
      }
      continue;
    }
    if (ev.type === 'tool:end' || ev.type === 'tool:error') pending.delete(botId);
    // Anything else gets its own line and ends the agent's current run of tools.
    closeGroup(botId);
    const { text, tone } = describeEvent(ev, names);
    if (text) items.push({ key: '', text, tone, timestamp: ts, botId });
  }

  for (const [botId, ev] of pending) {
    const { text, tone } = describeEvent(ev, names);
    items.push({ key: '', text, tone, timestamp: tsOf(ev), botId });
  }

  for (const it of items) it.key = `${it.botId}|${it.timestamp}|${it.text}`;
  return items.sort((a, b) => b.timestamp - a.timestamp);
}

function condensedRow(item, nowMs) {
  const id = encodeURIComponent(item.botId ?? '');
  return `<li class="fleet-tick fleet-tick-${esc(item.tone)}" data-ts="${esc(String(item.timestamp))}">
    <span class="fleet-tick-dot"></span>
    <a class="fleet-tick-text" href="#/agents/${id}">${esc(item.text)}</a>
    <span class="fleet-tick-time">${esc(ago(item.timestamp, nowMs))}</span>
  </li>`;
}

/** Condensed rows; `TICKER_SHOW` of them unless `expanded`, with a more/less toggle. */
export function condensedTickerBody(
  events = [],
  names = {},
  nowMs = Date.now(),
  { expanded = false } = {}
) {
  const items = condenseEvents(events, names);
  if (items.length === 0) {
    return '<p class="fleet-tick-empty text-dim">Nothing has happened yet — events appear here as the fleet works.</p>';
  }
  const shown = expanded ? items : items.slice(0, TICKER_SHOW);
  const hidden = items.length - shown.length;
  let toggle = '';
  if (hidden > 0) {
    toggle = `<button type="button" class="fleet-tick-toggle" data-action="ticker-more">${hidden} more</button>`;
  } else if (expanded && items.length > TICKER_SHOW) {
    toggle =
      '<button type="button" class="fleet-tick-toggle" data-action="ticker-less">Show less</button>';
  }
  return `<ul class="fleet-ticker-list">${shown.map((i) => condensedRow(i, nowMs)).join('')}</ul>${toggle}`;
}
