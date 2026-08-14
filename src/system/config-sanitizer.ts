/**
 * Turns a raw `config.json` / `bots.json` into something safe to hand to
 * another machine.
 *
 * Two properties matter here, in order:
 *
 * 1. **No secret value ever reaches the bundle.** This module must be fed the
 *    *raw* file contents, never the in-memory `Config`: `loadConfig()` expands
 *    `${VAR}` before Zod validation, so a sanitizer running on the loaded
 *    object would be reading resolved secrets and would happily write them out
 *    as literals. Callers are responsible for reading the file from disk.
 * 2. **Machine-specific settings do not silently follow the bundle.** A restored
 *    instance that quietly points at the old host's Ollama URL, Claude binary or
 *    absolute soul directory fails in ways that look like data corruption.
 *
 * Defence is layered, because the cost of a miss is a leaked credential in a
 * public repo: a key-name sweep catches the conventional fields, a value-shape
 * sweep catches credentials sitting under an innocuous key, and an explicit
 * path map gives the well-known fields their conventional env var names.
 */

const SECRET_PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Key names that hold credentials. Matched against the key alone, after
 * splitting camelCase, so `authToken`, `auth_token` and `AUTHTOKEN` all hit.
 */
const SECRET_KEY_PATTERN =
  /^(token|secret|password|passwd|pass|apikey|api key|authtoken|auth token|accesstoken|access token|accesssecret|access secret|refreshtoken|refresh token|bearertoken|bearer token|clientsecret|client secret|webhooksecret|webhook secret|secretkey|secret key|privatekey|private key|credential|credentials|accountsid|account sid|authsecret|apisecret|api secret|appsecret|app secret|verifytoken|verify token|passwordhash|password hash)$/i;

/**
 * Value shapes that are credentials no matter what key they sit under. Anchored
 * to the whole value except the two that are unmistakable in prose.
 */
const SECRET_VALUE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/, label: 'telegram-bot-token' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'private-key' },
  { pattern: /^sk-[A-Za-z0-9_-]{16,}$/, label: 'openai-style-key' },
  { pattern: /^xox[baprs]-[A-Za-z0-9-]{10,}$/, label: 'slack-token' },
  { pattern: /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/, label: 'github-token' },
  { pattern: /^github_pat_[A-Za-z0-9_]{20,}$/, label: 'github-pat' },
  { pattern: /^AKIA[0-9A-Z]{16}$/, label: 'aws-access-key-id' },
  { pattern: /^(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}$/, label: 'stripe-key' },
  { pattern: /^whsec_[A-Za-z0-9]{16,}$/, label: 'stripe-webhook-secret' },
  { pattern: /^AC[0-9a-fA-F]{32}$/, label: 'twilio-account-sid' },
  { pattern: /^[A-Fa-f0-9]{40,}$/, label: 'long-hex-credential' },
  { pattern: /^aibot_[A-Za-z0-9_-]{16,}$/, label: 'aibot-api-key' },
];

/**
 * Credential shapes unmistakable enough to strip out of the middle of free
 * text. Deliberately narrower than `SECRET_VALUE_PATTERNS`: this set runs over
 * soul files, session transcripts and cron payloads, where a loose pattern
 * would corrupt real content. Notably absent is the long-hex rule — a 40-char
 * hex string in a memory file is far more likely to be a git SHA.
 */
const EMBEDDED_SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, label: 'telegram-bot-token' },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: 'private-key',
  },
  { pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/g, label: 'openai-style-key' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'slack-token' },
  { pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, label: 'github-token' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: 'github-pat' },
  { pattern: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g, label: 'stripe-key' },
  { pattern: /\bwhsec_[A-Za-z0-9]{16,}\b/g, label: 'stripe-webhook-secret' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws-access-key-id' },
  { pattern: /\baibot_[A-Za-z0-9_-]{24,}\b/g, label: 'aibot-api-key' },
];

