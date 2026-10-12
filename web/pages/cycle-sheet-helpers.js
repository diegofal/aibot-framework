/**
 * Pure helpers for the "Open cycle" sheet (`cycle-sheet.js`): one agent-loop
 * cycle over `GET /api/agents/:id/cycles/:cycleId` (`CycleDetailResponse`),
 * drawn with the goal drawer's cycle markup so a cycle looks the same everywhere.
 */
import { esc } from '../ui/index.js';
import { cycleBlock, section, when } from './goal-detail-helpers.js';

const enc = encodeURIComponent;

export function cycleDetailUrl(botId, cycleId) {
  return `/api/agents/${enc(botId)}/cycles/${enc(cycleId)}`;
}

/** `caution +0.03, depth −0.02` from the cycle's applied trait deltas; '' when none. */
export function traitText(deltas) {
  if (!deltas || typeof deltas !== 'object') return '';
  return Object.entries(deltas)
    .filter(([, v]) => Number.isFinite(Number(v)) && Number(v) !== 0)
    .map(([k, v]) => `${k} ${Number(v) >= 0 ? '+' : '−'}${Math.abs(Number(v)).toFixed(2)}`)
    .join(', ');
}

/**
 * Sheet body for one cycle: when, status, goal, and — when the cycle log
 * recorded them — why it went idle/skipped (with who said so), the strategist
 * reflection and the trait deltas it applied. Pure.
 */
export function cycleSheetBody(detail, nowMs = Date.now()) {
  const c = detail.cycle;
  const goal = detail.goal
    ? `<a href="#/agents/${esc(enc(detail.botId))}">${esc(detail.goal.title)}</a>`
    : '<span class="gd-dim">No goal recorded for this cycle</span>';
  const facts = [
    `<div><span class="gd-dim">When</span> ${when(c.startedAt, nowMs)}</div>`,
    c.status ? `<div><span class="gd-dim">Status</span> ${esc(c.status)}</div>` : '',
    `<div><span class="gd-dim">Goal</span> ${goal}</div>`,
    detail.cycleReason?.text
      ? `<div><span class="gd-dim">Why</span> ${esc(detail.cycleReason.text)} <span class="gd-dim">(${esc(detail.cycleReason.source)})</span></div>`
      : '',
    detail.reflection
      ? `<div><span class="gd-dim">Reflection</span> ${esc(detail.reflection)} <span class="gd-dim">(Strategist)</span></div>`
      : '',
    traitText(detail.traitAdjustments)
      ? `<div><span class="gd-dim">Traits</span> ${esc(traitText(detail.traitAdjustments))}</div>`
      : '',
  ].join('');
  return `<div class="gd">
    ${section('This cycle', `<div class="gd-facts">${facts}</div>`)}
    ${section('What it did', cycleBlock(c, detail.botId, nowMs, true))}
  </div>`;
}

export function cycleSheetMessage(text) {
  return `<div class="gd"><div class="gd-empty">${esc(text)}</div></div>`;
}
