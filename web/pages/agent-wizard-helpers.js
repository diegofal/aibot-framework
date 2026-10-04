/**
 * Pure helpers for the create-an-agent wizard (#/agents/new, session S6 of
 * docs/plans/jarvis-fleet-plan.md). No DOM: state, validation, the
 * slider -> trait mapping and every piece of markup are functions of their
 * arguments, so tests/web/agent-wizard-helpers.test.ts covers them.
 *
 * Slider -> trait mapping (mirrored server-side in src/bot/agent-wizard.ts,
 * which is what actually writes TRAITS.json; the two share test vectors):
 *
 *   warmth       -> sociability  up   (reaches out, asks, shares)
 *                -> independence down (checks in with the human more often)
 *   boldness     -> risk_tolerance up (tries new tool patterns)
 *                -> caution      down (higher executor temperature)
 *   rigor        -> depth        up   (more tool rounds per execution)
 *                -> persistence  up   (keeps at a goal longer before dropping it)
 *   playfulness  -> creativity   up   (planner/executor temperature)
 *                -> curiosity    up   (research tools always in the set)
 *
 * A slider is 0..1; a trait register is 0.1..0.9. `up` is 0.1 + 0.8·x,
 * `down` is 0.9 − 0.8·x, so 0.5 on every slider is the default trait set and
 * mirrored sliders give mirrored traits.
 */
import { badge, esc } from '../ui/index.js';

export const TRAIT_MIN = 0.1;
export const TRAIT_MAX = 0.9;

export const PERSONALITY_AXES = [
  {
    id: 'warmth',
    label: 'Warmth',
    low: 'Reserved',
    high: 'Warm',
    hint: 'How much it reaches out and checks in with you.',
    drives: [
      ['sociability', 1],
      ['independence', -1],
    ],
  },
  {
    id: 'boldness',
    label: 'Boldness',
    low: 'Careful',
    high: 'Bold',
    hint: 'Whether it tries new approaches or sticks to what worked.',
    drives: [
      ['risk_tolerance', 1],
      ['caution', -1],
    ],
  },
  {
    id: 'rigor',
    label: 'Rigor',
    low: 'Light touch',
    high: 'Thorough',
    hint: 'How deep it digs before answering, and how long it keeps at a goal.',
    drives: [
      ['depth', 1],
      ['persistence', 1],
    ],
  },
  {
    id: 'playfulness',
    label: 'Playfulness',
    low: 'Serious',
    high: 'Playful',
    hint: 'Creativity and curiosity in how it plans and writes.',
    drives: [
      ['creativity', 1],
      ['curiosity', 1],
    ],
  },
];

export const DEFAULT_PERSONALITY = Object.freeze({
  warmth: 0.5,
  boldness: 0.5,
  rigor: 0.5,
  playfulness: 0.5,
});

export const STEPS = ['Who', 'Personality', 'Channels'];
export const CHANNEL_KINDS = ['telegram', 'whatsapp', 'discord'];
export const ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const GREETING_TEXT = 'Hi! Introduce yourself in two sentences.';
/** sessionStorage key: the Agent Home focuses its chat box once when it holds the new bot id. */
export const FOCUS_CHAT_KEY = 'aibot.wizard.focusChat';
export const QUIRKS_MAX = 1000;
export const PURPOSE_MIN = 8;
/** Same shape as the per-bot `agentLoop.every` the server accepts ("30m", "2h", "1d"). */
export const LOOP_EVERY_PATTERN = /^\d+[mhd]$/;

/**
 * The "Custom" card of the preset strip (S7): no preset id. Passing it (or
 * null) to applyPresetToState clears whatever a previous preset filled.
 */
export const CUSTOM_PRESET = Object.freeze({
  id: '',
  name: 'Custom',
  emoji: '✨',
  description: 'Start from scratch: your own purpose, personality and goals.',
});

/** Same shapes as src/bot/telegram-errors.ts and src/bot/agent-wizard.ts. */
export const TELEGRAM_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
export const DISCORD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/;

const round2 = (n) => Math.round(n * 100) / 100;