/**
 * Last line of defence: strip credentials embedded in arbitrary file content.
 *
 * The key-name and value-shape sweeps only see `config.json`. A token pasted
 * into a soul memory file, a cron job payload or an MCP server argument would
 * otherwise travel in the bundle untouched.
 */
export function scrubEmbeddedSecrets(text: string): { text: string; hits: string[] } {
  const hits: string[] = [];
  let result = text;
  for (const { pattern, label } of EMBEDDED_SECRET_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), () => {
      hits.push(label);
      return `[REDACTED:${label}]`;
    });
  }
  return { text: result, hits };
}

/**
 * Blank every credential-shaped field in a JSON or JSONL data file (tenant
 * records, contact books). Unlike config, a `${VAR}` placeholder would be
 * meaningless here — these files are read as data, never env-expanded — so the
 * value is emptied and the operator re-issues it on the target.
 */
export function redactJsonDocument(text: string): { text: string; redacted: string[] } {
  const redacted: string[] = [];

  const walk = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, i) => walk(item, `${path}[${i}]`));
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const childPath = path ? `${path}.${key}` : key;
        if (typeof child === 'string' && child !== '' && looksSecretKey(key)) {
          redacted.push(childPath);
          result[key] = '';
        } else {
          result[key] = walk(child, childPath);
        }
      }
      return result;
    }
    return value;
  };

  const lines = text.split('\n');
  const isJsonl =
    lines.filter((line) => line.trim()).length > 1 &&
    text.trimStart().startsWith('{') &&
    lines[0]?.trim().endsWith('}');

  if (isJsonl) {
    const out = lines.map((line, index) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(walk(JSON.parse(line), `[${index}]`));
      } catch {
        return line;
      }
    });
    return { text: out.join('\n'), redacted };
  }

  try {
    return { text: `${JSON.stringify(walk(JSON.parse(text), ''), null, 2)}\n`, redacted };
  } catch {
    return { text, redacted };
  }
}

/** Conventional env var names, so a restored config matches `.env.example`. */
const KNOWN_ENV_VARS: Record<string, string> = {
  'ollama.apiKey': 'OLLAMA_API_KEY',
  'ollama.baseUrl': 'OLLAMA_BASE_URL',
  'webTools.search.apiKey': 'BRAVE_SEARCH_API_KEY',
  'media.whisper.apiKey': 'OPENAI_API_KEY',
  'media.tts.apiKey': 'ELEVENLABS_API_KEY',
  'phoneCall.accountSid': 'TWILIO_ACCOUNT_SID',
  'phoneCall.authToken': 'TWILIO_AUTH_TOKEN',
  'phoneCall.fromNumber': 'TWILIO_FROM_NUMBER',
  'phoneCall.defaultNumber': 'TWILIO_TO_NUMBER',
  'reddit.clientId': 'REDDIT_CLIENT_ID',
  'reddit.clientSecret': 'REDDIT_CLIENT_SECRET',
  'reddit.username': 'REDDIT_USERNAME',
  'reddit.password': 'REDDIT_PASSWORD',
  'twitter.apiKey': 'TWITTER_API_KEY',
  'twitter.apiSecret': 'TWITTER_API_SECRET',
  'twitter.bearerToken': 'TWITTER_BEARER_TOKEN',
  'twitter.accessToken': 'TWITTER_ACCESS_TOKEN',
  'twitter.accessSecret': 'TWITTER_ACCESS_SECRET',
  'calendar.apiKey': 'CALENDAR_API_KEY',
  'calendar.calendarId': 'CALENDAR_ID',
  'multiTenant.stripe.secretKey': 'STRIPE_SECRET_KEY',
  'multiTenant.stripe.webhookSecret': 'STRIPE_WEBHOOK_SECRET',
  'multiTenant.stripe.priceIds.starter': 'STRIPE_STARTER_PRICE_ID',
  'multiTenant.stripe.priceIds.pro': 'STRIPE_PRO_PRICE_ID',
  'multiTenant.stripe.priceIds.enterprise': 'STRIPE_ENTERPRISE_PRICE_ID',
  'mcp.expose.authToken': 'MCP_EXPOSE_AUTH_TOKEN',
  'evolution.sensors.webhook.secret': 'EVOLUTION_WEBHOOK_SECRET',
};

