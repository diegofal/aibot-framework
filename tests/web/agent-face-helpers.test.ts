import { describe, expect, it } from 'bun:test';
import {
  AVATAR_MAX_BYTES,
  AVATAR_TYPES,
  CUSTOM_VOICE,
  SPEAK_STATES,
  avatarEndpoint,
  faceControl,
  isKnownVoice,
  resolveVoiceChoice,
  speakButton,
  speakEndpoint,
  validateAvatarFile,
  voiceLabel,
  voiceOptions,
  withToken,
} from '../../web/pages/agent-face-helpers.js';

describe('avatarEndpoint / speakEndpoint / withToken', () => {
  it('encodes the id and appends the token to a bare or already-queried url', () => {
    expect(avatarEndpoint('a b/c')).toBe('/api/agents/a%20b%2Fc/avatar');
    expect(speakEndpoint('b1')).toBe('/api/agents/b1/speak');
    expect(withToken('/api/agents/b1/avatar', 'sess_1')).toBe('/api/agents/b1/avatar?token=sess_1');
    expect(withToken('/api/agents/b1/avatar?v=7', 'se ss')).toBe(
      '/api/agents/b1/avatar?v=7&token=se%20ss'
    );
    expect(withToken('/api/agents/b1/avatar?v=7', '')).toBe('/api/agents/b1/avatar?v=7');
    expect(withToken(null, 'sess_1')).toBeNull();
    expect(withToken(undefined, 'sess_1')).toBeNull();
  });
});

describe('validateAvatarFile', () => {
  it('accepts PNG and JPEG under the limit and rejects the rest with a reason', () => {
    expect(validateAvatarFile({ type: 'image/png', size: 10 })).toEqual({ ok: true });
    expect(validateAvatarFile({ type: 'image/jpeg', size: AVATAR_MAX_BYTES })).toEqual({
      ok: true,
    });
    expect(validateAvatarFile({ type: 'image/gif', size: 10 }).ok).toBe(false);
    expect(validateAvatarFile({ type: 'image/gif', size: 10 }).error).toContain('PNG');
    const big = validateAvatarFile({ type: 'image/png', size: AVATAR_MAX_BYTES + 1 });
    expect(big.ok).toBe(false);
    expect(big.error).toContain('512');
    expect(validateAvatarFile(null).ok).toBe(false);
    expect(validateAvatarFile({ type: '', size: 0 }).ok).toBe(false);
    expect(AVATAR_TYPES).toEqual(['image/png', 'image/jpeg']);
  });
});

describe('faceControl', () => {
  it('renders a hidden file input, a change button and a remove button only with a face', () => {
    const html = faceControl('b<1>', { hasAvatar: false });
    expect(html).toContain('id="face-input"');
    expect(html).toContain('accept="image/png,image/jpeg"');
    expect(html).toContain('id="face-change"');
    expect(html).toContain('data-bot-id="b&lt;1&gt;"');
    expect(html).not.toContain('id="face-remove"');
    const withFace = faceControl('b1', { hasAvatar: true });
    expect(withFace).toContain('id="face-remove"');
  });
});

describe('speakButton', () => {
  it('has three states and is disabled while busy', () => {
    expect(SPEAK_STATES).toEqual(['idle', 'busy', 'playing']);
    const idle = speakButton();
    expect(idle).toContain('id="presence-speak"');
    expect(idle).toContain('data-state="idle"');
    expect(idle).not.toContain('disabled');
    const busy = speakButton({ state: 'busy' });
    expect(busy).toContain('data-state="busy"');
    expect(busy).toContain('disabled');
    const playing = speakButton({ state: 'playing' });
    expect(playing).toContain('data-state="playing"');
    expect(playing).toContain('aria-label="Stop"');
    expect(speakButton({ state: 'weird' })).toContain('data-state="idle"');
  });
});

const VOICES = [
  {
    voice_id: 'v1',
    name: 'Rachel',
    labels: { gender: 'female', accent: 'american', age: 'young' },
    preview_url: 'https://x/r.mp3',
  },
  { voice_id: 'v2', name: 'Adam <b>', labels: {}, preview_url: null },
];

describe('voiceLabel / isKnownVoice', () => {
  it('joins the interesting labels and tolerates missing ones', () => {
    expect(voiceLabel(VOICES[0])).toBe('Rachel (female, american, young)');
    expect(voiceLabel(VOICES[1])).toBe('Adam <b>');
    expect(voiceLabel({ voice_id: 'x' })).toBe('x');
    expect(isKnownVoice(VOICES, 'v2')).toBe(true);
    expect(isKnownVoice(VOICES, 'nope')).toBe(false);
    expect(isKnownVoice(undefined, 'v1')).toBe(false);
  });
});

describe('voiceOptions', () => {
  it('lists global default, every voice escaped, and the custom escape hatch', () => {
    const html = voiceOptions(VOICES, { defaultVoiceId: 'v2' });
    expect(html).toContain('<option value="" selected>Global default (Adam &lt;b&gt;)</option>');
    expect(html).toContain(
      '<option value="v1" data-preview="https://x/r.mp3">Rachel (female, american, young)</option>'
    );
    expect(html).toContain('<option value="v2">Adam &lt;b&gt;</option>');
    expect(html).toContain(`<option value="${CUSTOM_VOICE}">Custom voice id…</option>`);
  });
  it('selects the current voice, or exposes an unknown current id as its own option', () => {
    const known = voiceOptions(VOICES, { selected: 'v1', defaultVoiceId: 'v2' });
    expect(known).toContain('<option value="v1" data-preview="https://x/r.mp3" selected>');
    expect(known).not.toContain('value="" selected');
    const unknown = voiceOptions(VOICES, { selected: 'zzz', defaultVoiceId: 'v2' });
    expect(unknown).toContain('<option value="zzz" selected>zzz (custom)</option>');
    const none = voiceOptions([], { selected: 'zzz' });
    expect(none).toContain('Global default</option>');
    expect(none).toContain('<option value="zzz" selected>zzz (custom)</option>');
    expect(none).toContain(CUSTOM_VOICE);
  });
});

describe('resolveVoiceChoice', () => {
  it('maps the select and custom input to the voiceId to save', () => {
    expect(resolveVoiceChoice('', '')).toBeUndefined();
    expect(resolveVoiceChoice('v1', 'ignored')).toBe('v1');
    expect(resolveVoiceChoice(CUSTOM_VOICE, '  abc123 ')).toBe('abc123');
    expect(resolveVoiceChoice(CUSTOM_VOICE, '   ')).toBeUndefined();
    expect(resolveVoiceChoice(undefined, undefined)).toBeUndefined();
  });
});
