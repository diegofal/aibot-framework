/**
 * Pure helpers behind #/agents/new (session S6 of docs/plans/jarvis-fleet-plan.md).
 * The slider -> trait vectors here are duplicated in tests/bot/agent-wizard.test.ts
 * so the browser preview and the server's TRAITS.json can never disagree.
 */
import { describe, expect, it } from 'bun:test';
import {
  CHANNEL_KINDS,
  DEFAULT_PERSONALITY,
  GREETING_TEXT,
  ID_PATTERN,
  PERSONALITY_AXES,
  STEPS,
  TRAIT_MAX,
  TRAIT_MIN,
  applyField,
  buildCreatePayload,
  canCreate,
  channelCard,
  deriveId,
  initialState,
  localTokenClass,
  personalityBlurb,
  personalityFromTraits,
  progressLabel,
  sliderRow,
  stepChannels,
  stepIndicator,
  stepPersonality,
  stepWho,
  tokenStatusLabel,
  traitsFromPersonality,
  validateStep,
} from '../../web/pages/agent-wizard-helpers.js';

const TRAITS = [
  'curiosity',
  'caution',
  'sociability',
  'persistence',
  'creativity',
  'independence',
  'depth',
  'risk_tolerance',
];

describe('slider -> trait mapping', () => {
  it('each axis drives exactly two traits and every trait is driven once', () => {
    expect(PERSONALITY_AXES.map((a) => a.id)).toEqual([
      'warmth',
      'boldness',
      'rigor',
      'playfulness',
    ]);
    const driven = PERSONALITY_AXES.flatMap((a) => a.drives.map((d) => d[0]));
    expect(driven.length).toBe(8);
    expect(new Set(driven).size).toBe(8);
    expect(driven.sort()).toEqual([...TRAITS].sort());
    for (const a of PERSONALITY_AXES) expect(a.drives.length).toBe(2);
  });

  it('the neutral personality is the default trait set (all 0.5)', () => {
    const t = traitsFromPersonality(DEFAULT_PERSONALITY);
    for (const k of TRAITS) expect([k, t[k]]).toEqual([k, 0.5]);
  });

  it('stays inside the 0.1..0.9 register bounds at both extremes and beyond', () => {
    for (const extreme of [0, 1, -5, 99, Number.NaN, undefined]) {
      const p = { warmth: extreme, boldness: extreme, rigor: extreme, playfulness: extreme };
      const t = traitsFromPersonality(p);
      for (const k of TRAITS) {
        expect(t[k]).toBeGreaterThanOrEqual(TRAIT_MIN);
        expect(t[k]).toBeLessThanOrEqual(TRAIT_MAX);
      }
    }
    expect(traitsFromPersonality(null).curiosity).toBe(0.5);
  });

  it('maps the documented directions: warmth -> sociability up, independence down, etc.', () => {
    const t = traitsFromPersonality({ warmth: 1, boldness: 1, rigor: 1, playfulness: 1 });
    expect(t).toEqual({
      sociability: 0.9,
      independence: 0.1,
      risk_tolerance: 0.9,
      caution: 0.1,
      depth: 0.9,
      persistence: 0.9,
      creativity: 0.9,
      curiosity: 0.9,
    });
    const low = traitsFromPersonality({ warmth: 0, boldness: 0, rigor: 0, playfulness: 0 });
    expect(low.sociability).toBe(0.1);
    expect(low.independence).toBe(0.9);
    expect(low.caution).toBe(0.9);
    expect(low.depth).toBe(0.1);
  });

  it('is symmetric around the midpoint: p and 1-p mirror every trait around 0.5', () => {
    const p = { warmth: 0.2, boldness: 0.7, rigor: 0.9, playfulness: 0.35 };
    const q = { warmth: 0.8, boldness: 0.3, rigor: 0.1, playfulness: 0.65 };
    const a = traitsFromPersonality(p);
    const b = traitsFromPersonality(q);
    for (const k of TRAITS) expect([k, +(a[k] + b[k]).toFixed(2)]).toEqual([k, 1]);
  });

  it('round-trips through personalityFromTraits', () => {
    const p = { warmth: 0.25, boldness: 0.6, rigor: 0.8, playfulness: 0.4 };
    const back = personalityFromTraits(traitsFromPersonality(p));
    for (const k of Object.keys(p)) expect([k, +back[k].toFixed(2)]).toEqual([k, p[k]]);
    expect(personalityFromTraits(undefined)).toEqual(DEFAULT_PERSONALITY);
  });

  it('shared fixture vectors (mirrored in tests/bot/agent-wizard.test.ts)', () => {
    expect(
      traitsFromPersonality({ warmth: 0.75, boldness: 0.25, rigor: 0.5, playfulness: 1 })
    ).toEqual({
      sociability: 0.7,
      independence: 0.3,
      risk_tolerance: 0.3,
      caution: 0.7,
      depth: 0.5,
      persistence: 0.5,
      creativity: 0.9,
      curiosity: 0.9,
    });
  });
});

