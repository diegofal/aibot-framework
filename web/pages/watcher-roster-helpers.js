/**
 * Watcher page, the Roster card (pure half; `docs/plans/mind-roster-plan.md`):
 * the operator's brief editor (≤ 5 wants + notes), a two-step "Propose bots",
 * the last designer run (proposed, dropped, the mind's questions, retire
 * suggestions), the mind's proposals and the bots approved from them. Data in,
 * HTML string out: no DOM, so `tests/web/watcher-roster-helpers.test.ts` runs
 * it under Bun.
 *
 * Data: `GET /api/watcher/brief` (`OperatorBrief`) and `GET /api/watcher/roster`
 * (`RosterStatus`), shapes in `src/watcher/roster/types.ts`. Both answer 404
 * `{ enabled: false }` with the watcher off: `isRosterStatus` tells that apart
 * from a roster that is merely switched off, and the card hides.
 *
 * The editor works on a draft (`ui.draft`) the page keeps as typed, so a
 * rebuild puts the text back; `briefPayload` turns it into the PUT body.
 */
import { esc } from '../ui/index.js';
import { inText, isArmed, relTime } from './watcher-autonomy-helpers.js';

/* Limits mirror `src/watcher/roster/types.ts` (the server enforces them too). */
export const BRIEF_MAX_WANTS = 5;
export const BRIEF_WHAT_MAX = 300;
export const BRIEF_SHORT_MAX = 80;
export const BRIEF_SUCCESS_MAX = 300;
export const BRIEF_NOTES_MAX = 2000;

/** The two-step key of "Propose bots". */
export const ROSTER_RUN_KEY = 'roster:run';

/** Where `web/pages/agent-proposals.js` lives (the old agent-proposals hash redirects here). */
export const PROPOSALS_HREF = '#/needs/proposals';

export const ROSTER_HEAD = {
  title: 'Roster',
  sub: 'What you want, and the bots the mind proposes for it. Every proposed bot must serve one of your wants; nothing is created until you approve it in Agent Proposals.',
};

/** The editor's fields, in order: key, label, limit, placeholder. */
const WANT_FIELDS = [
  { key: 'what', label: 'What do you want?', max: BRIEF_WHAT_MAX, ph: 'A weekly digest of …' },
  { key: 'cadence', label: 'How often', max: BRIEF_SHORT_MAX, ph: 'every Monday' },
  { key: 'delivery', label: 'How you receive it', max: BRIEF_SHORT_MAX, ph: 'Telegram' },
  { key: 'success', label: 'What good looks like', max: BRIEF_SUCCESS_MAX, ph: '' },
];

const LIMIT = {
  what: BRIEF_WHAT_MAX,
  cadence: BRIEF_SHORT_MAX,
  delivery: BRIEF_SHORT_MAX,
  success: BRIEF_SUCCESS_MAX,
};

const str = (v) => (typeof v === 'string' ? v : '');
const list = (a) => (Array.isArray(a) ? a.filter((x) => x != null) : []);
const blankWant = () => ({ what: '', cadence: '', delivery: '', success: '' });