/**
 * Settings that describe *this host*, not the deployment.
 *
 * `always`: drop unconditionally — the value is meaningless elsewhere, or (for
 * `soul.search.dbPath`) points at an artifact we deliberately do not ship.
 * `ifAbsolute`: keep relative values, drop `/var/...` or `D:\...` — a relative
 * `./data` is a project convention and portable, an absolute one is not.
 * `envPlaceholder`: the schema has no default and the field is host-specific,
 * so it becomes a `${VAR}` the operator must fill in.
 */
type MachineRule = 'always' | 'ifAbsolute' | 'envPlaceholder';

const MACHINE_SPECIFIC: Record<string, MachineRule> = {
  'ollama.baseUrl': 'envPlaceholder',
  'improve.claudePath': 'always',
  'improve.soulDir': 'ifAbsolute',
  'soul.dir': 'ifAbsolute',
  'soul.search.dbPath': 'always',
  'web.host': 'always',
  'web.port': 'always',
  'logging.file': 'ifAbsolute',
  'paths.data': 'ifAbsolute',
  'paths.logs': 'ifAbsolute',
  'paths.skills': 'ifAbsolute',
  'exec.workdir': 'ifAbsolute',
  'fileTools.basePath': 'ifAbsolute',
  'browserTools.executablePath': 'always',
  'browserTools.screenshotDir': 'ifAbsolute',
  'productions.baseDir': 'ifAbsolute',
  'conversations.baseDir': 'ifAbsolute',
  'karma.baseDir': 'ifAbsolute',
  'cron.storePath': 'ifAbsolute',
  'session.dataDir': 'ifAbsolute',
  'dynamicTools.storePath': 'ifAbsolute',
  'agentProposals.storePath': 'ifAbsolute',
  'multiTenant.dataDir': 'ifAbsolute',
  'phoneCall.contactsFile': 'ifAbsolute',
  'mcp.expose.host': 'always',
  'mcp.expose.port': 'always',
};

export interface EnvRequirement {
  variable: string;
  /** Dotted config path (or `bots[<id>].<field>`) that reads this variable. */
  usedBy: string;
  secret: boolean;
}

export interface SanitizeReport {
  /** Env vars the importing operator must define. */
  required: EnvRequirement[];
  /** Config paths whose literal value was replaced with a placeholder. */
  redacted: string[];
  /** Machine-specific config paths removed from the bundle. */
  dropped: string[];
  /** Non-fatal observations worth surfacing to the operator. */
  warnings: string[];
}

function isAbsolutePathValue(value: unknown): boolean {
  return typeof value === 'string' && /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(value);
}

/** `webTools.search.apiKey` -> `AIBOT_WEBTOOLS_SEARCH_APIKEY`. */
function deriveEnvVar(path: string): string {
  const cleaned = path
    .replace(/\[(\d+)\]/g, '_$1')
    .split('.')
    .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2'))
    .join('_')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase();
  return `AIBOT_${cleaned}`;
}

function humanizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
}

function looksSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(humanizeKey(key));
}

function looksSecretValue(value: string): string | null {
  for (const { pattern, label } of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) return label;
  }
  return null;
}

function collectPlaceholders(value: string): string[] {
  return [...value.matchAll(SECRET_PLACEHOLDER_PATTERN)].map((match) => match[1] as string);
}

class Sanitizer {
  readonly required = new Map<string, EnvRequirement>();
  readonly redacted: string[] = [];
  readonly dropped: string[] = [];
  readonly warnings: string[] = [];