describe('personalityBlurb', () => {
  it('names the poles and says balanced for the middle', () => {
    expect(personalityBlurb(DEFAULT_PERSONALITY)).toContain('balanced');
    const s = personalityBlurb({ warmth: 0.9, boldness: 0.1, rigor: 0.9, playfulness: 0.1 });
    expect(s).toMatch(/warm/i);
    expect(s).toMatch(/careful/i);
    expect(s).toMatch(/thorough/i);
    expect(s).toMatch(/serious/i);
  });
});

describe('deriveId', () => {
  it('slugs a display name into a config id', () => {
    expect(deriveId('Ada Lovelace')).toBe('ada-lovelace');
    expect(deriveId('  Señor Café!! ')).toBe('senor-cafe');
    expect(deriveId('---')).toBe('');
    expect(deriveId('')).toBe('');
    expect(deriveId(null)).toBe('');
    expect(deriveId('A'.repeat(100)).length).toBeLessThanOrEqual(40);
    expect(deriveId('123 go')).toBe('123-go');
  });
  it('every derived id satisfies ID_PATTERN', () => {
    for (const n of ['Ada Lovelace', 'x', 'Ω bot', 'my_bot.v2']) {
      const id = deriveId(n);
      if (id) expect([n, ID_PATTERN.test(id)]).toEqual([n, true]);
    }
    expect(ID_PATTERN.test('bad/id')).toBe(false);
    expect(ID_PATTERN.test('-lead')).toBe(false);
    expect(ID_PATTERN.test('Upper')).toBe(false);
  });
});

describe('state and applyField', () => {
  it('starts on step 0 with web chat on and no channels', () => {
    const s = initialState();
    expect(s.step).toBe(0);
    expect(STEPS.length).toBe(3);
    expect(s.channels.web).toBe(true);
    for (const k of CHANNEL_KINDS) expect(s.channels[k].enabled).toBe(false);
    expect(s.personality).toEqual(DEFAULT_PERSONALITY);
    expect(s.advanced.startNow).toBe(true);
  });
  it('derives the id from the name until the id is edited by hand', () => {
    let s = applyField(initialState(), 'name', 'Ada Lovelace');
    expect(s.id).toBe('ada-lovelace');
    s = applyField(s, 'id', 'ada');
    expect(s.idTouched).toBe(true);
    s = applyField(s, 'name', 'Ada L');
    expect(s.id).toBe('ada');
    // Clearing the id hands derivation back to the name.
    s = applyField(s, 'id', '');
    expect(s.idTouched).toBe(false);
    expect(s.id).toBe('ada-l');
  });
  it('does not mutate the input state', () => {
    const s = initialState();
    applyField(s, 'name', 'X');
    expect(s.name).toBe('');
  });
  it('sets nested fields with dotted names', () => {
    let s = applyField(initialState(), 'personality.warmth', 0.9);
    expect(s.personality.warmth).toBe(0.9);
    s = applyField(s, 'channels.telegram.token', '123:abc');
    expect(s.channels.telegram.token).toBe('123:abc');
    s = applyField(s, 'advanced.language', 'English');
    expect(s.advanced.language).toBe('English');
  });
});

