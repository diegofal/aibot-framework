/**
 * Fleet Home — the first screen after login (session S3 of
 * docs/plans/jarvis-fleet-plan.md): the fleet as people.
 *
 * One card per agent (avatar, posture, first-person now-line, karma, last
 * output, what needs you), then a condensed "Recent" strip: one line per
 * agent per burst of work instead of every tool start/finish (session S3.5).
 * Data: `/api/agents` + `/api/agents/presence` + `/api/activity` +
 * `/api/needs-you/count` (so the header says the same number as the sidebar
 * badge); live updates ride one `/ws/activity` socket through `watchFleet()`.
 * Card order is fixed at render time so cards do not jump under the cursor.
 */
import { showToast, skeleton } from '../ui/index.js';
import { authedAvatarSrc } from './agent-face.js';
import {
  TICKER_LIMIT,
  condensedTickerBody,
  filterFleet,
  fleetCard,
  fleetErrorState,
  fleetFilterChips,
  fleetFilterCounts,
  fleetGrid,
  fleetSummary,
  pushTicker,
  readFleetFilter,
  sortFleet,
  writeFleetFilter,
} from './fleet-home-helpers.js';
import { watchFleet } from './live-presence.js';
import { api, escapeHtml } from './shared.js';

const TICKER_CLOCK_MS = 30_000;
/** Uploaded faces load through `<img>`, which needs the token in the url. */
const CARD_OPTS = { avatarSrc: authedAvatarSrc };

let watch = null;
let clock = null;
let state = null;

export function destroyFleetHome() {
  watch?.stop();
  watch = null;
  clearInterval(clock);
  clock = null;
  state = null;
}

function summaryLine(agents, presence, needsYou) {
  const s = fleetSummary(agents, presence, { needsYou });
  const bits = [`${s.total} agent${s.total === 1 ? '' : 's'}`, `${s.running} running`];
  if (s.executing) bits.push(`${s.executing} working now`);
  if (s.blocked) bits.push(`${s.blocked} blocked`);
  if (s.needsYou) bits.push(`${s.needsYou} waiting on you`);
  return bits.join(' · ');
}

function redrawTicker() {
  const el = state?.el?.querySelector('#fleet-ticker-body');
  if (el) {
    el.innerHTML = condensedTickerBody(state.ticker, state.names, Date.now(), {
      expanded: state.tickerExpanded,
    });
  }
}

