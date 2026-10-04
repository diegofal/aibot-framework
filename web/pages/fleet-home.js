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
import { skeleton } from '../ui/index.js';
import { authedAvatarSrc } from './agent-face.js';
import {
  TICKER_LIMIT,
  condensedTickerBody,
  fleetCard,
  fleetGrid,
  fleetSummary,
  pushTicker,
  sortFleet,
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

function redrawCards() {
  if (!state) return;
  const now = Date.now();
  for (const agent of state.order) {
    const card = state.el.querySelector(`.fleet-card[data-bot-id="${CSS.escape(agent.id)}"]`);
    if (card) card.outerHTML = fleetCard(agent, state.presence[agent.id], now, CARD_OPTS);
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

export async function renderFleetHome(el) {
  destroyFleetHome();
  el.innerHTML = `<div class="page-title">Fleet</div>${skeleton({ lines: 5 })}`;

  const [agentsRes, presenceRes, activityRes, needsRes] = await Promise.all([
    api('/api/agents').catch(() => []),
    api('/api/agents/presence').catch(() => null),
    api(`/api/activity?limit=${TICKER_LIMIT}`).catch(() => null),
    api('/api/needs-you/count').catch(() => null),
  ]);
  const agents = Array.isArray(agentsRes) ? agentsRes : [];
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
  };

  el.innerHTML = `
    <div class="fleet-head">
      <div>
        <div class="page-title">Fleet</div>
        <div class="fleet-sub text-dim" id="fleet-sub">${escapeHtml(summaryLine(agents, presence, needsYou))}</div>
      </div>
      <div class="fleet-head-actions">
        <a class="btn btn-sm" href="#/insights/loop">Loop controls</a>
        <a class="btn btn-sm btn-primary" href="#/agents">Agents</a>
      </div>
    </div>
    <section id="fleet-grid-wrap" aria-label="Agents">${fleetGrid(agents, presence, Date.now(), CARD_OPTS)}</section>
    <section class="fleet-ticker" aria-label="Recent fleet events" aria-live="polite">
      <div class="fleet-ticker-head"><span class="fleet-live-dot"></span> Recent</div>
      <div id="fleet-ticker-body">${condensedTickerBody(ticker, names, Date.now())}</div>
    </section>`;

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
