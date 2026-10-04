/**
 * Create-an-agent wizard — #/agents/new (session S6 of
 * docs/plans/jarvis-fleet-plan.md).
 *
 * Three screens: who (name + purpose, derived id), personality (four sliders
 * onto the trait registers + quirks), channels (web chat always on; Telegram /
 * WhatsApp / Discord optional with inline token validation; an Advanced block
 * holding the old form's fields). "Create" posts once to /api/agents (the
 * server writes the soul, GOALS.md and TRAITS.json before registering the
 * bot), starts the agent, opens its first conversation with a greeting, and
 * lands on #/agents/:id with the chat focused.
 *
 * All state, validation and markup live in agent-wizard-helpers.js (pure);
 * this file only wires the DOM.
 */
import { showToast } from '../ui/index.js';
import {
  CUSTOM_PRESET,
  FOCUS_CHAT_KEY,
  GREETING_TEXT,
  STEPS,
  applyField,
  applyPresetToState,
  buildCreatePayload,
  canCreate,
  initialState,
  localTokenClass,
  personalityBlurb,
  presetStrip,
  progressMarkup,
  stepChannels,
  stepIndicator,
  stepPersonality,
  stepWho,
  validateStep,
  wizardFooter,
} from './agent-wizard-helpers.js';
import { api } from './shared.js';

let state = null;
let root = null;
let defaults = null;
/** GET /api/agents/presets: null while loading, [] when unavailable (no strip). */
let presets = null;
let checkTimer = null;
let busy = false;
/** Errors shown for the current step; only populated after a failed Next/Create. */
let shownErrors = {};

export function destroyAgentWizard() {
  clearTimeout(checkTimer);
  checkTimer = null;
  state = null;
  root = null;
  presets = null;
  busy = false;
  shownErrors = {};
}

function coerce(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'range') return Number(input.value) / 100;
  return input.value;
}

function render() {
  if (!root || !state) return;
  const step = state.step;
  const pane =
    step === 0
      ? stepWho(state, shownErrors, { presets })
      : step === 1
        ? stepPersonality(state, shownErrors)
        : stepChannels(state, shownErrors, { defaults: defaults || {} });
  root.innerHTML = `
    <div class="wizard">
      <div class="wizard-head">
        <div class="page-title">New agent</div>
        ${stepIndicator(step)}
      </div>
      <form class="wizard-form" id="wizard-form" autocomplete="off">
        ${pane}
        ${wizardFooter(step, { busy, valid: step < STEPS.length - 1 || canCreate(state) })}
      </form>
    </div>`;
  wire();
  const first = root.querySelector(
    '.wizard-pane input:not([type=checkbox]), .wizard-pane textarea'
  );
  if (first && step === 0 && !state.name) first.focus();
}

/** Re-render just the personality blurb so sliders stay smooth. */
function refreshBlurb() {
  const el = root?.querySelector('#wiz-blurb');
  if (el) el.textContent = personalityBlurb(state.personality);
}

function refreshFooter() {
  const btn = root?.querySelector('[data-action="create"], [data-action="next"]');
  if (!btn) return;
  const last = state.step === STEPS.length - 1;
  btn.disabled = busy || (last && !canCreate(state));
}

/** Swap just the preset strip once the catalogue arrives, so typing in the name box is not interrupted. */
function paintPresets() {
  const slot = root?.querySelector('[data-presets-slot]');
  if (slot) slot.innerHTML = presetStrip(presets, state.preset);
}

/** A preset card click: prefill what the user has not typed, then redraw the pane. */
function pickPreset(id) {
  const preset = id ? (presets || []).find((p) => p.id === id) : CUSTOM_PRESET;
  if (!preset) return;
  state = applyPresetToState(state, preset);
  shownErrors = {};
  render();
  // Preset ids are slugs; CSS.escape is belt and braces (absent in the test stub).
  const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
  root.querySelector(`[data-preset="${sel}"]`)?.focus();
}

function wire() {
  const form = root.querySelector('#wizard-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.step < STEPS.length - 1) next();
    else create();
  });
  // Delegated: the strip is repainted when the catalogue arrives (paintPresets).
  form.addEventListener('click', (e) => {
    const card = e.target.closest?.('[data-preset]');
    if (card) pickPreset(card.dataset.preset);
  });

  for (const input of root.querySelectorAll('[data-field]')) {
    const field = input.dataset.field;
    const handler = () => {
      state = applyField(state, field, coerce(input));
      if (field.startsWith('personality.')) refreshBlurb();
      // Structural fields re-render the pane; text stays in place while typing.
      if (field.endsWith('.enabled') || field === 'advanced.llmBackend') {
        shownErrors = {};
        render();
        return;
      }
      if (field === 'name' && !state.idTouched) {
        const idInput = root.querySelector('#wiz-id');
        if (idInput) idInput.value = state.id;
      }
      if (field === 'channels.telegram.token') scheduleTelegramCheck();
      if (Object.keys(shownErrors).length > 0) {
        shownErrors = validateStep(state, state.step).errors;
        syncErrors();
      }
      refreshFooter();
    };
    input.addEventListener('input', handler);
    input.addEventListener('change', handler);
  }

  root.querySelector('[data-action="back"]')?.addEventListener('click', () => {
    shownErrors = {};
    state = { ...state, step: Math.max(0, state.step - 1) };
    render();
  });
  root.querySelector('[data-action="next"]')?.addEventListener('click', next);
  root.querySelector('[data-action="create"]')?.addEventListener('click', create);
  root.querySelector('[data-check="telegram"]')?.addEventListener('click', () => {
    clearTimeout(checkTimer);
    runTelegramCheck();
  });
}

