/**
 * Automations box helpers (session S8 of docs/plans/jarvis-fleet-plan.md).
 *
 * Pure functions behind the "Tell an agent what to do and when" box at the
 * top of Automations -> Cron: request building for `POST /api/cron/parse`
 * and the existing `POST /api/cron`, the preview card markup, and a small
 * cron -> human mirror for the editable cron field (the server's
 * `src/cron/nl-parse.ts` is the source of truth; this copy only has to agree
 * on the common shapes). Tests: tests/web/automations-helpers.test.ts.
 */
import { badge, esc } from '../ui/index.js';

export const PARSE_PATH = '/api/cron/parse';
export const CREATE_PATH = '/api/cron';
export const AUTOMATION_PLACEHOLDER = 'Check job boards every 3 hours and message me';
export const CONFIDENCE_TONE = { high: 'ok', medium: 'warn', low: 'danger' };
const CRON_FIELDS = 5;
const NAME_MAX = 60;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 5 whitespace-separated fields of cron characters. Shape only — the server validates for real. */
export function isCronExpr(expr) {
  if (typeof expr !== 'string') return false;
  const fields = expr.trim().split(/\s+/);
  return fields.length === CRON_FIELDS && fields.every((f) => /^[\d*/,\-]+$/.test(f));
}

const pad2 = (n) => String(n).padStart(2, '0');
const isNum = (s) => /^\d{1,2}$/.test(s);
const stepOf = (s) => (/^\*\/\d+$/.test(s) ? Number(s.slice(2)) : null);

function humanTime(m, h) {
  if (!isNum(m) || !isNum(h) || Number(h) > 23 || Number(m) > 59) return null;
  return `${pad2(Number(h))}:${pad2(Number(m))}`;
}

function humanDays(dow) {
  if (dow === '1-5') return 'Weekdays';
  if (dow === '6,0' || dow === '0,6') return 'Weekends';
  if (!/^\d(?:,\d)*$/.test(dow)) return null;
  const names = dow.split(',').map((d) => DAY_NAMES[Number(d) % 7]);
  if (names.some((n) => !n)) return null;
  if (names.length === 1) return `Every ${names[0]}`;
  return `Every ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function describe(expr) {
  const raw = `Cron "${expr}"`;
  const f = expr.split(/\s+/);
  if (f.length !== CRON_FIELDS) return raw;
  const [m, h, dom, mon, dow] = f;
  if (mon !== '*') return raw;
  if (dom === '*' && dow === '*') {
    if (m === '*' && h === '*') return 'Every minute';
    if (stepOf(m) && h === '*') return `Every ${stepOf(m)} minutes`;
    if (isNum(m) && stepOf(h)) {
      return `Every ${stepOf(h)} hours${m === '0' ? '' : ` at :${pad2(Number(m))}`}`;
    }
    if (isNum(m) && h === '*')
      return m === '0' ? 'Every hour' : `Every hour at :${pad2(Number(m))}`;
    const t = humanTime(m, h);
    return t ? `Every day at ${t}` : raw;
  }
  const t = humanTime(m, h);
  if (!t) return raw;
  if (dom === '*') {
    const d = humanDays(dow);
    return d ? `${d} at ${t}` : raw;
  }
  if (dow !== '*') return raw;
  if (stepOf(dom)) return `Every ${stepOf(dom)} days at ${t}`;
  if (isNum(dom)) return `On day ${Number(dom)} of every month at ${t}`;
  return raw;
}

/** "0 9 * * 1" -> "Every Monday at 09:00 (tz)". Unknown shapes come back as `Cron "<expr>"`. */
export function cronToHuman(expr, tz) {
  const text = describe(String(expr ?? '').trim());
  return tz ? `${text} (${tz})` : text;
}

/** `{ path, method, body }` for the parse call, or `{ error }`. */
export function buildParseRequest(text, botId) {
  const t = String(text ?? '').trim();
  const b = String(botId ?? '').trim();
  if (!t) return { error: 'Say what the agent should do and when.' };
  if (!b) return { error: 'Pick an agent.' };
  return { path: PARSE_PATH, method: 'POST', body: { text: t, botId: b } };
}

function jobName(text) {
  const s = String(text ?? '')
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return 'Automation';
  return s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1)}…` : s;
}

