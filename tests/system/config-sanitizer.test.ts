import { describe, expect, it } from 'bun:test';
import {
  mergeReports,
  redactJsonDocument,
  renderRequiredEnv,
  sanitizeBotRoster,
  sanitizeSystemConfig,
  scrubEmbeddedSecrets,
} from '../../src/system/config-sanitizer';

/**
 * Fake credentials shaped like the real thing. Every assertion in this file is
 * ultimately the same one: none of these strings may survive into a bundle.
 */
const FAKE = {
  telegram: '123456789:AAHfakeTokenValueABCDEFGHIJKLMNOPQRS',
  brave: 'BSAfakeBraveSearchKey12345',
  openai: 'sk-fakeOpenAiKey1234567890abcdefgh',
  elevenlabs: 'fake-elevenlabs-key-9876543210',
  twilioAuth: 'fakeTwilioAuthToken0123456789ab',
  // Split across a concatenation on purpose. These two are fake, but they match
  // GitHub's push-protection detectors exactly — which is the point, since the
  // sanitizer implements the same shapes — and a contiguous literal makes the
  // repo unpushable. The runtime values are unchanged, so the rules under test
  // still see the real thing.
  twilioSid: `AC${'0123456789abcdef'.repeat(2)}`,
  stripe: `sk_${'live'}_fakeStripeSecretKey123456`,
  github: 'ghp_fakeGithubTokenABCDEFGHIJKLMNOPQRSTUVWX',
  whatsapp: 'EAAfakeWhatsAppAccessTokenValue123',
  discord: 'fakeDiscordBotTokenValue.abcdef.ghijkl',
  hex: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
};

function rawConfig(overrides: Record<string, unknown> = {}) {
  return {
    ollama: {
      baseUrl: 'http://192.168.1.50:11434',
      apiKey: 'ollama-literal-secret-value-123',
      models: { primary: 'kimi-k2.6:cloud' },
    },
    webTools: { enabled: true, search: { apiKey: FAKE.brave, maxResults: 5 } },
    media: {
      whisper: { endpoint: 'https://api.openai.com/v1', apiKey: FAKE.openai },
      tts: { provider: 'elevenlabs', apiKey: FAKE.elevenlabs, voiceId: 'abc' },
    },
    phoneCall: { accountSid: FAKE.twilioSid, authToken: FAKE.twilioAuth, fromNumber: '+123' },
    multiTenant: { enabled: true, stripe: { secretKey: FAKE.stripe, webhookSecret: 'whsec_x' } },
    improve: { claudePath: 'C:\\Users\\User\\AppData\\claude.exe', enabled: true },
    web: { enabled: true, port: 3000, host: '0.0.0.0' },
    logging: { level: 'info', file: '/var/log/aibot/app.log' },
    paths: { data: './data', logs: './data/logs', skills: './src/skills' },
    soul: { dir: './config/soul', search: { dbPath: './data/memory.db', enabled: true } },
    ...overrides,
  };
}

/** Serialize the whole sanitizer output and assert no fake value survives. */
function assertNoSecrets(payload: unknown) {
  const text = JSON.stringify(payload);
  for (const [name, value] of Object.entries(FAKE)) {
    expect(`${name}:${text.includes(value)}`).toBe(`${name}:false`);
  }
}

