/**
 * Agent Proposals page, pure half: who proposed (the mind's proposals carry
 * `proposedBy: '__watcher__'`) and the roster fields a mind proposal adds
 * (`docs/plans/mind-roster-plan.md`): the wants it serves, deliverable,
 * delivery, kill criterion, initial goals and preset. All optional: a bot's
 * `create_agent` proposal has none and renders as before.
 */
import { esc } from '../ui/index.js';

/** `WATCHER_PROPOSER` in `src/watcher/roster/types.ts`. */
export const WATCHER_PROPOSER = '__watcher__';

/** Who proposed, in words. */
export function proposerLabel(p) {
  if (p?.proposedBy === WATCHER_PROPOSER) return 'The mind (watcher)';
  return typeof p?.proposedBy === 'string' ? p.proposedBy : '';
}

const row = (label, html) =>
  html
    ? `<div class="detail-row"><span class="detail-label">${esc(label)}</span><span>${html}</span></div>`
    : '';

const text = (v) => (typeof v === 'string' && v.trim() ? esc(v) : '');

/** The roster detail rows (same `detail-row` markup as the rest of the card); '' with none. */
export function rosterFieldsHtml(p) {
  if (!p || typeof p !== 'object') return '';
  const serves = (Array.isArray(p.serves) ? p.serves : [])
    .map((s) => (s && typeof s === 'object' ? (s.what ?? s.id) : s))
    .filter((s) => typeof s === 'string' && s)
    .map(esc)
    .join(' · ');
  const goals = (Array.isArray(p.goals) ? p.goals : [])
    .filter((g) => typeof g === 'string' && g)
    .map((g) => `<li>${esc(g)}</li>`)
    .join('');
  return [
    row('Serves', serves),
    row('Deliverable', text(p.deliverable)),
    row('Delivery', text(p.delivery)),
    row('Kill criterion', text(p.killCriterion)),
    row('Goals', goals ? `<ul>${goals}</ul>` : ''),
    row('Preset', p.preset ? `<code>${esc(p.preset)}</code>` : ''),
  ].join('');
}