function resolveChatId(proposal, edited) {
  if (edited !== undefined && edited !== null && String(edited).trim() !== '') {
    const n = Number(String(edited).trim());
    return Number.isFinite(n) && n !== 0 ? n : null;
  }
  if (typeof proposal.chatId === 'number' && proposal.chatId !== 0) return proposal.chatId;
  if (typeof proposal.operatorChatId === 'number' && proposal.operatorChatId !== 0) {
    return proposal.operatorChatId;
  }
  return null;
}

/**
 * The exact payload the cron page's own form posts to `POST /api/cron`, built
 * from the proposal plus whatever the user edited in the card. `{ error }`
 * when the cron is malformed, the instruction is empty or no chat id resolves.
 */
export function buildCreateRequest(proposal, edits = {}) {
  const p = proposal ?? {};
  const expr = String(edits.expr ?? p.schedule ?? '')
    .trim()
    .split(/\s+/)
    .join(' ');
  if (!isCronExpr(expr)) {
    return { error: 'The cron expression needs five fields: minute hour day month weekday.' };
  }
  const text = String(edits.instruction ?? p.instruction ?? '').trim();
  if (!text) return { error: 'The instruction cannot be empty.' };
  const chatId = resolveChatId(p, edits.chatId);
  if (chatId === null) {
    return {
      error:
        'Set a Telegram chat id for delivery — the operator chat is not configured (config.operator.telegramChatId).',
    };
  }
  const name = String(edits.name ?? '').trim() || String(p.name ?? '').trim() || jobName(text);
  return {
    path: CREATE_PATH,
    method: 'POST',
    body: {
      name,
      enabled: true,
      schedule: { kind: 'cron', expr, tz: p.tz },
      payload: { kind: 'instruction', text, chatId, botId: p.botId },
    },
  };
}

/** A running agent, else an enabled one, else the first; '' with no agents. */
export function pickDefaultAgent(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const running = list.find((a) => a.running);
  const enabled = list.find((a) => a.enabled !== false);
  return (running ?? enabled ?? list[0])?.id ?? '';
}

export function agentOptions(agents, selectedId) {
  return (Array.isArray(agents) ? agents : [])
    .map(
      (a) =>
        `<option value="${esc(a.id)}"${a.id === selectedId ? ' selected' : ''}>${esc(
          a.name || a.id
        )} (${esc(a.id)})</option>`
    )
    .join('');
}

/** The one-line box: prompt, text input, agent picker, Parse button and the preview slot. */
export function automationBox({ agents = [], selectedId = '', text = '', busy = false } = {}) {
  const hasAgents = Array.isArray(agents) && agents.length > 0;
  const picker = hasAgents
    ? `<select name="botId" class="auto-box-agent" aria-label="Agent"${busy ? ' disabled' : ''}>${agentOptions(
        agents,
        selectedId
      )}</select>`
    : '<span class="auto-box-none text-dim">No agents yet</span>';
  const disabled = busy || !hasAgents ? ' disabled' : '';
  return `<form class="auto-box" data-automation autocomplete="off">
    <div class="auto-box-title">Tell an agent what to do and when</div>
    <div class="auto-box-row">
      <input class="auto-box-text" name="text" type="text" value="${esc(text)}" placeholder="${esc(
        AUTOMATION_PLACEHOLDER
      )}" aria-label="What to automate"${busy ? ' disabled' : ''}>
      ${picker}
      <button type="submit" class="btn btn-primary auto-box-parse"${disabled}>${
        busy ? 'Parsing…' : 'Parse'
      }</button>
    </div>
    <div class="auto-box-preview" data-automation-preview></div>
  </form>`;
}