function storage() {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/** Rebuild the grid for the current filter (order stays the render-time order). */
function paintGrid() {
  if (!state) return;
  const wrap = state.el.querySelector('#fleet-grid-wrap');
  const chips = state.el.querySelector('#fleet-chips');
  if (chips)
    chips.innerHTML = fleetFilterChips(
      state.filter,
      fleetFilterCounts(state.agents, state.presence)
    );
  if (!wrap) return;
  const visible = new Set(filterFleet(state.agents, state.presence, state.filter).map((a) => a.id));
  const shown = state.order.filter((a) => visible.has(a.id));
  if (shown.length === 0) {
    wrap.innerHTML = fleetGrid([], {}, Date.now(), {
      ...CARD_OPTS,
      filtered: state.agents.length > 0,
    });
    return;
  }
  const now = Date.now();
  wrap.innerHTML = `<div class="fleet-grid">${shown
    .map((a) => fleetCard(a, state.presence[a.id], now, CARD_OPTS))
    .join('')}</div>`;
}

function redrawCards() {
  if (!state) return;
  // Cards entering or leaving the filter need a full grid repaint.
  const visible = filterFleet(state.agents, state.presence, state.filter).map((a) => a.id);
  const rendered = [...state.el.querySelectorAll('.fleet-card[data-bot-id]')].map(
    (c) => c.dataset.botId
  );
  const sameSet =
    visible.length === rendered.length && visible.every((id) => rendered.includes(id));
  if (!sameSet) {
    paintGrid();
  } else {
    const now = Date.now();
    for (const agent of state.order) {
      const card = state.el.querySelector(`.fleet-card[data-bot-id="${CSS.escape(agent.id)}"]`);
      // Keep a card whose quick action is mid-request (or focused) as it is.
      if (
        card &&
        !card.contains(document.activeElement) &&
        !card.querySelector('[data-quick]:disabled')
      ) {
        card.outerHTML = fleetCard(agent, state.presence[agent.id], now, CARD_OPTS);
      }
    }
    const chips = state.el.querySelector('#fleet-chips');
    if (chips) {
      chips.innerHTML = fleetFilterChips(
        state.filter,
        fleetFilterCounts(state.agents, state.presence)
      );
    }
  }
  const sub = state.el.querySelector('#fleet-sub');
  if (sub) sub.textContent = summaryLine(state.agents, state.presence, state.needsYou);
}

async function refreshNeedsYou() {
  const res = await api('/api/needs-you/count').catch(() => null);
  if (!state || !res || res.error || !Number.isFinite(Number(res.count))) return;
  state.needsYou = Number(res.count);
  const sub = state.el.querySelector('#fleet-sub');
  if (sub) sub.textContent = summaryLine(state.agents, state.presence, state.needsYou);
}

function onFilterClick(e) {
  const chip = e.target.closest('[data-fleet-filter]');
  if (!chip || !state) return;
  state.filter = chip.dataset.fleetFilter;
  writeFleetFilter(storage(), state.filter);
  paintGrid();
}

const QUICK_PATHS = {
  start: (id) => `/api/agents/${id}/start`,
  'enable-start': (id) => `/api/agents/${id}/start?enable=true`,
  stop: (id) => `/api/agents/${id}/stop`,
  run: (id) => `/api/agent-loop/run/${id}`,
};

/** Start / Stop / Run now on a card; never follows the card link. */
async function onQuickAction(e) {
  const btn = e.target.closest('[data-quick]');
  if (!btn || !state) return;
  e.preventDefault();
  e.stopPropagation();
  const action = btn.dataset.quick;
  const id = btn.dataset.id;
  const name = state.names[id] || id;
  const path = QUICK_PATHS[action]?.(encodeURIComponent(id));
  if (!path) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = action === 'run' ? 'Running…' : action === 'stop' ? 'Stopping…' : 'Starting…';
  const res = await api(path, { method: 'POST' }).catch((err) => ({ error: err?.message }));
  btn.disabled = false;
  btn.textContent = label;
  if (!res || res.error) {
    showToast(`${name}: ${res?.error || 'request failed'}`, { tone: 'danger', duration: 8000 });
    return;
  }
  const done = action === 'run' ? 'finished a cycle' : action === 'stop' ? 'stopped' : 'started';
  showToast(`${name} ${done}`, { tone: 'ok' });
  if (!state) return;
  // Reflect the new running state right away; the live presence link catches up.
  if (action !== 'run') {
    const running = action !== 'stop';
    const agent = state.agents.find((a) => a.id === id);
    if (agent) {
      agent.running = running;
      if (action === 'enable-start') agent.enabled = true;
    }
    const p = state.presence[id];
    if (p) {
      state.presence[id] = {
        ...p,
        running,
        ...(action === 'enable-start' ? { enabled: true } : {}),
      };
    }
    redrawCards();
  }
}

export async function renderFleetHome(el) {
  destroyFleetHome();
  el.innerHTML = `<div class="page-title">Fleet</div>${skeleton({ lines: 5 })}`;

  const [agentsRes, presenceRes, activityRes, needsRes] = await Promise.all([
    api('/api/agents').catch((err) => ({ error: err?.message || 'Request failed' })),
    api('/api/agents/presence').catch(() => null),
    api(`/api/activity?limit=${TICKER_LIMIT}`).catch(() => null),
    api('/api/needs-you/count').catch(() => null),
  ]);
  if (!Array.isArray(agentsRes)) {
    // A failed request must not read as an empty fleet.
    el.innerHTML = `<div class="page-title">Fleet</div>${fleetErrorState(agentsRes?.error)}`;
    el.querySelector('[data-action="fleet-retry"]')?.addEventListener('click', () =>
      renderFleetHome(el)
    );
    return;
  }
  const agents = agentsRes;
  const presence = presenceRes?.agents ?? {};
  const names = Object.fromEntries(agents.map((a) => [a.id, a.name || a.id]));
  // /api/activity is oldest -> newest; the ticker wants newest first.
  const seed = Array.isArray(activityRes?.events) ? [...activityRes.events].reverse() : [];
  let ticker = [];
  for (let i = seed.length - 1; i >= 0; i--) ticker = pushTicker(ticker, seed[i]);
  const needsYou =
    needsRes && !needsRes.error && Number.isFinite(Number(needsRes.count))
      ? Number(needsRes.count)
      : null;

  state = {
    el,
    agents,
    presence,
    names,
    ticker,
    tickerExpanded: false,
    needsYou,
    order: sortFleet(agents, presence),
    filter: readFleetFilter(storage()),
  };

  el.innerHTML = `
    <div class="fleet-head">
      <div>
        <div class="page-title">Fleet</div>
        <div class="fleet-sub text-dim" id="fleet-sub">${escapeHtml(summaryLine(agents, presence, needsYou))}</div>
      </div>
      <div class="fleet-head-actions">
        <a class="btn btn-sm" href="#/automations/loop">Loop controls</a>
        <a class="btn btn-sm" href="#/agents">Agents</a>
        <a class="btn btn-sm btn-primary" href="#/agents/new" data-page-new>+ New agent</a>
      </div>
    </div>
    ${agents.length > 0 ? '<div id="fleet-chips"></div>' : ''}
    <section id="fleet-grid-wrap" aria-label="Agents">${fleetGrid(agents, presence, Date.now(), CARD_OPTS)}</section>
    <section class="fleet-ticker" aria-label="Recent fleet events" aria-live="polite">
      <div class="fleet-ticker-head"><span class="fleet-live-dot"></span> Recent</div>
      <div id="fleet-ticker-body">${condensedTickerBody(ticker, names, Date.now())}</div>
    </section>`;

  paintGrid();

  el.querySelector('#fleet-chips')?.addEventListener('click', onFilterClick);
  const gridWrap = el.querySelector('#fleet-grid-wrap');
  gridWrap?.addEventListener('click', onFilterClick);
  gridWrap?.addEventListener('click', onQuickAction);

  el.querySelector('.fleet-ticker')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || !state) return;
    if (btn.dataset.action === 'ticker-more') state.tickerExpanded = true;
    else if (btn.dataset.action === 'ticker-less') state.tickerExpanded = false;
    else return;
    redrawTicker();
  });

  watch = watchFleet({
    onEvent: (ev) => {
      if (!state) return;
      const next = pushTicker(state.ticker, ev);
      if (next !== state.ticker) {
        state.ticker = next;
        redrawTicker();
      }
    },
    onPresence: (body) => {
      if (!state || !body?.agents) return;
      state.presence = body.agents;
      redrawCards();
      refreshNeedsYou();
    },
  });
  clock = setInterval(() => {
    redrawTicker();
    redrawCards();
  }, TICKER_CLOCK_MS);
}
