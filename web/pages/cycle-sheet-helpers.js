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

/** Sheet body for one cycle. Pure. */
export function cycleSheetBody(detail, nowMs = Date.now()) {
  const c = detail.cycle;
  const goal = detail.goal
    ? `<a href="#/agents/${esc(enc(detail.botId))}">${esc(detail.goal.title)}</a>`
    : '<span class="gd-dim">No goal recorded for this cycle</span>';
  const facts = [
    `<div><span class="gd-dim">When</span> ${when(c.startedAt, nowMs)}</div>`,
    c.status ? `<div><span class="gd-dim">Status</span> ${esc(c.status)}</div>` : '',
    `<div><span class="gd-dim">Goal</span> ${goal}</div>`,
  ].join('');
  return `<div class="gd">
    ${section('This cycle', `<div class="gd-facts">${facts}</div>`)}
    ${section('What it did', cycleBlock(c, detail.botId, nowMs, true))}
  </div>`;
}

export function cycleSheetMessage(text) {
  return `<div class="gd"><div class="gd-empty">${esc(text)}</div></div>`;
}