/** "in 3h" / "in 45m" / "in 2d" for an ISO instant after `nowMs`; '' when unknown or past. */
export function relativeIn(nowMs, iso) {
  const at = Date.parse(iso ?? '');
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return '';
  const d = at - nowMs;
  if (d < 0) return '';
  if (d < 60_000) return 'in under a minute';
  const min = Math.round(d / 60_000);
  if (min < 60) return `in ${min}m`;
  const h = Math.round(d / 3_600_000);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(d / 86_400_000)}d`;
}

export function targetLabel(proposal) {
  const p = proposal ?? {};
  if (typeof p.chatId === 'number') return `Chat ${p.chatId}`;
  return typeof p.operatorChatId === 'number'
    ? `You (operator · chat ${p.operatorChatId})`
    : 'You (operator · no chat id configured)';
}

export function describeSource(proposal, agents = []) {
  const p = proposal ?? {};
  if (p.source !== 'llm' || !p.llm) return 'Read by the built-in parser';
  const agent = (Array.isArray(agents) ? agents : []).find((a) => a.id === p.botId);
  const name = agent?.name || p.botId;
  const model = p.llm.model ? ` · ${p.llm.model}` : '';
  return `Read by ${name} (${p.llm.backend}${model})`;
}

/**
 * The preview card. `opts.expr / instruction / name / chatId` are edits to
 * show instead of the proposal's values; `opts.agents` names the agent;
 * `opts.nowMs` anchors the "next run" relative text.
 */
export function previewCard(proposal, opts = {}) {
  const p = proposal ?? {};
  const expr = String(opts.expr ?? p.schedule ?? '');
  const instruction = String(opts.instruction ?? p.instruction ?? '');
  const name = String(opts.name ?? p.name ?? '');
  const chatValue =
    opts.chatId !== undefined
      ? String(opts.chatId)
      : typeof p.chatId === 'number'
        ? String(p.chatId)
        : typeof p.operatorChatId === 'number'
          ? String(p.operatorChatId)
          : '';
  const confidence = CONFIDENCE_TONE[p.confidence] ? p.confidence : 'low';
  const next = relativeIn(opts.nowMs ?? Date.now(), p.nextRunAt);
  const warnings = Array.isArray(p.warnings) ? p.warnings : [];
  const valid = isCronExpr(expr);

  return `<section class="ui-card auto-card" data-automation-card>
    <div class="auto-card-head">
      <div class="auto-card-when">
        <span class="auto-card-human${valid ? '' : ' auto-card-invalid'}" data-cron-human>${esc(
          cronToHuman(expr, p.tz)
        )}</span>
        ${next ? `<span class="text-dim auto-card-next" data-cron-next>· next run ${esc(next)}</span>` : ''}
      </div>
      ${badge(`${confidence} confidence`, CONFIDENCE_TONE[confidence])}
    </div>
    ${p.explanation ? `<p class="auto-card-explain">${esc(p.explanation)}</p>` : ''}
    <p class="text-dim text-sm auto-card-source">${esc(describeSource(p, opts.agents))}</p>
    ${
      warnings.length
        ? `<ul class="auto-card-warnings">${warnings
            .map((w) => `<li>${esc(w)}</li>`)
            .join('')}</ul>`
        : ''
    }
    <div class="auto-card-grid">
      <label class="auto-card-field">
        <span>Cron</span>
        <input name="expr" type="text" class="auto-card-cron" value="${esc(expr)}" spellcheck="false">
      </label>
      <label class="auto-card-field">
        <span>Name</span>
        <input name="name" type="text" value="${esc(name)}" maxlength="120">
      </label>
      <label class="auto-card-field auto-card-wide">
        <span>Instruction</span>
        <textarea name="instruction" rows="3">${esc(instruction)}</textarea>
      </label>
      <label class="auto-card-field">
        <span>Deliver to</span>
        <div class="auto-card-target">${esc(targetLabel(p))}</div>
        <input name="chatId" type="number" value="${esc(chatValue)}" placeholder="Telegram chat id">
      </label>
    </div>
    <div class="auto-card-actions">
      <button type="button" class="btn btn-primary" data-automation-create>Create job</button>
      <button type="button" class="btn" data-automation-discard>Discard</button>
    </div>
  </section>`;
}
