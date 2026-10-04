/**
 * Face and voice helpers (session S4 of docs/plans/jarvis-fleet-plan.md).
 *
 * Pure string / value helpers only, so `tests/web/agent-face-helpers.test.ts`
 * covers them without a DOM. The fetch + `<audio>` glue that needs the auth
 * token and a document lives in `agent-face.js`.
 */
import { esc } from '../ui/index.js';

export const AVATAR_MAX_BYTES = 512 * 1024;
export const AVATAR_TYPES = ['image/png', 'image/jpeg'];
/** Select value that reveals the free-text voice id input. */
export const CUSTOM_VOICE = '__custom__';
export const SPEAK_STATES = ['idle', 'busy', 'playing'];

export function avatarEndpoint(id) {
  return `/api/agents/${encodeURIComponent(id)}/avatar`;
}

export function speakEndpoint(id) {
  return `/api/agents/${encodeURIComponent(id)}/speak`;
}

/**
 * `<img src>` cannot send the Bearer header, so the avatar GET accepts the
 * session token as `?token=`. Null in, null out; no token, url unchanged.
 */
export function withToken(url, token) {
  if (!url) return null;
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

/** Client-side pre-check mirroring the server's limits (type by declared MIME). */
export function validateAvatarFile(file) {
  if (!file || typeof file !== 'object') return { ok: false, error: 'Pick a PNG or JPEG image.' };
  if (!AVATAR_TYPES.includes(file.type)) {
    return { ok: false, error: 'The face must be a PNG or JPEG image.' };
  }
  if (!(Number(file.size) > 0)) return { ok: false, error: 'That file is empty.' };
  if (file.size > AVATAR_MAX_BYTES) {
    return { ok: false, error: `The face must be at most ${AVATAR_MAX_BYTES / 1024} KB.` };
  }
  return { ok: true };
}

/** "Change face" control rendered inside the presence avatar. */
export function faceControl(id, { hasAvatar = false } = {}) {
  const remove = hasAvatar
    ? '<button type="button" class="presence-face-btn presence-face-remove" id="face-remove" title="Remove face" aria-label="Remove face">&times;</button>'
    : '';
  return `<span class="presence-face" data-bot-id="${esc(id)}">
    <input type="file" id="face-input" accept="image/png,image/jpeg" hidden>
    <button type="button" class="presence-face-btn" id="face-change" title="Change face" aria-label="Change face">&#9998;</button>${remove}
  </span>`;
}

/** Play button next to the now-line. */
export function speakButton({ state = 'idle' } = {}) {
  const s = SPEAK_STATES.includes(state) ? state : 'idle';
  const label = s === 'busy' ? 'Generating voice' : s === 'playing' ? 'Stop' : 'Say it aloud';
  const glyph = s === 'busy' ? '&#8230;' : s === 'playing' ? '&#9632;' : '&#9654;';
  const disabled = s === 'busy' ? ' disabled' : '';
  return `<button type="button" class="presence-speak" id="presence-speak" data-state="${s}" title="${label}" aria-label="${label}"${disabled}>${glyph}</button>`;
}

export function voiceLabel(v) {
  if (!v) return '';
  const name = v.name || v.voice_id || '';
  const l = v.labels && typeof v.labels === 'object' ? v.labels : {};
  const tags = [l.gender, l.accent, l.age].filter(Boolean);
  return tags.length ? `${name} (${tags.join(', ')})` : name;
}

export function isKnownVoice(voices, id) {
  return Array.isArray(voices) && voices.some((v) => v && v.voice_id === id);
}

/**
 * `<option>`s for the voice select: global default, every ElevenLabs voice,
 * the current id as its own entry when it is not in the list, and the custom
 * escape hatch. `selected` is the bot's current `tts.voiceId` ('' = global).
 */
export function voiceOptions(voices = [], { selected = '', defaultVoiceId = '' } = {}) {
  const list = Array.isArray(voices) ? voices.filter((v) => v?.voice_id) : [];
  const current = selected || '';
  const def = list.find((v) => v.voice_id === defaultVoiceId);
  const defLabel = def
    ? `Global default (${voiceLabel(def)})`
    : defaultVoiceId
      ? `Global default (${defaultVoiceId})`
      : 'Global default';
  const out = [`<option value=""${current ? '' : ' selected'}>${esc(defLabel)}</option>`];
  for (const v of list) {
    const preview = v.preview_url ? ` data-preview="${esc(v.preview_url)}"` : '';
    const sel = v.voice_id === current ? ' selected' : '';
    out.push(`<option value="${esc(v.voice_id)}"${preview}${sel}>${esc(voiceLabel(v))}</option>`);
  }
  if (current && !isKnownVoice(list, current)) {
    out.push(`<option value="${esc(current)}" selected>${esc(current)} (custom)</option>`);
  }
  out.push(`<option value="${CUSTOM_VOICE}">Custom voice id…</option>`);
  return out.join('');
}

/** The voiceId to persist from the select + custom input; undefined = global. */
export function resolveVoiceChoice(selectValue, customValue) {
  const sel = selectValue == null ? '' : String(selectValue);
  if (sel === CUSTOM_VOICE) {
    const custom = customValue == null ? '' : String(customValue).trim();
    return custom || undefined;
  }
  return sel || undefined;
}