/** Update inline error text without rebuilding the inputs. */
function syncErrors() {
  for (const el of root.querySelectorAll('.wizard-error')) el.remove();
  for (const [key, msg] of Object.entries(shownErrors)) {
    const anchor =
      root.querySelector(`[data-field="${key}"]`)?.closest('.form-group') ||
      root.querySelector(`[data-channel="${key}"]`);
    if (!anchor) continue;
    const div = document.createElement('div');
    div.className = 'wizard-error';
    div.textContent = msg;
    anchor.appendChild(div);
  }
}

function next() {
  const { ok, errors } = validateStep(state, state.step);
  shownErrors = errors;
  if (!ok) {
    syncErrors();
    return;
  }
  state = { ...state, step: Math.min(STEPS.length - 1, state.step + 1) };
  render();
}

function scheduleTelegramCheck() {
  clearTimeout(checkTimer);
  const token = state.channels.telegram.token;
  const cls = localTokenClass('telegram', token);
  if (cls !== 'shaped') {
    state = applyField(state, 'tokenChecks.telegram', cls === 'missing' ? null : { state: cls });
    paintTokenStatus();
    return;
  }
  state = applyField(state, 'tokenChecks.telegram', { state: 'checking' });
  paintTokenStatus();
  checkTimer = setTimeout(runTelegramCheck, 600);
}

async function runTelegramCheck() {
  const token = state.channels.telegram.token.trim();
  if (!token) return;
  state = applyField(state, 'tokenChecks.telegram', { state: 'checking' });
  paintTokenStatus();
  const res = await api('/api/agents/validate-token', {
    method: 'POST',
    body: { kind: 'telegram', token },
  });
  if (!state || state.channels.telegram.token.trim() !== token) return; // stale
  state = applyField(
    state,
    'tokenChecks.telegram',
    res?.error ? { state: 'error', detail: res.error } : res
  );
  paintTokenStatus();
  if (Object.keys(shownErrors).length > 0) {
    shownErrors = validateStep(state, state.step).errors;
    syncErrors();
  }
  refreshFooter();
}

function paintTokenStatus() {
  const holder = root?.querySelector('[data-status="telegram"]');
  if (!holder) return;
  // channelCard() owns the markup; borrow just the badge from a throwaway render.
  const tmp = document.createElement('div');
  tmp.innerHTML = stepChannels(state, {}, { defaults: defaults || {} });
  holder.innerHTML = tmp.querySelector('[data-status="telegram"]')?.innerHTML ?? '';
}

async function create() {
  if (busy) return;
  const { ok, errors } = validateStep(state, state.step);
  shownErrors = errors;
  if (!ok || !canCreate(state)) {
    syncErrors();
    return;
  }
  busy = true;
  const payload = buildCreatePayload(state);
  const id = payload.id;
  root.innerHTML = `<div class="wizard">${progressMarkup('soul', `${payload.name} is being written — this is one Claude call, usually 20–40 s.`)}</div>`;

  const created = await api('/api/agents', { method: 'POST', body: payload });
  if (!created || created.error) {
    busy = false;
    showToast(created?.error || 'Could not create the agent', { tone: 'danger', duration: 8000 });
    state = { ...state, step: STEPS.length - 1 };
    render();
    return;
  }

  if (payload.enabled) {
    root.innerHTML = `<div class="wizard">${progressMarkup('start')}</div>`;
    const started = await api(`/api/agents/${encodeURIComponent(id)}/start?enable=true`, {
      method: 'POST',
    });
    if (started?.error) {
      showToast(`Created, but could not start: ${started.error}`, { tone: 'warn', duration: 8000 });
    } else if (payload.greet) {
      root.innerHTML = `<div class="wizard">${progressMarkup('greet')}</div>`;
      await sendGreeting(id, payload.name);
    }
  }

  showToast(`${payload.name} is ready`, { tone: 'ok' });
  try {
    sessionStorage.setItem(FOCUS_CHAT_KEY, id);
  } catch {
    /* private mode */
  }
  destroyAgentWizard();
  location.hash = `#/agents/${encodeURIComponent(id)}`;
}

/** Open the agent's first dashboard conversation and ask it to say hello. */
async function sendGreeting(id, name) {
  const base = `/api/conversations/${encodeURIComponent(id)}`;
  const convo = await api(base, {
    method: 'POST',
    body: { type: 'general', title: `Chat with ${name}` },
  });
  if (!convo?.id) return;
  await api(`${base}/${encodeURIComponent(convo.id)}/messages`, {
    method: 'POST',
    body: { message: GREETING_TEXT },
  });
}

export async function renderAgentWizard(el) {
  destroyAgentWizard();
  root = el;
  state = initialState();
  render();
  const [d, p] = await Promise.all([
    api('/api/agents/defaults').catch(() => null),
    api('/api/agents/presets').catch(() => null),
  ]);
  if (!root) return; // navigated away while loading
  defaults = d?.error ? null : d;
  // The defaults only feed the Advanced block on step 3; no re-render needed now.
  presets = Array.isArray(p) ? p : [];
  paintPresets();
}