describe('sanitizeSystemConfig', () => {
  it('replaces every literal secret with a ${VAR} placeholder', () => {
    const { config, report } = sanitizeSystemConfig(rawConfig());

    assertNoSecrets(config);
    expect((config.webTools as any).search.apiKey).toBe('${BRAVE_SEARCH_API_KEY}');
    expect((config.media as any).whisper.apiKey).toBe('${OPENAI_API_KEY}');
    expect((config.media as any).tts.apiKey).toBe('${ELEVENLABS_API_KEY}');
    expect((config.ollama as any).apiKey).toBe('${OLLAMA_API_KEY}');
    expect((config.phoneCall as any).authToken).toBe('${TWILIO_AUTH_TOKEN}');
    expect((config.multiTenant as any).stripe.secretKey).toBe('${STRIPE_SECRET_KEY}');
    expect(report.redacted).toContain('webTools.search.apiKey');
  });

  it('lists every placeholder as a required environment variable', () => {
    const { report } = sanitizeSystemConfig(rawConfig());
    const names = report.required.map((entry) => entry.variable);

    expect(names).toContain('BRAVE_SEARCH_API_KEY');
    expect(names).toContain('OPENAI_API_KEY');
    expect(names).toContain('OLLAMA_API_KEY');
    expect(names).toContain('STRIPE_SECRET_KEY');
    expect(report.required.find((e) => e.variable === 'OPENAI_API_KEY')?.secret).toBe(true);
  });

  it('keeps ${VAR} references that are already placeholders and declares them', () => {
    const { config, report } = sanitizeSystemConfig({
      ollama: { baseUrl: '${OLLAMA_BASE_URL}', apiKey: '${OLLAMA_API_KEY}', models: {} },
    });

    expect((config.ollama as any).apiKey).toBe('${OLLAMA_API_KEY}');
    expect(report.redacted).not.toContain('ollama.apiKey');
    expect(report.required.map((e) => e.variable)).toContain('OLLAMA_API_KEY');
  });

  it('derives a variable name for an unknown secret key', () => {
    const { config, report } = sanitizeSystemConfig({
      skills: { config: { myPlugin: { authToken: 'literal-secret-value' } } },
    });

    expect((config.skills as any).config.myPlugin.authToken).toBe(
      '${AIBOT_SKILLS_CONFIG_MY_PLUGIN_AUTH_TOKEN}'
    );
    expect(report.required.map((e) => e.variable)).toContain(
      'AIBOT_SKILLS_CONFIG_MY_PLUGIN_AUTH_TOKEN'
    );
  });

  it('catches a credential hiding under an innocuous key name', () => {
    const { config, report } = sanitizeSystemConfig({
      skills: { config: { notes: { reminder: FAKE.github } } },
    });

    assertNoSecrets(config);
    expect(report.warnings.some((w) => w.includes('github-token'))).toBe(true);
  });

  it('turns the host Ollama URL into a placeholder instead of carrying it', () => {
    const { config, report } = sanitizeSystemConfig(rawConfig());

    expect((config.ollama as any).baseUrl).toBe('${OLLAMA_BASE_URL}');
    expect(report.dropped).toContain('ollama.baseUrl');
    expect(report.required.find((e) => e.variable === 'OLLAMA_BASE_URL')?.secret).toBe(false);
  });

  it('drops machine-specific settings', () => {
    const { config, report } = sanitizeSystemConfig(rawConfig());

    expect((config.improve as any).claudePath).toBeUndefined();
    expect((config.web as any).host).toBeUndefined();
    expect((config.web as any).port).toBeUndefined();
    expect((config.soul as any).search.dbPath).toBeUndefined();
    expect((config.logging as any).file).toBeUndefined();
    expect(report.dropped).toContain('improve.claudePath');
    expect(report.dropped).toContain('soul.search.dbPath');
    expect(report.dropped).toContain('logging.file');
  });

  it('keeps relative paths but drops absolute ones', () => {
    const { config, report } = sanitizeSystemConfig(
      rawConfig({ paths: { data: 'D:\\aibot\\data', logs: './data/logs', skills: './src/skills' } })
    );

    expect((config.paths as any).data).toBeUndefined();
    expect((config.paths as any).logs).toBe('./data/logs');
    expect(report.dropped).toContain('paths.data');
  });

  it('keeps non-secret settings untouched', () => {
    const { config } = sanitizeSystemConfig(rawConfig());
    expect((config.ollama as any).models.primary).toBe('kimi-k2.6:cloud');
    expect((config.webTools as any).search.maxResults).toBe(5);
    expect((config.soul as any).search.enabled).toBe(true);
  });

  it('strips any inline bots array (the roster travels separately)', () => {
    const { config } = sanitizeSystemConfig(
      rawConfig({ bots: [{ id: 'x', token: FAKE.telegram }] })
    );
    expect('bots' in config).toBe(false);
    assertNoSecrets(config);
  });

  it('rejects a non-object config', () => {
    expect(() => sanitizeSystemConfig('nope')).toThrow('expected a JSON object');
    expect(() => sanitizeSystemConfig([1, 2])).toThrow('expected a JSON object');
  });
});