function clampAxis(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** Eight trait registers (0.1..0.9) from the four sliders (0..1). */
export function traitsFromPersonality(p) {
  const out = {};
  for (const axis of PERSONALITY_AXES) {
    const x = clampAxis(p?.[axis.id] ?? 0.5);
    for (const [trait, dir] of axis.drives) {
      const raw = dir > 0 ? TRAIT_MIN + 0.8 * x : TRAIT_MAX - 0.8 * x;
      out[trait] = round2(Math.min(TRAIT_MAX, Math.max(TRAIT_MIN, raw)));
    }
  }
  return out;
}

/** Inverse of traitsFromPersonality: each axis is the mean of its two drives. */
export function personalityFromTraits(t) {
  if (!t || typeof t !== 'object') return { ...DEFAULT_PERSONALITY };
  const out = {};
  for (const axis of PERSONALITY_AXES) {
    const xs = axis.drives.map(([trait, dir]) => {
      const v = Number(t[trait]);
      if (!Number.isFinite(v)) return 0.5;
      return dir > 0 ? (v - TRAIT_MIN) / 0.8 : (TRAIT_MAX - v) / 0.8;
    });
    out[axis.id] = round2(clampAxis(xs.reduce((a, b) => a + b, 0) / xs.length));
  }
  return out;
}

/** One sentence for the personality preview ("warm, careful, thorough and serious"). */
export function personalityBlurb(p) {
  const words = PERSONALITY_AXES.map((axis) => {
    const x = clampAxis(p?.[axis.id] ?? 0.5);
    if (x < 0.35) return axis.low.toLowerCase();
    if (x > 0.65) return axis.high.toLowerCase();
    return null;
  }).filter(Boolean);
  if (words.length === 0) return 'A balanced personality — even on every axis.';
  const list =
    words.length === 1
      ? words[0]
      : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  const rest = 4 - words.length;
  return `${list[0].toUpperCase()}${list.slice(1)}${rest > 0 ? ', balanced otherwise' : ''}.`;
}

/** Slug a display name into a config id ("Señor Café" -> "senor-cafe"). */
export function deriveId(name) {
  const s = String(name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 40).replace(/-+$/g, '');
}

export function initialState() {
  return {
    step: 0,
    name: '',
    purpose: '',
    id: '',
    idTouched: false,
    personality: { ...DEFAULT_PERSONALITY },
    quirks: '',
    channels: {
      web: true,
      telegram: { enabled: false, token: '' },
      whatsapp: { enabled: false, phoneNumberId: '', accessToken: '', verifyToken: '' },
      discord: { enabled: false, token: '' },
    },
    tokenChecks: {},
    /** Selected preset id ('' = Custom) and the values it filled, so a later pick never clobbers user edits. */
    preset: '',
    presetFilled: {},
    advanced: {
      language: 'Spanish',
      emoji: '',
      llmBackend: '',
      model: '',
      generateWith: '',
      startNow: true,
      /** Comma-separated lists and loop overrides; empty = server default (or the preset's). */
      skills: '',
      disabledTools: '',
      loopEvery: '',
      loopMode: '',
    },
  };
}

/** "a, b\n c" | ['a', 'b'] -> ['a', 'b', 'c'] — trimmed, no empties, no duplicates. */
export function parseList(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[,\s]+/);
  const out = [];
  for (const raw of parts) {
    const s = String(raw ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Values a preset drives, keyed by applyField path. */
function presetFieldValues(preset) {
  const p = preset.personality ?? {};
  return {
    purpose: String(preset.purpose ?? ''),
    quirks: String(preset.quirks ?? ''),
    ...Object.fromEntries(
      PERSONALITY_AXES.map((a) => [`personality.${a.id}`, clampAxis(p[a.id] ?? 0.5)])
    ),
    'advanced.emoji': String(preset.emoji ?? ''),
    'advanced.skills': parseList(preset.skills).join(', '),
    'advanced.disabledTools': parseList(preset.disabledTools).join(', '),
    'advanced.loopEvery': String(preset.agentLoop?.every ?? ''),
    'advanced.loopMode': String(preset.agentLoop?.mode ?? ''),
  };
}

const BLANK_PRESET_FIELDS = Object.freeze({
  ...presetFieldValues({}),
  name: '',
});

const sameValue = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');

/**
 * Prefill the wizard from a preset (the server's GET /api/agents/presets
 * shape). Immutable. A field is filled only if the user has not touched it:
 * still blank/default when no preset was applied before, or still holding
 * exactly what the previous preset put there. The name is a suggestion on the
 * same terms (the id derives from it through applyField). CUSTOM_PRESET / null
 * resets every preset-filled field to blank and clears the preset id.
 */
export function applyPresetToState(state, preset) {
  const isCustom = !preset || !preset.id;
  const target = isCustom
    ? BLANK_PRESET_FIELDS
    : { ...presetFieldValues(preset), name: String(preset.name ?? '') };
  const prev = state.presetFilled ?? {};
  let next = state;
  for (const [path, value] of Object.entries(target)) {
    const baseline = path in prev ? prev[path] : BLANK_PRESET_FIELDS[path];
    if (sameValue(getPath(state, path), baseline)) next = applyField(next, path, value);
  }
  return {
    ...next,
    preset: isCustom ? '' : String(preset.id),
    presetFilled: isCustom ? {} : target,
  };
}

function setPath(obj, path, value) {
  const [head, ...rest] = path;
  const copy = Array.isArray(obj) ? [...obj] : { ...(obj ?? {}) };
  copy[head] = rest.length === 0 ? value : setPath(obj?.[head], rest, value);
  return copy;
}

/**
 * Immutable field update. `name` derives `id` until the id is edited by hand;
 * clearing the id hands derivation back to the name.
 */
export function applyField(state, name, value) {
  const path = String(name).split('.');
  if (path[0] === 'id' && path.length === 1) {
    const id = String(value ?? '').trim();
    if (id === '') {
      return { ...state, idTouched: false, id: deriveId(state.name) };
    }
    return { ...state, idTouched: true, id };
  }
  const next = setPath(state, path, value);
  if (path[0] === 'name' && path.length === 1 && !state.idTouched) {
    next.id = deriveId(value);
  }
  return next;
}

/** Client-side shape check; the server does the same plus a live getMe for Telegram. */
export function localTokenClass(kind, token) {
  const t = String(token ?? '').trim();
  if (t === '') return 'missing';
  if (kind === 'telegram') return TELEGRAM_TOKEN_PATTERN.test(t) ? 'shaped' : 'placeholder';
  if (kind === 'discord') return DISCORD_TOKEN_PATTERN.test(t) ? 'shaped' : 'placeholder';
  return 'shaped';
}

function validateWho(state) {
  const errors = {};
  if (String(state.name ?? '').trim().length < 2) errors.name = 'Give the agent a name.';
  const purpose = String(state.purpose ?? '').trim();
  if (purpose.length < PURPOSE_MIN) {
    errors.purpose = 'One sentence on what this agent is for (at least a few words).';
  }
  const id = String(state.id ?? '').trim();
  if (!id) errors.id = 'An id is required (derived from the name).';
  else if (!ID_PATTERN.test(id)) {
    errors.id = 'Lowercase letters, digits, "-", "_" or "."; must start with a letter or digit.';
  }
  return errors;
}

function validatePersonality(state) {
  const errors = {};
  if (String(state.quirks ?? '').length > QUIRKS_MAX) {
    errors.quirks = `Keep quirks under ${QUIRKS_MAX} characters.`;
  }
  return errors;
}

function validateChannels(state) {
  const errors = {};
  const ch = state.channels ?? {};
  if (ch.telegram?.enabled) {
    const cls = localTokenClass('telegram', ch.telegram.token);
    if (cls === 'missing') errors.telegram = 'Paste the bot token from @BotFather.';
    else if (cls === 'placeholder') {
      errors.telegram = 'That does not look like a Telegram token (digits:secret).';
    } else {
      const check = state.tokenChecks?.telegram;
      if (check?.state === 'revoked') {
        errors.telegram = `Telegram rejected this token${check.detail ? ` — ${check.detail}` : ''}.`;
      }
    }
  }
  if (ch.whatsapp?.enabled) {
    if (
      !String(ch.whatsapp.phoneNumberId ?? '').trim() ||
      !String(ch.whatsapp.accessToken ?? '').trim()
    ) {
      errors.whatsapp = 'WhatsApp needs a phone number id and an access token.';
    }
  }
  if (ch.discord?.enabled) {
    const cls = localTokenClass('discord', ch.discord.token);
    if (cls === 'missing') errors.discord = 'Paste the Discord bot token.';
    else if (cls === 'placeholder') {
      errors.discord = 'That does not look like a Discord bot token (three dot-separated parts).';
    }
  }
  const every = String(state.advanced?.loopEvery ?? '').trim();
  if (every && !LOOP_EVERY_PATTERN.test(every)) {
    errors['advanced.loopEvery'] = 'Use a duration like 30m, 2h or 1d.';
  }
  return errors;
}

/** `{ ok, errors }` for one step. */
export function validateStep(state, step) {
  const errors =
    step === 0
      ? validateWho(state)
      : step === 1
        ? validatePersonality(state)
        : validateChannels(state);
  return { ok: Object.keys(errors).length === 0, errors };
}

export function canCreate(state) {
  return STEPS.every((_, i) => validateStep(state, i).ok);
}

/** The POST /api/agents body. Disabled channels never leak their credentials. */
export function buildCreatePayload(state) {
  const ch = state.channels ?? {};
  const adv = state.advanced ?? {};
  const body = {
    id: String(state.id ?? '').trim(),
    name: String(state.name ?? '').trim(),
    purpose: String(state.purpose ?? '').trim(),
    personality: Object.fromEntries(
      PERSONALITY_AXES.map((a) => [a.id, clampAxis(state.personality?.[a.id] ?? 0.5)])
    ),
    quirks: String(state.quirks ?? '').trim(),
    token: ch.telegram?.enabled ? String(ch.telegram.token ?? '').trim() || null : null,
    enabled: adv.startNow !== false,
    language: adv.language || 'Spanish',
    greet: true,
  };
  if (ch.whatsapp?.enabled) {
    body.whatsapp = {
      phoneNumberId: String(ch.whatsapp.phoneNumberId ?? '').trim(),
      accessToken: String(ch.whatsapp.accessToken ?? '').trim(),
    };
    const verify = String(ch.whatsapp.verifyToken ?? '').trim();
    if (verify) body.whatsapp.verifyToken = verify;
  }
  if (ch.discord?.enabled) {
    body.discord = { token: String(ch.discord.token ?? '').trim() };
  }
  if (adv.emoji) body.emoji = String(adv.emoji).trim();
  if (adv.llmBackend) body.llmBackend = adv.llmBackend;
  if (adv.model) body.model = String(adv.model).trim();
  if (adv.generateWith) {
    body.generation =
      adv.generateWith === 'claude-cli'
        ? { llmBackend: 'claude-cli' }
        : { llmBackend: 'ollama', model: adv.generateWith };
  }
  // Preset (S7): the id travels too, so the server fills anything left blank
  // here exactly as the wizard would have. Lists and loop overrides only when set.
  if (state.preset) body.preset = String(state.preset);
  const skills = parseList(adv.skills);
  if (skills.length > 0) body.skills = skills;
  const disabledTools = parseList(adv.disabledTools);
  if (disabledTools.length > 0) body.disabledTools = disabledTools;
  const loop = {};
  const every = String(adv.loopEvery ?? '').trim();
  if (every) loop.every = every;
  if (adv.loopMode) loop.mode = String(adv.loopMode);
  if (Object.keys(loop).length > 0) body.agentLoop = loop;
  return body;
}

/**
 * Preset cards for step 1 (S7): "Custom" first, then the catalogue.
 * `presets` null = still loading; [] = nothing to show (no strip at all).
 */
export function presetStrip(presets, selectedId = '') {
  if (presets === null) {
    return '<div class="wizard-presets wizard-presets-loading text-dim">Loading presets…</div>';
  }
  if (!Array.isArray(presets) || presets.length === 0) return '';
  const cards = [CUSTOM_PRESET, ...presets].map((p) => {
    const id = String(p.id ?? '');
    const selected = id === String(selectedId ?? '');
    return `
      <button type="button" class="wizard-preset${selected ? ' wizard-preset-selected' : ''}" data-preset="${esc(id)}" aria-pressed="${selected ? 'true' : 'false'}" title="${esc(p.description ?? '')}">
        <span class="wizard-preset-emoji" aria-hidden="true">${esc(p.emoji ?? '')}</span>
        <span class="wizard-preset-name">${esc(p.name ?? id)}</span>
        <span class="wizard-preset-desc">${esc(p.description ?? '')}</span>
      </button>`;
  });
  return `
    <div class="wizard-presets" role="group" aria-label="Start from a preset">
      ${cards.join('')}
    </div>`;
}

/** `{ text, tone }` for a token check result (`state` from POST /api/agents/validate-token). */
export function tokenStatusLabel(result) {
  if (!result || !result.state) return { text: '', tone: 'muted' };
  switch (result.state) {
    case 'checking':
      return { text: 'Checking with Telegram…', tone: 'muted' };
    case 'ok':
      return { text: `Valid${result.username ? ` — @${result.username}` : ''}`, tone: 'ok' };
    case 'shaped':
      return { text: 'Looks right (not checked live)', tone: 'info' };
    case 'placeholder':
      return { text: 'Does not look like a token', tone: 'warn' };
    case 'missing':
      return { text: 'Empty', tone: 'muted' };
    case 'revoked':
      return { text: `Rejected${result.detail ? ` — ${result.detail}` : ''}`, tone: 'danger' };
    case 'error':
      return { text: `Could not check${result.detail ? ` — ${result.detail}` : ''}`, tone: 'warn' };
    default:
      return { text: String(result.state), tone: 'muted' };
  }
}

const PROGRESS = { soul: 'Writing soul…', start: 'Waking up…', greet: 'Saying hello…' };
export function progressLabel(stage) {
  return PROGRESS[stage] ?? 'Working…';
}

// ── Markup ──

export function stepIndicator(step) {
  return `<ol class="wizard-steps">${STEPS.map((label, i) => {
    const cls =
      i < step ? 'wizard-step-done' : i === step ? 'wizard-step-current' : 'wizard-step-todo';
    const inner = `<span class="wizard-step-n">${i + 1}</span><span class="wizard-step-label">${esc(label)}</span>`;
    // Completed steps are buttons: clicking one jumps back to it.
    const body =
      i < step
        ? `<button type="button" class="wizard-step-jump" data-step-jump="${i}" title="Back to ${esc(label)}">${inner}</button>`
        : inner;
    return `<li class="wizard-step ${cls}">${body}</li>`;
  }).join('')}</ol>`;
}

function fieldError(errors, key) {
  return errors?.[key] ? `<div class="wizard-error">${esc(errors[key])}</div>` : '';
}

export function stepWho(state, errors = {}, opts = {}) {
  // `presets` undefined = the page did not ask for a strip; null = loading; [] = none.
  const strip = opts.presets === undefined ? '' : presetStrip(opts.presets, state.preset);
  return `
    <div class="wizard-pane" data-step="0">
      <h2 class="wizard-title">Who is this agent?</h2>
      <p class="text-dim wizard-lead">A name and one sentence on what it is for. Everything else can wait.</p>
      <div data-presets-slot>${strip}</div>
      <div class="form-group">
        <label for="wiz-name">Name</label>
        <input type="text" id="wiz-name" data-field="name" value="${esc(state.name)}" placeholder="e.g. Ada" autocomplete="off" autofocus>
        ${fieldError(errors, 'name')}
      </div>
      <div class="form-group">
        <label for="wiz-purpose">Purpose, in one sentence</label>
        <textarea id="wiz-purpose" data-field="purpose" rows="2" placeholder="e.g. Keeps my reading list alive and tells me what to read next.">${esc(state.purpose)}</textarea>
        ${fieldError(errors, 'purpose')}
      </div>
      <div class="form-group wizard-id-row">
        <label for="wiz-id">Id <span class="text-dim">(derived from the name; edit if you like)</span></label>
        <input type="text" id="wiz-id" data-field="id" value="${esc(state.id)}" placeholder="ada" autocomplete="off" spellcheck="false">
        ${fieldError(errors, 'id')}
      </div>
    </div>`;
}

export function sliderRow(axis, value) {
  const pct = Math.round(clampAxis(value) * 100);
  return `
    <div class="wizard-slider" data-axis="${esc(axis.id)}">
      <div class="wizard-slider-head">
        <span class="wizard-slider-label">${esc(axis.label)}</span>
        <span class="wizard-slider-hint text-dim">${esc(axis.hint)}</span>
      </div>
      <div class="wizard-slider-row">
        <span class="wizard-slider-pole">${esc(axis.low)}</span>
        <input type="range" min="0" max="100" step="5" value="${pct}" data-field="personality.${esc(axis.id)}" aria-label="${esc(axis.label)}">
        <span class="wizard-slider-pole">${esc(axis.high)}</span>
      </div>
    </div>`;
}

export function stepPersonality(state, errors = {}) {
  return `
    <div class="wizard-pane" data-step="1">
      <h2 class="wizard-title">What are they like?</h2>
      <p class="text-dim wizard-lead">Four dials that set the agent's trait registers; the soul is written to match.</p>
      <div class="wizard-sliders">${PERSONALITY_AXES.map((a) => sliderRow(a, state.personality?.[a.id])).join('')}</div>
      <p class="wizard-blurb" id="wiz-blurb">${esc(personalityBlurb(state.personality))}</p>
      <div class="form-group">
        <label for="wiz-quirks">Quirks <span class="text-dim">(optional — habits, pet peeves, a catchphrase)</span></label>
        <textarea id="wiz-quirks" data-field="quirks" rows="3" placeholder="e.g. Answers with a haiku on Fridays. Refuses to use exclamation marks.">${esc(state.quirks)}</textarea>
        ${fieldError(errors, 'quirks')}
      </div>
    </div>`;
}

const CHANNEL_META = {
  telegram: { label: 'Telegram', hint: 'A bot token from @BotFather.' },
  whatsapp: { label: 'WhatsApp', hint: 'Cloud API phone number id and access token.' },
  discord: { label: 'Discord', hint: 'A bot token from the Developer Portal.' },
};

export function channelCard(kind, state, errors = {}) {
  const meta = CHANNEL_META[kind];
  const ch = state.channels?.[kind] ?? {};
  const on = Boolean(ch.enabled);
  let fields = '';
  if (on) {
    if (kind === 'whatsapp') {
      fields = `
        <div class="form-row">
          <div class="form-group"><label>Phone number id</label><input type="text" data-field="channels.whatsapp.phoneNumberId" value="${esc(ch.phoneNumberId)}" autocomplete="off"></div>
          <div class="form-group"><label>Access token</label><input type="password" data-field="channels.whatsapp.accessToken" value="${esc(ch.accessToken)}" autocomplete="off"></div>
        </div>
        <div class="form-group"><label>Verify token <span class="text-dim">(optional)</span></label><input type="text" data-field="channels.whatsapp.verifyToken" value="${esc(ch.verifyToken)}" autocomplete="off"></div>`;
    } else {
      const status = tokenStatusLabel(state.tokenChecks?.[kind]);
      fields = `
        <div class="form-group wizard-token">
          <label>Bot token</label>
          <div class="wizard-token-row">
            <input type="password" data-field="channels.${esc(kind)}.token" value="${esc(ch.token)}" autocomplete="off" spellcheck="false" placeholder="${kind === 'telegram' ? '123456789:AA…' : 'xxxx.yyyy.zzzz'}">
            ${kind === 'telegram' ? '<button type="button" class="btn btn-sm" data-check="telegram">Check</button>' : ''}
          </div>
          <div class="wizard-token-status" data-status="${esc(kind)}">${status.text ? badge(status.text, status.tone) : ''}</div>
        </div>`;
    }
  }
  return `
    <div class="wizard-channel${on ? ' wizard-channel-on' : ''}" data-channel="${esc(kind)}">
      <label class="wizard-channel-head">
        <input type="checkbox" data-field="channels.${esc(kind)}.enabled"${on ? ' checked' : ''}>
        <span class="wizard-channel-name">${esc(meta.label)}</span>
        <span class="text-dim">${esc(meta.hint)}</span>
      </label>
      ${fields}
      ${fieldError(errors, kind)}
    </div>`;
}

function option(value, label, selected) {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
}

export function advancedBlock(state, { defaults = {}, errors = {} } = {}) {
  const adv = state.advanced ?? {};
  const ollamaModels = (defaults.availableModels || []).filter((m) => m && m !== 'claude-cli');
  const claudeModels = (defaults.claudeCliModels || []).filter((o) => o?.value);
  const genOptions = [
    option('', `Default (${defaults.claudeCliModel || 'Claude CLI'})`, !adv.generateWith),
    option('claude-cli', 'Claude CLI', adv.generateWith === 'claude-cli'),
    ...ollamaModels.map((m) => option(m, `Ollama · ${m}`, adv.generateWith === m)),
  ].join('');
  const backendOptions = [
    option('', 'Global default', !adv.llmBackend),
    option('claude-cli', 'Claude CLI', adv.llmBackend === 'claude-cli'),
    option('ollama', 'Ollama', adv.llmBackend === 'ollama'),
  ].join('');
  const modelOptions =
    adv.llmBackend === 'claude-cli'
      ? [
          option('', `Global default (${defaults.claudeCliModel || 'CLI default'})`, !adv.model),
          ...claudeModels.map((o) => option(o.value, o.label, adv.model === o.value)),
        ].join('')
      : [
          option('', `Global default (${defaults.model || 'primary'})`, !adv.model),
          ...ollamaModels.map((m) => option(m, m, adv.model === m)),
        ].join('');
  return `
    <details class="wizard-advanced"${adv.open ? ' open' : ''}>
      <summary>Advanced</summary>
      <div class="form-row">
        <div class="form-group">
          <label>Soul language</label>
          <select data-field="advanced.language">${option('Spanish', 'Spanish', adv.language !== 'English')}${option('English', 'English', adv.language === 'English')}</select>
        </div>
        <div class="form-group">
          <label>Emoji <span class="text-dim">(AI picks if empty)</span></label>
          <input type="text" data-field="advanced.emoji" value="${esc(adv.emoji)}" maxlength="4" autocomplete="off">
        </div>
      </div>
      <div class="form-group">
        <label>Write the soul with</label>
        <select data-field="advanced.generateWith">${genOptions}</select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Agent backend</label>
          <select data-field="advanced.llmBackend">${backendOptions}</select>
        </div>
        <div class="form-group">
          <label>Agent model</label>
          <select data-field="advanced.model">${modelOptions}</select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Skills <span class="text-dim">(comma-separated; empty = preset's, or all)</span></label>
          <input type="text" data-field="advanced.skills" value="${esc(adv.skills ?? '')}" placeholder="reminders, quick-notes" autocomplete="off" spellcheck="false">
        </div>
        <div class="form-group">
          <label>Disabled tools <span class="text-dim">(comma-separated)</span></label>
          <input type="text" data-field="advanced.disabledTools" value="${esc(adv.disabledTools ?? '')}" placeholder="twitter_post, exec" autocomplete="off" spellcheck="false">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Agent loop every <span class="text-dim">(30m, 2h, 1d)</span></label>
          <input type="text" data-field="advanced.loopEvery" value="${esc(adv.loopEvery ?? '')}" placeholder="${esc(defaults.agentLoopInterval || '6h')}" autocomplete="off" spellcheck="false">
          ${errors['advanced.loopEvery'] ? `<div class="wizard-error">${esc(errors['advanced.loopEvery'])}</div>` : ''}
        </div>
        <div class="form-group">
          <label>Agent loop mode</label>
          <select data-field="advanced.loopMode">${option('', 'Default (periodic)', !adv.loopMode)}${option('periodic', 'Periodic', adv.loopMode === 'periodic')}${option('continuous', 'Continuous', adv.loopMode === 'continuous')}</select>
        </div>
      </div>
      <label class="wizard-check">
        <input type="checkbox" data-field="advanced.startNow"${adv.startNow !== false ? ' checked' : ''}>
        Start the agent right away (needed for the first chat)
      </label>
    </details>`;
}

export function stepChannels(state, errors = {}, opts = {}) {
  return `
    <div class="wizard-pane" data-step="2">
      <h2 class="wizard-title">Where can you reach them?</h2>
      <p class="text-dim wizard-lead">Web chat is always on. Add a messaging channel now or later from the agent's Config page.</p>
      <div class="wizard-channel wizard-channel-on wizard-channel-fixed">
        <div class="wizard-channel-head">
          <input type="checkbox" checked disabled>
          <span class="wizard-channel-name">Web chat</span>
          <span class="text-dim">Talk from the dashboard — no token needed.</span>
        </div>
      </div>
      ${CHANNEL_KINDS.map((k) => channelCard(k, state, errors)).join('')}
      ${advancedBlock(state, { ...opts, errors })}
    </div>`;
}

export function wizardFooter(step, { busy = false, valid = true } = {}) {
  const last = step === STEPS.length - 1;
  return `
    <div class="wizard-footer">
      <a class="btn" href="#/agents" data-action="cancel">Cancel</a>
      <span class="wizard-footer-spacer"></span>
      ${step > 0 ? '<button type="button" class="btn" data-action="back">Back</button>' : ''}
      <button type="button" class="btn btn-primary" data-action="${last ? 'create' : 'next'}"${busy || !valid ? ' disabled' : ''}>${last ? 'Create' : 'Next'}</button>
    </div>`;
}

export function progressMarkup(stage, detail = '') {
  return `
    <div class="wizard-progress" role="status">
      <div class="wizard-progress-dot"></div>
      <div class="wizard-progress-text">${esc(progressLabel(stage))}</div>
      ${detail ? `<div class="text-dim">${esc(detail)}</div>` : ''}
    </div>`;
}

// ── Draft persistence and "start from an existing agent" (UX overhaul phase 5) ──

/** sessionStorage key for the in-progress wizard. */
export const WIZARD_DRAFT_KEY = 'aibot.wizard.draft';

/** True once the user has put anything into the wizard worth keeping. */
export function hasWizardInput(state) {
  if (!state) return false;
  if (String(state.name ?? '').trim() || String(state.purpose ?? '').trim()) return true;
  if (String(state.quirks ?? '').trim() || state.preset || state.fromAgent) return true;
  if (PERSONALITY_AXES.some((a) => (state.personality?.[a.id] ?? 0.5) !== DEFAULT_PERSONALITY[a.id]))
    return true;
  return CHANNEL_KINDS.some((k) => state.channels?.[k]?.enabled);
}

/**
 * Serialized draft. Channel secrets and live token checks are dropped: a
 * draft is a convenience, a token in sessionStorage is a liability.
 */
export function draftFromState(state) {
  const s = state ?? initialState();
  const ch = s.channels ?? {};
  const draft = {
    ...s,
    tokenChecks: {},
    channels: {
      ...ch,
      telegram: { ...(ch.telegram ?? {}), token: '' },
      whatsapp: { ...(ch.whatsapp ?? {}), accessToken: '', verifyToken: '' },
      discord: { ...(ch.discord ?? {}), token: '' },
    },
  };
  return JSON.stringify(draft);
}

/** Parse a stored draft onto a fresh state; null when absent, broken or empty. */
export function restoreDraft(raw) {
  if (!raw) return null;
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const base = initialState();
  const ch = d.channels ?? {};
  const state = {
    ...base,
    ...d,
    personality: { ...base.personality, ...(d.personality ?? {}) },
    channels: {
      web: true,
      telegram: { ...base.channels.telegram, ...(ch.telegram ?? {}), token: '' },
      whatsapp: {
        ...base.channels.whatsapp,
        ...(ch.whatsapp ?? {}),
        accessToken: '',
        verifyToken: '',
      },
      discord: { ...base.channels.discord, ...(ch.discord ?? {}), token: '' },
    },
    tokenChecks: {},
    advanced: { ...base.advanced, ...(d.advanced ?? {}) },
    presetFilled: d.presetFilled && typeof d.presetFilled === 'object' ? d.presetFilled : {},
  };
  const step = Number(state.step);
  state.step = Number.isFinite(step) ? Math.max(0, Math.min(STEPS.length - 1, step)) : 0;
  if (!state.idTouched) state.id = deriveId(state.name);
  return hasWizardInput(state) ? state : null;
}

/**
 * Prefill from an existing agent (GET /api/agents/:id): backend, model,
 * skills, disabled tools, loop cadence and preset. Name, id, purpose and every
 * credential stay the user's to fill.
 */
export function stateFromAgent(agent, state) {
  const base = state ?? initialState();
  const a = agent ?? {};
  const backend = a.llmBackend === 'claude-cli' ? 'claude-cli' : a.model ? 'ollama' : '';
  return {
    ...base,
    preset: a.preset ? String(a.preset) : base.preset,
    presetFilled: a.preset ? {} : base.presetFilled,
    fromAgent: String(a.id ?? ''),
    advanced: {
      ...base.advanced,
      llmBackend: backend,
      model: a.model ? String(a.model) : '',
      skills: parseList(a.skills ?? []).join(', '),
      disabledTools: parseList(a.disabledTools ?? []).join(', '),
      loopEvery: String(a.agentLoop?.every ?? ''),
      loopMode: a.agentLoop?.mode ? String(a.agentLoop.mode) : '',
      emoji: base.advanced.emoji,
      open: true,
    },
  };
}

/** "Start from an existing agent" select for step 1; '' when there are no agents. */
export function fromAgentPicker(agents, selectedId = '') {
  if (!Array.isArray(agents) || agents.length === 0) return '';
  const opts = agents
    .map((a) => {
      const id = String(a?.id ?? '');
      return `<option value="${esc(id)}"${id === selectedId ? ' selected' : ''}>${esc(a?.name ?? id)} (${esc(id)})</option>`;
    })
    .join('');
  return `<div class="form-group wizard-from-agent">
    <label for="wiz-from-agent">Start from an existing agent <span class="text-dim">(copies backend, model, skills, tools and loop settings)</span></label>
    <select id="wiz-from-agent" data-from-agent><option value="">— Start fresh —</option>${opts}</select>
  </div>`;
}