function clip(text, max) {
  const s = str(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A `roster:*` log row (the card refetches on it). */
export function isRosterRow(row) {
  const op = row?.op ?? row?.type;
  return typeof op === 'string' && op.startsWith('roster:');
}

/** A `RosterStatus`, not the watcher-off 404 `{ enabled: false }` nor an error. */
export function isRosterStatus(res) {
  return !!res && typeof res === 'object' && typeof res.proposalsOn === 'boolean';
}

function savedWants(brief) {
  return list(brief?.wants).filter((w) => typeof w === 'object' && str(w.what).trim());
}

/** The editor state for a saved brief: its wants (ids kept) or one blank row, and the notes. */
export function draftFromBrief(brief) {
  const wants = savedWants(brief).map((w) => ({
    ...(w.id ? { id: w.id } : {}),
    what: str(w.what),
    cadence: str(w.cadence),
    delivery: str(w.delivery),
    success: str(w.success),
  }));
  return { wants: wants.length ? wants : [blankWant()], notes: str(brief?.notes) };
}

/**
 * The `PUT /api/watcher/brief` body from the editor draft: trimmed, clipped to
 * the limits, at most `BRIEF_MAX_WANTS`, a want with an empty `what` left out,
 * an existing want's id kept (a new one has none: the server assigns it).
 */
export function briefPayload(draft) {
  const wants = list(draft?.wants)
    .map((w) => {
      const out = w?.id ? { id: String(w.id) } : {};
      for (const key of Object.keys(LIMIT)) out[key] = str(w?.[key]).trim().slice(0, LIMIT[key]);
      return out;
    })
    .filter((w) => w.what)
    .slice(0, BRIEF_MAX_WANTS);
  return { wants, notes: str(draft?.notes).trim().slice(0, BRIEF_NOTES_MAX) };
}

/** A want id in words: the want's `what`, clipped; an id the brief no longer has stays as is. */
export function wantLabel(id, brief) {
  const w = savedWants(brief).find((x) => x.id === id);
  return w ? clip(w.what, 60) : String(id ?? '');
}

/** Why "Propose bots" cannot run now, in words; '' when it can. */
export function proposeBlock(status, brief) {
  if (status?.enabled !== true) return 'The roster is off (watcher.roster.enabled).';
  if (status?.proposalsOn !== true) {
    return 'Agent proposals are off: turn on agentProposals.enabled to let the mind propose bots.';
  }
  if (status?.running === true) return 'A run is already running.';
  if (savedWants(brief).length === 0) return 'Save at least one want first.';
  return '';
}

const STATUS_WORDS = {
  proposed: 'Proposed',
  nothing: 'Nothing to propose',
  unparsable: 'The answer could not be read',
  refused: 'Refused before calling the model',
  failed: 'Failed',
};

const TRIGGER_WORDS = {
  manual: 'you ran it',
  scheduled: 'weekly run',
  'brief-changed': 'after you edited the brief',
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One line about a designer run, in words. */
export function rosterOutcomeText(outcome) {
  if (!outcome || typeof outcome !== 'object') return '';
  const status = STATUS_WORDS[outcome.status] ?? String(outcome.status ?? '');
  const dropped = list(outcome.dropped).length;
  if (outcome.status === 'proposed') {
    const n = list(outcome.proposed).length;
    return `Proposed ${plural(n, 'bot', 'bots')}${dropped ? `, ${dropped} dropped by code` : ''}`;
  }
  const reason = outcome.reason ? `: ${outcome.reason}` : '';
  return `${status}${reason}${dropped ? ` (${dropped} dropped by code)` : ''}`;
}

/* ── Rendering ───────────────────────────────────────────────────── */

function field(label, html) {
  if (!html) return '';
  return `<div class="watcher-auto-field"><span class="watcher-auto-label text-dim">${esc(
    label
  )}</span><div>${html}</div></div>`;
}

function errorLine(text) {
  return text ? `<div class="watcher-auto-error" role="alert">${esc(text)}</div>` : '';
}

const servesText = (ids, brief) =>
  list(ids)
    .map((id) => esc(wantLabel(id, brief)))
    .join(' · ');

function wantRowHtml(w, i, disabled) {
  const inputs = WANT_FIELDS.map(
    (f) =>
      `<div class="watcher-auto-field"><label class="watcher-auto-label text-dim" for="roster-${f.key}-${i}">${esc(
        f.label
      )}</label><div><input type="text" class="watcher-auto-note" id="roster-${f.key}-${i}" data-roster-field="${f.key}" data-roster-index="${i}" maxlength="${f.max}" value="${esc(
        str(w?.[f.key])
      )}"${f.ph ? ` placeholder="${esc(f.ph)}"` : ''}${disabled}></div></div>`
  ).join('');
  return `<li class="watcher-auto-card" data-roster-want="${i}">${inputs}<div class="watcher-auto-actions"><button type="button" class="btn btn-sm" data-action="roster-remove" data-roster-index="${i}" data-focus-key="roster-remove:${i}"${disabled}>Remove</button></div></li>`;
}

function editorHtml(draft, brief, { nowMs, ui }) {
  const disabled = ui.saving ? ' disabled' : '';
  const wants = list(draft.wants).slice(0, BRIEF_MAX_WANTS);
  const add =
    wants.length < BRIEF_MAX_WANTS
      ? `<button type="button" class="btn btn-sm" data-action="roster-add" data-focus-key="roster-add"${disabled}>+ Add want</button>`
      : '';
  const saved = brief?.updatedAt ? `Saved ${relTime(brief.updatedAt, nowMs)}` : '';
  return `<div class="watcher-auto-sub">Your brief</div><ul class="watcher-auto-list">${wants
    .map((w, i) => wantRowHtml(w, i, disabled))
    .join(
      ''
    )}</ul><div class="watcher-auto-actions">${add}</div><div class="watcher-auto-field"><label class="watcher-auto-label text-dim" for="roster-notes">Notes</label><div><textarea class="watcher-auto-note" id="roster-notes" data-roster-notes rows="3" maxlength="${BRIEF_NOTES_MAX}" placeholder="Anything else the mind should know"${disabled}>${esc(
    str(draft.notes)
  )}</textarea></div></div>${errorLine(ui.saveError)}<div class="watcher-auto-actions"><button type="button" class="btn btn-sm btn-primary" data-action="roster-save" data-focus-key="roster-save"${disabled}>${
    ui.saving ? 'Saving…' : 'Save'
  }</button>${saved ? `<span class="text-dim" title="${esc(brief.updatedAt)}">${esc(saved)}</span>` : ''}</div>`;
}

function runHtml(status, brief, { nowMs, ui }) {
  const busy = ui.busy === true;
  const block = busy ? 'A run is already running.' : proposeBlock(status, brief);
  const running = status.running === true || busy;
  const armed = !block && isArmed(ui.armed, ROSTER_RUN_KEY, nowMs);
  const last = status.lastRunAt
    ? `last run ${relTime(status.lastRunAt, nowMs)}`
    : 'it has not run yet';
  const next = running
    ? 'running now'
    : status.nextRunAt
      ? `next automatic run ${inText(status.nextRunAt, nowMs)}`
      : '';
  return `<div class="watcher-self-when text-dim">${esc(
    [last, next].filter(Boolean).join(' · ')
  )}</div>${errorLine(ui.error)}<div class="watcher-auto-actions"><button type="button" class="btn btn-sm${
    armed ? ' btn-danger' : ''
  }" data-action="roster-run" data-focus-key="${ROSTER_RUN_KEY}"${block ? ' disabled' : ''}>${
    running ? 'Running…' : armed ? 'Click again to propose' : 'Propose bots'
  }</button>${block && !running ? `<span class="text-dim">${esc(block)}</span>` : ''}</div>`;
}

function costText(outcome) {
  const parts = [];
  const tokens = Number(outcome.tokens);
  const cost = Number(outcome.costUsd);
  if (Number.isFinite(tokens) && tokens > 0) parts.push(`${tokens.toLocaleString('en-US')} tokens`);
  if (Number.isFinite(cost)) parts.push(`$${cost.toFixed(2)}`);
  if (outcome.model) parts.push(String(outcome.model));
  return parts.join(' · ');
}

function outcomeHtml(outcome, brief, nowMs) {
  if (!outcome || typeof outcome !== 'object') return '';
  const trigger = TRIGGER_WORDS[outcome.trigger] ?? '';
  const when = [relTime(outcome.at, nowMs), trigger].filter(Boolean).join(', ');
  const proposed = list(outcome.proposed).map(
    (p) =>
      `<li><strong>${esc(p.name ?? p.agentId ?? '')}</strong>${
        list(p.serves).length
          ? ` <span class="text-dim">for ${servesText(p.serves, brief)}</span>`
          : ''
      }</li>`
  );
  const dropped = list(outcome.dropped).map(
    (d) => `<li><strong>${esc(d.name ?? '')}</strong>: ${esc(d.reason ?? '')}</li>`
  );
  const questions = list(outcome.questions).map((q) => `<li>${esc(q)}</li>`);
  const retire = list(outcome.retire).map(
    (r) => `<li><code>${esc(r.botId ?? '')}</code>: ${esc(r.reason ?? '')}</li>`
  );
  const ul = (rows) =>
    rows.length ? `<ul class="watcher-auto-changes">${rows.join('')}</ul>` : '';
  const cost = costText(outcome);
  return `<div class="watcher-auto-sub">Last run</div><div class="watcher-auto-reason">${esc(
    rosterOutcomeText(outcome)
  )}${when ? ` <span class="text-dim">(${esc(when)})</span>` : ''}</div>${field('Proposed', ul(proposed))}${field(
    'Dropped',
    ul(dropped)
  )}${questions.length ? `<div class="watcher-auto-sub">The mind asks</div>${ul(questions)}` : ''}${
    retire.length ? `<div class="watcher-auto-sub">Consider turning off</div>${ul(retire)}` : ''
  }${outcome.note ? `<div class="watcher-auto-reason">${esc(outcome.note)}</div>` : ''}${
    cost ? `<div class="watcher-auto-reason text-dim">${esc(cost)}</div>` : ''
  }`;
}

const PROPOSAL_TONE = { pending: '', approved: 'is-live', rejected: 'is-bad' };

function proposalsHtml(proposals, brief, nowMs) {
  const rows = list(proposals).map(
    (p) =>
      `<li class="watcher-auto-row" data-roster-proposal="${esc(p.id ?? '')}"><span class="watcher-auto-status ${
        PROPOSAL_TONE[p.status] ?? ''
      }">${esc(p.status ?? '')}</span> <strong>${esc(p.name ?? p.agentId ?? '')}</strong> <span class="text-dim">${esc(
        relTime(p.createdAt, nowMs)
      )}</span>${field('Serves', servesText(p.serves, brief))}${field('Deliverable', esc(str(p.deliverable)))}${field(
        'Cadence',
        esc(str(p.cadence))
      )}${field('Kill criterion', esc(str(p.killCriterion)))}</li>`
  );
  if (!rows.length) return '';
  return `<div class="watcher-auto-sub">Proposals</div><ul class="watcher-auto-list">${rows.join(
    ''
  )}</ul><div class="watcher-auto-actions"><a href="${PROPOSALS_HREF}">Review in Agent Proposals</a></div>`;
}

function botsHtml(bots, brief, nowMs) {
  const rows = list(bots).map((b) => {
    const total = Number(b.productions) || 0;
    const stats = [
      plural(Number(b.cyclesCompleted) || 0, 'cycle', 'cycles'),
      `${Number(b.approved) || 0} approved, ${Number(b.rejected) || 0} rejected of ${total}`,
      b.lastCycleAt ? `last cycle ${relTime(b.lastCycleAt, nowMs)}` : 'no cycle yet',
    ].join(' · ');
    return `<li class="watcher-auto-row" data-roster-bot="${esc(b.botId ?? '')}"><span class="watcher-auto-status ${
      b.enabled ? 'is-live' : ''
    }">${b.enabled ? 'enabled' : 'off'}</span> <strong>${esc(b.name ?? b.botId ?? '')}</strong> <span class="text-dim">${esc(
      stats
    )}</span>${field('Serves', servesText(b.serves, brief))}${field('Kill criterion', esc(str(b.killCriterion)))}</li>`;
  });
  if (!rows.length) return '';
  return `<div class="watcher-auto-sub">Bots</div><ul class="watcher-auto-list">${rows.join('')}</ul>`;
}

/**
 * The Roster card: '' unless `status` is a `RosterStatus`. `brief` is the
 * saved brief; `ui`: `{ draft, armed, busy, error, saving, saveError }`
 * (`draft` falls back to the saved brief).
 */
export function rosterCardHtml(status, brief, { nowMs = Date.now(), ui = {} } = {}) {
  if (!isRosterStatus(status)) return '';
  const saved = brief && typeof brief === 'object' && Array.isArray(brief.wants) ? brief : null;
  const draft = ui.draft && Array.isArray(ui.draft.wants) ? ui.draft : draftFromBrief(saved);
  return `<div class="watcher-card-head"><div class="watcher-log-title">${esc(
    ROSTER_HEAD.title
  )}</div><div class="watcher-card-sub">${esc(ROSTER_HEAD.sub)}</div></div>${editorHtml(
    draft,
    saved,
    {
      nowMs,
      ui,
    }
  )}${runHtml(status, saved, { nowMs, ui })}${outcomeHtml(status.lastOutcome, saved, nowMs)}${proposalsHtml(
    status.proposals,
    saved,
    nowMs
  )}${botsHtml(status.bots, saved, nowMs)}`;
}