describe('sanitizeBotRoster', () => {
  const roster = [
    {
      id: 'coach',
      name: 'Coach',
      token: FAKE.telegram,
      enabled: true,
      skills: ['a'],
      soulDir: 'D:\\aibot\\config\\soul\\coach',
      apiKey: 'aibot_fakeTenantApiKey1234567890',
      billing: { stripeCustomerId: 'cus_123' },
      whatsapp: { phoneNumberId: '111', accessToken: FAKE.whatsapp, appSecret: 'x' },
      discord: { token: FAKE.discord, applicationId: '999' },
    },
    {
      id: 'helper bot',
      name: 'Helper',
      token: '',
      enabled: true,
      skills: [],
      soulDir: './config/soul/helper bot',
    },
  ];

  it('blanks Telegram tokens and disables every bot', () => {
    const { bots } = sanitizeBotRoster(roster);

    assertNoSecrets(bots);
    for (const bot of bots) {
      expect(bot.token).toBe('');
      expect(bot.enabled).toBe(false);
    }
  });

  it('never lists a Telegram token as a required env var', () => {
    const { report } = sanitizeBotRoster(roster);
    const names = report.required.map((entry) => entry.variable).join(' ');
    expect(names).not.toContain('COACH_TOKEN');
    expect(names).not.toContain('TELEGRAM');
  });

  it('replaces WhatsApp and Discord credentials with per-bot placeholders', () => {
    const { bots, report } = sanitizeBotRoster(roster);
    const coach = bots[0] as any;

    expect(coach.whatsapp.accessToken).toBe('${AIBOT_BOT_COACH_WHATSAPP_TOKEN}');
    expect(coach.whatsapp.phoneNumberId).toBe('111');
    expect(coach.discord.token).toBe('${AIBOT_BOT_COACH_DISCORD_TOKEN}');
    expect(coach.discord.applicationId).toBe('999');
    expect(report.required.map((e) => e.variable)).toContain('AIBOT_BOT_COACH_WHATSAPP_TOKEN');
  });

  it('drops the tenant API key and billing state', () => {
    const { bots, report } = sanitizeBotRoster(roster);
    expect((bots[0] as any).apiKey).toBeUndefined();
    expect((bots[0] as any).billing).toBeUndefined();
    expect(report.dropped).toContain('bots[coach].apiKey');
    expect(report.dropped).toContain('bots[coach].billing');
  });

  it('drops absolute soul directories and normalizes relative ones', () => {
    const { bots, report } = sanitizeBotRoster(roster);
    expect((bots[0] as any).soulDir).toBeUndefined();
    expect(report.dropped).toContain('bots[coach].soulDir');
    // Directory names with spaces survive intact.
    expect((bots[1] as any).soulDir).toBe('./config/soul/helper bot');
  });

  it('converts Windows separators in a relative soul directory', () => {
    const { bots } = sanitizeBotRoster([
      { id: 'w', name: 'W', token: '', skills: [], soulDir: 'config\\soul\\w' },
    ]);
    expect((bots[0] as any).soulDir).toBe('config/soul/w');
  });

  it('rejects a non-array roster', () => {
    expect(() => sanitizeBotRoster({ id: 'x' })).toThrow('expected a JSON array');
  });
});