  private requireEnv(variable: string, usedBy: string, secret: boolean): void {
    const existing = this.required.get(variable);
    if (existing) {
      // A variable reused across paths stays secret if any use is secret.
      existing.secret = existing.secret || secret;
      if (!existing.usedBy.includes(usedBy)) existing.usedBy += `, ${usedBy}`;
      return;
    }
    this.required.set(variable, { variable, usedBy, secret });
  }

  /** Replace a literal secret with a placeholder, or record an existing one. */
  redact(path: string, value: string, secret: boolean): string {
    const existing = collectPlaceholders(value);
    if (existing.length > 0) {
      for (const variable of existing) this.requireEnv(variable, path, secret);
      return value;
    }
    if (value === '') return value;

    const variable = KNOWN_ENV_VARS[path] ?? deriveEnvVar(path);
    this.requireEnv(variable, path, secret);
    this.redacted.push(path);
    return `\${${variable}}`;
  }

  report(): SanitizeReport {
    return {
      required: [...this.required.values()].sort((a, b) => a.variable.localeCompare(b.variable)),
      redacted: [...this.redacted].sort(),
      dropped: [...this.dropped].sort(),
      warnings: this.warnings,
    };
  }
}

function sanitizeValue(sanitizer: Sanitizer, value: unknown, path: string, key: string): unknown {
  if (typeof value === 'string') {
    if (looksSecretKey(key)) return sanitizer.redact(path, value, true);

    const shape = looksSecretValue(value);
    if (shape) {
      sanitizer.warnings.push(
        `Value at "${path}" matched credential shape "${shape}" and was replaced with a placeholder`
      );
      return sanitizer.redact(path, value, true);
    }

    // Placeholders under non-secret keys still have to be declared, otherwise
    // the restored config silently expands them to empty strings.
    if (collectPlaceholders(value).length > 0) {
      return sanitizer.redact(path, value, false);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(sanitizer, item, `${path}[${index}]`, key));
  }

  if (value !== null && typeof value === 'object') {
    return sanitizeObject(sanitizer, value as Record<string, unknown>, path);
  }

  return value;
}

function sanitizeObject(
  sanitizer: Sanitizer,
  source: Record<string, unknown>,
  basePath: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const path = basePath ? `${basePath}.${key}` : key;

    const rule = MACHINE_SPECIFIC[path];
    if (rule === 'always' || (rule === 'ifAbsolute' && isAbsolutePathValue(value))) {
      sanitizer.dropped.push(path);
      continue;
    }
    if (rule === 'envPlaceholder' && typeof value === 'string') {
      if (collectPlaceholders(value).length > 0) {
        result[key] = sanitizer.redact(path, value, false);
      } else {
        // The host value is replaced, not carried: pointing a restored
        // instance at the old host's Ollama URL is a silent misconfiguration.
        sanitizer.dropped.push(path);
        const variable = KNOWN_ENV_VARS[path] ?? deriveEnvVar(path);
        result[key] = sanitizer.redact(path, `\${${variable}}`, false);
      }
      continue;
    }

    result[key] = sanitizeValue(sanitizer, value, path, key);
  }
  return result;
}

export interface SanitizedConfig {
  config: Record<string, unknown>;
  report: SanitizeReport;
}

/**
 * Sanitize the raw contents of `config/config.json`.
 * `bots` is stripped here — the roster travels in `config/bots.json`.
 */
export function sanitizeSystemConfig(rawConfig: unknown): SanitizedConfig {
  if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error('Invalid config.json: expected a JSON object');
  }

  const sanitizer = new Sanitizer();
  const source = { ...(rawConfig as Record<string, unknown>) };
  if ('bots' in source) {
    source.bots = undefined;
    // biome-ignore lint/performance/noDelete: the key must be absent, not undefined
    delete source.bots;
  }

  const config = sanitizeObject(sanitizer, source, '');
  return { config, report: sanitizer.report() };
}