describe('validateStep', () => {
  it('step 0 needs a name, a purpose sentence and a valid id', () => {
    const r = validateStep(initialState(), 0);
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(['id', 'name', 'purpose']);
    let s = applyField(initialState(), 'name', 'Ada');
    s = applyField(s, 'purpose', 'Helps me plan my week.');
    expect(validateStep(s, 0)).toEqual({ ok: true, errors: {} });
    s = applyField(s, 'id', 'Bad Id');
    expect(validateStep(s, 0).errors.id).toBeTruthy();
    s = applyField(s, 'purpose', 'short');
    expect(validateStep(s, 0).errors.purpose).toBeTruthy();
  });
  it('step 1 only caps the quirks length', () => {
    expect(validateStep(initialState(), 1).ok).toBe(true);
    const s = applyField(initialState(), 'quirks', 'x'.repeat(1001));
    expect(validateStep(s, 1).errors.quirks).toBeTruthy();
  });
  it('step 2 requires a token for each enabled channel and blocks rejected Telegram tokens', () => {
    expect(validateStep(initialState(), 2).ok).toBe(true);
    let s = applyField(initialState(), 'channels.telegram.enabled', true);
    expect(validateStep(s, 2).errors.telegram).toMatch(/token/i);
    s = applyField(s, 'channels.telegram.token', 'nothing');
    expect(validateStep(s, 2).errors.telegram).toMatch(/look like/i);
    s = applyField(s, 'channels.telegram.token', `123456789:${'a'.repeat(35)}`);
    expect(validateStep(s, 2).ok).toBe(true);
    s = applyField(s, 'tokenChecks.telegram', { state: 'revoked', detail: 'Telegram said 401' });
    expect(validateStep(s, 2).errors.telegram).toMatch(/401/);
    // A network error on the live check is not a reason to block creation.
    s = applyField(s, 'tokenChecks.telegram', { state: 'error', detail: 'timeout' });
    expect(validateStep(s, 2).ok).toBe(true);
    s = applyField(s, 'channels.whatsapp.enabled', true);
    expect(validateStep(s, 2).errors.whatsapp).toBeTruthy();
    s = applyField(s, 'channels.whatsapp.phoneNumberId', '1');
    s = applyField(s, 'channels.whatsapp.accessToken', 'EAAB');
    s = applyField(s, 'channels.discord.enabled', true);
    expect(validateStep(s, 2).errors.discord).toBeTruthy();
    s = applyField(
      s,
      'channels.discord.token',
      `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`
    );
    expect(validateStep(s, 2)).toEqual({ ok: true, errors: {} });
  });
  it('canCreate is every step at once', () => {
    let s = applyField(initialState(), 'name', 'Ada');
    expect(canCreate(s)).toBe(false);
    s = applyField(s, 'purpose', 'Helps me plan my week.');
    expect(canCreate(s)).toBe(true);
  });
});

describe('localTokenClass', () => {
  it('mirrors the server classifier for Telegram and Discord', () => {
    expect(localTokenClass('telegram', '')).toBe('missing');
    expect(localTokenClass('telegram', 'nothing')).toBe('placeholder');
    expect(localTokenClass('telegram', `123456:${'x'.repeat(35)}`)).toBe('shaped');
    expect(localTokenClass('discord', 'abc')).toBe('placeholder');
    expect(localTokenClass('discord', `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`)).toBe(
      'shaped'
    );
    expect(localTokenClass('whatsapp', 'anything')).toBe('shaped');
    expect(localTokenClass('whatsapp', ' ')).toBe('missing');
  });
});

describe('buildCreatePayload', () => {
  const filled = () => {
    let s = applyField(initialState(), 'name', 'Ada');
    s = applyField(s, 'purpose', 'Helps me plan my week.');
    s = applyField(s, 'quirks', 'Loves puns');
    s = applyField(s, 'personality.warmth', 0.8);
    return s;
  };
  it('is headless by default: token null, web chat only, enabled, greet', () => {
    const body = buildCreatePayload(filled());
    expect(body).toEqual({
      id: 'ada',
      name: 'Ada',
      purpose: 'Helps me plan my week.',
      personality: { warmth: 0.8, boldness: 0.5, rigor: 0.5, playfulness: 0.5 },
      quirks: 'Loves puns',
      token: null,
      enabled: true,
      language: 'Spanish',
      greet: true,
    });
  });
  it('carries channel credentials and the advanced overrides only when set', () => {
    let s = filled();
    s = applyField(s, 'channels.telegram.enabled', true);
    s = applyField(s, 'channels.telegram.token', ' 123:abc ');
    s = applyField(s, 'channels.whatsapp.enabled', true);
    s = applyField(s, 'channels.whatsapp.phoneNumberId', '15551234');
    s = applyField(s, 'channels.whatsapp.accessToken', 'EAAB');
    s = applyField(s, 'channels.whatsapp.verifyToken', 'v');
    s = applyField(s, 'channels.discord.enabled', true);
    s = applyField(s, 'channels.discord.token', 'd.t.k');
    s = applyField(s, 'advanced.emoji', '🦉');
    s = applyField(s, 'advanced.language', 'English');
    s = applyField(s, 'advanced.llmBackend', 'claude-cli');
    s = applyField(s, 'advanced.model', 'claude-opus-5');
    s = applyField(s, 'advanced.generateWith', 'llama3');
    s = applyField(s, 'advanced.startNow', false);
    const body = buildCreatePayload(s);
    expect(body.token).toBe('123:abc');
    expect(body.whatsapp).toEqual({
      phoneNumberId: '15551234',
      accessToken: 'EAAB',
      verifyToken: 'v',
    });
    expect(body.discord).toEqual({ token: 'd.t.k' });
    expect(body.emoji).toBe('🦉');
    expect(body.language).toBe('English');
    expect(body.llmBackend).toBe('claude-cli');
    expect(body.model).toBe('claude-opus-5');
    expect(body.generation).toEqual({ llmBackend: 'ollama', model: 'llama3' });
    expect(body.enabled).toBe(false);
  });
  it('a disabled channel never leaks its token', () => {
    let s = filled();
    s = applyField(s, 'channels.telegram.token', '123:abc');
    expect(buildCreatePayload(s).token).toBeNull();
  });
});