describe('scrubEmbeddedSecrets', () => {
  it('removes a Telegram token pasted into free text', () => {
    const { text, hits } = scrubEmbeddedSecrets(
      `The user told me the token is ${FAKE.telegram} and asked me to remember it.`
    );
    expect(text).not.toContain(FAKE.telegram);
    expect(text).toContain('[REDACTED:telegram-bot-token]');
    expect(hits).toContain('telegram-bot-token');
  });

  it('removes API keys and private key blocks', () => {
    const { text } = scrubEmbeddedSecrets(
      `key=${FAKE.openai}\ngh=${FAKE.github}\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----`
    );
    expect(text).not.toContain(FAKE.openai);
    expect(text).not.toContain(FAKE.github);
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('leaves ordinary content alone', () => {
    const prose = 'Commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 fixed the retry loop.';
    const { text, hits } = scrubEmbeddedSecrets(prose);
    // A 40-char hex string is far more likely to be a git SHA than a secret.
    expect(text).toBe(prose);
    expect(hits).toHaveLength(0);
  });
});

describe('redactJsonDocument', () => {
  it('blanks credential fields in a JSON document', () => {
    const { text, redacted } = redactJsonDocument(
      JSON.stringify({
        tenants: [{ id: 't1', apiKey: 'aibot_secret', passwordHash: 'argon2id$x' }],
      })
    );

    const parsed = JSON.parse(text);
    expect(parsed.tenants[0].apiKey).toBe('');
    expect(parsed.tenants[0].passwordHash).toBe('');
    expect(parsed.tenants[0].id).toBe('t1');
    expect(redacted.length).toBe(2);
  });

  it('handles JSONL line by line', () => {
    const input = `{"event":"a","authToken":"secret1"}\n{"event":"b","authToken":"secret2"}\n`;
    const { text } = redactJsonDocument(input);
    expect(text).not.toContain('secret1');
    expect(text).not.toContain('secret2');
    expect(text.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('returns invalid JSON unchanged', () => {
    const input = 'not json at all';
    expect(redactJsonDocument(input).text).toBe(input);
  });
});

describe('renderRequiredEnv', () => {
  it('lists secrets, host settings and a .env skeleton without any values', () => {
    const { report: configReport } = sanitizeSystemConfig(rawConfig());
    const { report: rosterReport } = sanitizeBotRoster([
      { id: 'coach', name: 'C', token: FAKE.telegram, skills: [] },
    ]);
    const text = renderRequiredEnv(
      mergeReports(configReport, rosterReport),
      '2026-08-13T00:00:00.000Z'
    );

    for (const value of Object.values(FAKE)) expect(text).not.toContain(value);
    expect(text).toContain('SECRETS');
    expect(text).toContain('BRAVE_SEARCH_API_KEY');
    expect(text).toContain('HOST / DEPLOYMENT SETTINGS');
    expect(text).toContain('OLLAMA_BASE_URL');
    expect(text).toContain('.env SKELETON');
    expect(text).toContain('OPENAI_API_KEY=');
    expect(text).toContain('empty token and enabled=false');
  });
});

describe('mergeReports', () => {
  it('deduplicates variables and keeps the strictest secret flag', () => {
    const merged = mergeReports(
      {
        required: [{ variable: 'X', usedBy: 'a', secret: false }],
        redacted: ['a'],
        dropped: [],
        warnings: [],
      },
      {
        required: [{ variable: 'X', usedBy: 'b', secret: true }],
        redacted: ['a'],
        dropped: ['c'],
        warnings: ['w'],
      }
    );

    expect(merged.required).toHaveLength(1);
    expect(merged.required[0]?.secret).toBe(true);
    expect(merged.required[0]?.usedBy).toBe('a, b');
    expect(merged.redacted).toEqual(['a']);
    expect(merged.dropped).toEqual(['c']);
    expect(merged.warnings).toEqual(['w']);
  });
});