/** Env-var-safe form of a bot id: `soporte-ventas` -> `SOPORTE_VENTAS`. */
function botEnvSegment(botId: string): string {
  return botId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

export interface SanitizedRoster {
  bots: Record<string, unknown>[];
  report: SanitizeReport;
}

/**
 * Sanitize the raw contents of `config/bots.json`.
 *
 * Every bot lands with `token: ''` and `enabled: false`. That is not cosmetic:
 * boot-time auto-start reads `enabled`, so a roster that travelled with
 * `enabled: true` would have the new instance start polling Telegram the moment
 * an operator supplied tokens — against a token the old instance may still own,
 * producing a 409 conflict loop that takes both instances down.
 *
 * Other channel credentials (WhatsApp, Discord) become `${VAR}` placeholders
 * rather than being deleted, because their schema objects require them; a
 * deleted field would fail validation on the target and the operator would see
 * a Zod error instead of a clear "supply this variable".
 */
export function sanitizeBotRoster(rawBots: unknown): SanitizedRoster {
  if (!Array.isArray(rawBots)) {
    throw new Error('Invalid bots.json: expected a JSON array');
  }

  const sanitizer = new Sanitizer();
  const bots: Record<string, unknown>[] = [];

  for (const entry of rawBots) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = { ...(entry as Record<string, unknown>) };
    const botId = typeof raw.id === 'string' ? raw.id : 'unknown';
    const segment = botEnvSegment(botId);

    // Channel credentials are pulled out *before* the generic sweep so they get
    // their conventional per-bot variable names instead of derived ones, and so
    // the Telegram token never produces a REQUIRED_ENV entry at all.
    const hadToken = typeof raw.token === 'string' && raw.token !== '';
    // biome-ignore lint/performance/noDelete: the key must be absent during the sweep
    delete raw.token;
    const whatsappSource = raw.whatsapp as Record<string, unknown> | undefined;
    const discordSource = raw.discord as Record<string, unknown> | undefined;
    // biome-ignore lint/performance/noDelete: rebuilt explicitly below
    delete raw.whatsapp;
    // biome-ignore lint/performance/noDelete: rebuilt explicitly below
    delete raw.discord;
    if (raw.apiKey !== undefined) {
      // biome-ignore lint/performance/noDelete: tenant API keys are not portable
      delete raw.apiKey;
      sanitizer.dropped.push(`bots[${botId}].apiKey`);
    }
    if (raw.billing !== undefined) {
      // biome-ignore lint/performance/noDelete: subscription state is not portable
      delete raw.billing;
      sanitizer.dropped.push(`bots[${botId}].billing`);
    }

    const bot = sanitizeObject(sanitizer, raw, `bots[${botId}]`);

    // The Telegram token is blanked rather than placeheld: a blank token plus
    // enabled:false is the framework's own "not startable" state, and it keeps
    // the bundle useless to anyone who gets hold of it.
    if (hadToken) {
      sanitizer.warnings.push(`Telegram token for bot "${botId}" was removed from the bundle`);
      sanitizer.redacted.push(`bots[${botId}].token`);
    }
    bot.token = '';
    bot.enabled = false;

    const channelSecret = (path: string, variable: string): string => {
      sanitizer.required.set(variable, { variable, usedBy: path, secret: true });
      sanitizer.redacted.push(path);
      return `\${${variable}}`;
    };

    if (whatsappSource) {
      const whatsapp: Record<string, unknown> = { ...whatsappSource };
      whatsapp.accessToken = channelSecret(
        `bots[${botId}].whatsapp.accessToken`,
        `AIBOT_BOT_${segment}_WHATSAPP_TOKEN`
      );
      if (whatsappSource.appSecret !== undefined) {
        whatsapp.appSecret = channelSecret(
          `bots[${botId}].whatsapp.appSecret`,
          `AIBOT_BOT_${segment}_WHATSAPP_APP_SECRET`
        );
      }
      if (whatsappSource.verifyToken !== undefined) {
        whatsapp.verifyToken = channelSecret(
          `bots[${botId}].whatsapp.verifyToken`,
          `AIBOT_BOT_${segment}_WHATSAPP_VERIFY_TOKEN`
        );
      }
      bot.whatsapp = whatsapp;
    }

    if (discordSource) {
      const discord: Record<string, unknown> = { ...discordSource };
      discord.token = channelSecret(
        `bots[${botId}].discord.token`,
        `AIBOT_BOT_${segment}_DISCORD_TOKEN`
      );
      bot.discord = discord;
    }

    // Absolute soul/work directories are the single most common reason a
    // restored bot reads an empty soul: `D:\...` means nothing on Linux.
    for (const field of ['soulDir', 'workDir'] as const) {
      const value = bot[field];
      if (isAbsolutePathValue(value)) {
        // Removed, not blanked, so the target's computed default applies.
        delete bot[field];
        sanitizer.dropped.push(`bots[${botId}].${field}`);
      } else if (typeof value === 'string') {
        bot[field] = value.replace(/\\/g, '/');
      }
    }

    bots.push(bot);
  }

  return { bots, report: sanitizer.report() };
}