describe('labels and markup', () => {
  it('tokenStatusLabel maps every state to a tone', () => {
    expect(tokenStatusLabel(null)).toEqual({ text: '', tone: 'muted' });
    expect(tokenStatusLabel({ state: 'ok', username: 'ada_bot' })).toEqual({
      text: 'Valid — @ada_bot',
      tone: 'ok',
    });
    expect(tokenStatusLabel({ state: 'revoked', detail: 'x' }).tone).toBe('danger');
    expect(tokenStatusLabel({ state: 'placeholder' }).tone).toBe('warn');
    expect(tokenStatusLabel({ state: 'shaped' }).tone).toBe('info');
    expect(tokenStatusLabel({ state: 'error', detail: 'timeout' }).tone).toBe('warn');
    expect(tokenStatusLabel({ state: 'checking' }).text).toMatch(/Checking/);
  });
  it('progressLabel has a line for each stage', () => {
    expect(progressLabel('soul')).toBe('Writing soul…');
    expect(progressLabel('start')).toBe('Waking up…');
    expect(progressLabel('greet')).toBe('Saying hello…');
    expect(progressLabel('nope')).toBe('Working…');
    expect(GREETING_TEXT).toMatch(/introduce yourself/i);
  });
  it('stepIndicator marks the current step', () => {
    const html = stepIndicator(1);
    expect(html).toContain('wizard-steps');
    expect(html.match(/wizard-step-done/g)?.length).toBe(1);
    expect(html.match(/wizard-step-current/g)?.length).toBe(1);
  });
  it('step markup escapes user text and reflects values', () => {
    let s = applyField(initialState(), 'name', '<b>Ada</b>');
    s = applyField(s, 'purpose', 'x');
    const who = stepWho(s, { purpose: 'Say a bit more' });
    expect(who).toContain('&lt;b&gt;Ada&lt;/b&gt;');
    expect(who).not.toContain('<b>Ada</b>');
    expect(who).toContain('Say a bit more');
    expect(who).toContain('value="b-ada-b"');
    const pers = stepPersonality(applyField(s, 'quirks', '"quoted"'));
    expect(pers).toContain('&quot;quoted&quot;');
    expect(pers.match(/type="range"/g)?.length).toBe(4);
    expect(sliderRow(PERSONALITY_AXES[0], 0.8)).toContain('value="80"');
  });
  it('channel cards show the token input only when enabled and carry the check', () => {
    let s = initialState();
    expect(channelCard('telegram', s)).not.toContain('type="password"');
    s = applyField(s, 'channels.telegram.enabled', true);
    s = applyField(s, 'tokenChecks.telegram', { state: 'ok', username: 'ada_bot' });
    const html = channelCard('telegram', s);
    expect(html).toContain('type="password"');
    expect(html).toContain('@ada_bot');
    const defaults = {
      claudeCliModels: [{ value: 'opus', label: 'Opus' }],
      availableModels: ['llama3'],
    };
    const page = stepChannels(s, {}, { defaults });
    expect(page).toContain('Web chat');
    expect(page).toContain('<details');
    // Ollama models list under "Agent model" while the backend is the global default…
    expect(page).toContain('>llama3<');
    expect(page).not.toContain('Opus');
    // …and the Claude list takes over once the backend is Claude CLI.
    const claude = stepChannels(
      applyField(s, 'advanced.llmBackend', 'claude-cli'),
      {},
      { defaults }
    );
    expect(claude).toContain('Opus');
  });
});