/** Merge sanitizer reports from the config and roster passes. */
export function mergeReports(...reports: SanitizeReport[]): SanitizeReport {
  const required = new Map<string, EnvRequirement>();
  const redacted: string[] = [];
  const dropped: string[] = [];
  const warnings: string[] = [];

  for (const report of reports) {
    for (const requirement of report.required) {
      const existing = required.get(requirement.variable);
      if (existing) {
        existing.secret = existing.secret || requirement.secret;
        if (!existing.usedBy.includes(requirement.usedBy)) {
          existing.usedBy += `, ${requirement.usedBy}`;
        }
      } else {
        required.set(requirement.variable, { ...requirement });
      }
    }
    redacted.push(...report.redacted);
    dropped.push(...report.dropped);
    warnings.push(...report.warnings);
  }

  return {
    required: [...required.values()].sort((a, b) => a.variable.localeCompare(b.variable)),
    redacted: [...new Set(redacted)].sort(),
    dropped: [...new Set(dropped)].sort(),
    warnings,
  };
}

/** Operator-facing checklist shipped as `REQUIRED_ENV.txt`. */
export function renderRequiredEnv(report: SanitizeReport, exportedAt: string): string {
  const lines: string[] = [
    'REQUIRED ENVIRONMENT VARIABLES',
    '==============================',
    '',
    `Generated by the AIBot system exporter at ${exportedAt}.`,
    '',
    'No secret values are present in this bundle. Every credential below was',
    'replaced with a ${VAR} placeholder in config/config.json or',
    'config/bots.json. Define these in the target instance .env (or the',
    'process environment) BEFORE starting the framework — an undefined',
    'variable expands to an empty string and the feature that needs it will',
    'fail at runtime rather than at boot.',
    '',
    'Telegram bot tokens are NOT listed: every imported bot lands with an',
    'empty token and enabled=false. Paste each token into the dashboard (or',
    'config/bots.json) and enable the bot only once you are certain the',
    'source instance is no longer polling that token.',
    '',
  ];

  const secrets = report.required.filter((entry) => entry.secret);
  const rest = report.required.filter((entry) => !entry.secret);

  const section = (title: string, entries: EnvRequirement[]) => {
    lines.push(title, '-'.repeat(title.length));
    if (entries.length === 0) {
      lines.push('(none)', '');
      return;
    }
    for (const entry of entries) lines.push(`${entry.variable}    # ${entry.usedBy}`);
    lines.push('');
  };

  section('SECRETS', secrets);
  section('HOST / DEPLOYMENT SETTINGS', rest);

  if (report.dropped.length > 0) {
    lines.push(
      'DROPPED (machine-specific — the target uses its own value or a default)',
      '----------------------------------------------------------------------'
    );
    for (const path of report.dropped) lines.push(path);
    lines.push('');
  }

  lines.push(
    '.env SKELETON',
    '-------------',
    ...report.required.map((entry) => `${entry.variable}=`),
    ''
  );

  return lines.join('\n');
}
