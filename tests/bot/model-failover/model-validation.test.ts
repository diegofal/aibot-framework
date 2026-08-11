import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_STARTUP_VALIDATION,
  type DaemonProbeOutcome,
  type ModelProbeClient,
  ModelProbeError,
  type ModelValidationConfigView,
  ModelValidationError,
  classifyProbeFailure,
  collectConfiguredModels,
  createOllamaProbeClient,
  resolveProbeTimeout,
  resolveStartupValidationSettings,
  runStartupModelValidation,
  validateConfiguredModels,
} from '../../../src/bot/model-failover/model-validation';
import { loadConfig } from '../../../src/config';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  obj: Record<string, unknown>;
  msg: string;
}

function makeLogger() {
  const entries: LogEntry[] = [];
  const record =
    (level: LogEntry['level']) =>
    (obj: unknown, msg?: string): void => {
      entries.push({ level, obj: (obj ?? {}) as Record<string, unknown>, msg: msg ?? '' });
    };
  return {
    entries,
    logger: {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
    },
    messagesAt(level: LogEntry['level']): string[] {
      return entries.filter((e) => e.level === level).map((e) => e.msg);
    },
  };
}

/**
 * Probe client where `deadModels` reject and everything else resolves.
 * `probed` records call order so tests can assert nothing was probed.
 */
function makeProbeClient(opts: {
  daemonReachable?: boolean;
  /** Overrides `daemonReachable` when set. */
  daemonOutcome?: DaemonProbeOutcome;
  /** Model → the error its probe should throw. */
  deadModels?: Record<string, Error>;
  hangingModels?: string[];
}): ModelProbeClient & { probed: string[]; daemonChecks: number } {
  const dead = opts.deadModels ?? {};
  const hanging = new Set(opts.hangingModels ?? []);
  const probed: string[] = [];
  let daemonChecks = 0;

  return {
    probed,
    get daemonChecks() {
      return daemonChecks;
    },
    async checkDaemon(): Promise<DaemonProbeOutcome> {
      daemonChecks++;
      if (opts.daemonOutcome) return opts.daemonOutcome;
      return opts.daemonReachable === false ? 'unreachable' : 'ok';
    },
    async probeModel(model: string): Promise<void> {
      probed.push(model);
      if (hanging.has(model)) {
        await new Promise(() => {});
      }
      if (dead[model]) throw dead[model];
    },
  };
}

/** Verbatim shape of what the live daemon returns for a retired cloud tag. */
const RETIRED_MESSAGE =
  'HTTP 410 Gone: kimi-k2.5 was retired at 2026-07-31 00:00:00 -0700 PDT (ref: f82ba650)';
const retired = () => new ModelProbeError(RETIRED_MESSAGE, 410);
const notFound = () =>
  new ModelProbeError('HTTP 404 Not Found: model "x" not found, try pulling it first', 404);
const overloaded = () =>
  new ModelProbeError(
    "HTTP 503 Service Unavailable: model 'x' is temporarily overloaded, please retry shortly",
    503
  );
/** Verbatim shape of what ollama.com returns without (or with a bad) key. */
const unauthorized = () => new ModelProbeError('HTTP 401 Unauthorized: unauthorized', 401);

function makeConfig(overrides: ModelValidationConfigView = {}): ModelValidationConfigView {
  return {
    ollama: {
      baseUrl: 'http://127.0.0.1:11434',
      models: {
        primary: 'kimi-k2.6:cloud',
        fallbacks: ['nemotron-3-super:cloud', 'gpt-oss:120b-cloud'],
      },
      ...overrides.ollama,
    },
    soul: overrides.soul,
    bots: overrides.bots,
  };
}

// ---------------------------------------------------------------------------
// collectConfiguredModels
// ---------------------------------------------------------------------------

describe('collectConfiguredModels', () => {
  test('collects primary and fallbacks in configuration order', () => {
    const models = collectConfiguredModels(makeConfig());
    expect(models.map((m) => m.model)).toEqual([
      'kimi-k2.6:cloud',
      'nemotron-3-super:cloud',
      'gpt-oss:120b-cloud',
    ]);
    expect(models[0].roles).toEqual(['primary']);
    expect(models[1].roles).toEqual(['fallback']);
    expect(models[0].sources).toEqual(['ollama.models.primary']);
    expect(models[1].sources).toEqual(['ollama.models.fallbacks[0]']);
  });

  test('deduplicates a model referenced from several places, merging roles', () => {
    const models = collectConfiguredModels({
      ollama: { models: { primary: 'a:cloud', fallbacks: ['a:cloud', 'b:cloud'] } },
      soul: { healthCheck: { enabled: true, llmBackend: 'ollama', model: 'b:cloud' } },
    });
    expect(models.map((m) => m.model)).toEqual(['a:cloud', 'b:cloud']);
    expect(models[0].roles).toEqual(['primary', 'fallback']);
    expect(models[0].sources).toEqual(['ollama.models.primary', 'ollama.models.fallbacks[0]']);
    expect(models[1].roles).toEqual(['fallback', 'health-check']);
  });

  test('includes the soul health-check model only when it runs on ollama', () => {
    const onOllama = collectConfiguredModels({
      ollama: { models: { primary: 'a:cloud' } },
      soul: { healthCheck: { enabled: true, llmBackend: 'ollama', model: 'hc:cloud' } },
    });
    expect(onOllama.map((m) => m.model)).toContain('hc:cloud');

    const onClaude = collectConfiguredModels({
      ollama: { models: { primary: 'a:cloud' } },
      soul: { healthCheck: { enabled: true, llmBackend: 'claude-cli', model: 'sonnet' } },
    });
    expect(onClaude.map((m) => m.model)).not.toContain('sonnet');
  });

  test('skips the health-check model when the health check is disabled', () => {
    const models = collectConfiguredModels({
      ollama: { models: { primary: 'a:cloud' } },
      soul: { healthCheck: { enabled: false, llmBackend: 'ollama', model: 'hc:cloud' } },
    });
    expect(models.map((m) => m.model)).toEqual(['a:cloud']);
  });

  test('includes per-bot model overrides but skips disabled and claude-cli bots', () => {
    const models = collectConfiguredModels({
      ollama: { models: { primary: 'a:cloud' } },
      bots: [
        { id: 'coach', enabled: true, model: 'coach:cloud' },
        { id: 'off', enabled: false, model: 'off:cloud' },
        { id: 'claude', enabled: true, model: 'sonnet', llmBackend: 'claude-cli' },
        { id: 'inherits', enabled: true },
      ],
    });
    expect(models.map((m) => m.model)).toEqual(['a:cloud', 'coach:cloud']);
    expect(models[1].sources).toEqual(['bots[coach].model']);
  });

  test('ignores empty and whitespace-only model names', () => {
    const models = collectConfiguredModels({
      ollama: { models: { primary: '', fallbacks: ['   ', 'b:cloud'] } },
    });
    expect(models.map((m) => m.model)).toEqual(['b:cloud']);
  });

  test('returns an empty list when nothing is configured', () => {
    expect(collectConfiguredModels({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveStartupValidationSettings
// ---------------------------------------------------------------------------

describe('resolveStartupValidationSettings', () => {
  test('falls back to defaults when the key is absent', () => {
    expect(resolveStartupValidationSettings({})).toEqual(DEFAULT_STARTUP_VALIDATION);
  });

  // Two sources of truth: the Zod schema fills these in for anything loaded
  // from config.json, and DEFAULT_STARTUP_VALIDATION covers callers that
  // bypass it. They silently diverged once already.
  test("the Zod schema's defaults match DEFAULT_STARTUP_VALIDATION", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibot-cfg-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        ollama: { baseUrl: 'http://127.0.0.1:11434', models: { primary: 'kimi-k2.6:cloud' } },
        skills: { enabled: [], config: {} },
        logging: { level: 'error' },
        paths: { data: './data', logs: './data/logs', skills: './src/skills' },
      })
    );

    try {
      const config = await loadConfig(configPath);
      expect(config.ollama.startupValidation).toEqual(DEFAULT_STARTUP_VALIDATION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('applies partial overrides without dropping the rest', () => {
    const settings = resolveStartupValidationSettings({
      ollama: { startupValidation: { strict: true } },
    });
    expect(settings.strict).toBe(true);
    expect(settings.enabled).toBe(DEFAULT_STARTUP_VALIDATION.enabled);
    expect(settings.timeoutMs).toBe(DEFAULT_STARTUP_VALIDATION.timeoutMs);
  });
});

// ---------------------------------------------------------------------------
// classifyProbeFailure
// ---------------------------------------------------------------------------

describe('classifyProbeFailure', () => {
  test.each([
    [400, 'unavailable'],
    [404, 'unavailable'],
    [410, 'unavailable'],
    [408, 'transient'],
    [429, 'transient'],
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
    [504, 'transient'],
  ] as const)('HTTP %d → %s', (status, expected) => {
    expect(classifyProbeFailure(new ModelProbeError(`HTTP ${status}`, status))).toBe(expected);
  });

  test('a retired cloud tag is permanent', () => {
    expect(classifyProbeFailure(retired())).toBe('unavailable');
  });

  test('an overloaded cloud model is transient', () => {
    expect(classifyProbeFailure(overloaded())).toBe('transient');
  });

  test('falls back to message patterns when there is no status code', () => {
    expect(
      classifyProbeFailure(new Error('model "foo:cloud" not found, try pulling it first'))
    ).toBe('unavailable');
    expect(classifyProbeFailure(new Error('kimi-k2.5 was retired at 2026-07-31'))).toBe(
      'unavailable'
    );
    expect(classifyProbeFailure(new Error('Model probe timed out after 20000ms'))).toBe(
      'transient'
    );
    expect(classifyProbeFailure(new Error('fetch failed'))).toBe('transient');
    expect(classifyProbeFailure({ code: 'ECONNRESET' })).toBe('unknown');
  });

  test('an unrecognisable failure is neither dead nor transient', () => {
    expect(classifyProbeFailure(new Error('something weird happened'))).toBe('unknown');
  });

  // Before this, 401 fell through to 'unknown' and was logged as "busy, cold
  // or slow" — the loudest possible way to say nothing about a dead key.
  test.each([401, 403] as const)('HTTP %d is an authentication failure', (status) => {
    expect(classifyProbeFailure(new ModelProbeError(`HTTP ${status}`, status))).toBe(
      'unauthorized'
    );
  });

  test('recognises an auth failure from the message when there is no status', () => {
    expect(classifyProbeFailure(new Error('unauthorized'))).toBe('unauthorized');
    expect(classifyProbeFailure(new Error('{"error":"unauthorized"}'))).toBe('unauthorized');
    expect(classifyProbeFailure(new Error('invalid api key'))).toBe('unauthorized');
    expect(classifyProbeFailure(new Error('authentication required'))).toBe('unauthorized');
    expect(classifyProbeFailure(new Error('Forbidden'))).toBe('unauthorized');
  });

  test('auth wins over the transient patterns it textually overlaps with', () => {
    // "unauthorized" must not be absorbed by the /unavailable/i-style noise.
    expect(classifyProbeFailure(new ModelProbeError('unauthorized, try again', 401))).toBe(
      'unauthorized'
    );
  });
});

// ---------------------------------------------------------------------------
// validateConfiguredModels
// ---------------------------------------------------------------------------

describe('validateConfiguredModels', () => {
  test('all models valid', async () => {
    const client = makeProbeClient({});
    const report = await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig()),
      client,
      timeoutMs: 1000,
    });

    expect(report.status).toBe('completed');
    expect(report.daemonReachable).toBe(true);
    expect(report.unavailable).toEqual([]);
    expect(report.unverified).toEqual([]);
    expect(report.primaryOk).toBe(true);
    expect(report.results).toHaveLength(3);
    expect(report.results.every((r) => r.ok)).toBe(true);
  });

  test('primary dead but fallbacks fine', async () => {
    const client = makeProbeClient({ deadModels: { 'kimi-k2.5:cloud': retired() } });
    const models = collectConfiguredModels(
      makeConfig({
        ollama: {
          models: {
            primary: 'kimi-k2.5:cloud',
            fallbacks: ['nemotron-3-super:cloud', 'gpt-oss:120b-cloud'],
          },
        },
      })
    );

    const report = await validateConfiguredModels({ models, client, timeoutMs: 1000 });

    expect(report.status).toBe('completed');
    expect(report.primaryOk).toBe(false);
    expect(report.unavailable.map((f) => f.model)).toEqual(['kimi-k2.5:cloud']);
    expect(report.unavailable[0].error).toBe(RETIRED_MESSAGE);
    expect(report.unavailable[0].failureKind).toBe('unavailable');
    expect(report.unavailable[0].roles).toEqual(['primary']);
    expect(report.results.filter((r) => r.ok)).toHaveLength(2);
  });

  test('every model dead', async () => {
    const client = makeProbeClient({
      deadModels: {
        'kimi-k2.6:cloud': retired(),
        'nemotron-3-super:cloud': notFound(),
        'gpt-oss:120b-cloud': notFound(),
      },
    });
    const report = await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig()),
      client,
      timeoutMs: 1000,
    });

    expect(report.unavailable).toHaveLength(3);
    expect(report.primaryOk).toBe(false);
    expect(report.results.some((r) => r.ok)).toBe(false);
  });

  test('a transient failure is not counted as a dead model', async () => {
    const client = makeProbeClient({ deadModels: { 'kimi-k2.6:cloud': overloaded() } });
    const report = await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig()),
      client,
      timeoutMs: 1000,
    });

    expect(report.unavailable).toEqual([]);
    expect(report.unverified.map((r) => r.model)).toEqual(['kimi-k2.6:cloud']);
    expect(report.unverified[0].failureKind).toBe('transient');
    // A busy primary is still a configured primary.
    expect(report.primaryOk).toBe(true);
  });

  test('daemon unreachable short-circuits before any model is probed', async () => {
    const client = makeProbeClient({ daemonReachable: false });
    const report = await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig()),
      client,
      timeoutMs: 1000,
    });

    expect(report.status).toBe('daemon-unreachable');
    expect(report.daemonReachable).toBe(false);
    expect(report.results).toEqual([]);
    expect(report.unavailable).toEqual([]);
    expect(client.probed).toEqual([]);
  });

  test('a throwing daemon check is treated as unreachable, not as a crash', async () => {
    const client: ModelProbeClient = {
      checkDaemon: async () => {
        throw new Error('ECONNREFUSED');
      },
      probeModel: async () => {},
    };
    const report = await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig()),
      client,
      timeoutMs: 1000,
    });
    expect(report.status).toBe('daemon-unreachable');
  });

  test('reports no-models when nothing is configured and skips the daemon check', async () => {
    const client = makeProbeClient({});
    const report = await validateConfiguredModels({ models: [], client, timeoutMs: 1000 });

    expect(report.status).toBe('no-models');
    expect(client.daemonChecks).toBe(0);
  });

  test('a hanging probe is bounded by the timeout and reported as a failure', async () => {
    const client = makeProbeClient({ hangingModels: ['nemotron-3-super:cloud'] });
    const report = await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig()),
      client,
      timeoutMs: 50,
    });

    const hung = report.unverified.find((f) => f.model === 'nemotron-3-super:cloud');
    expect(hung).toBeDefined();
    expect(hung?.error).toContain('timed out');
    // A cold cloud model is slow, not dead.
    expect(hung?.failureKind).toBe('transient');
    expect(report.unavailable).toEqual([]);
    // The healthy models still resolve — one slow model does not poison the run.
    expect(report.results.filter((r) => r.ok).map((r) => r.model)).toEqual([
      'kimi-k2.6:cloud',
      'gpt-oss:120b-cloud',
    ]);
  });

  test('models are probed concurrently, not one after another', async () => {
    let inFlight = 0;
    let peak = 0;
    const client: ModelProbeClient = {
      checkDaemon: async () => 'ok',
      probeModel: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
      },
    };

    await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig()),
      client,
      timeoutMs: 1000,
    });

    expect(peak).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Authentication — the /api/tags false positive
// ---------------------------------------------------------------------------

describe('authentication failures are never reported as health', () => {
  test('an unauthorized liveness call short-circuits and is not "unreachable"', async () => {
    const client = makeProbeClient({ daemonOutcome: 'unauthorized' });
    const report = await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig()),
      client,
      timeoutMs: 1000,
    });

    expect(report.status).toBe('unauthorized');
    expect(report.authOk).toBe(false);
    // The endpoint demonstrably answered — saying "unreachable" would send the
    // operator to the wrong problem entirely.
    expect(report.daemonReachable).toBe(true);
    expect(report.primaryOk).toBe(false);
    expect(client.probed).toEqual([]);
  });

  test('a reachable endpoint that 401s every model is not a completed validation', async () => {
    const client = makeProbeClient({
      deadModels: {
        'kimi-k2.6:cloud': unauthorized(),
        'nemotron-3-super:cloud': unauthorized(),
        'gpt-oss:120b-cloud': unauthorized(),
      },
    });
    const report = await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig()),
      client,
      timeoutMs: 1000,
    });

    expect(report.status).toBe('unauthorized');
    expect(report.authOk).toBe(false);
    expect(report.unauthorized).toHaveLength(3);
    // The regression this guards: these used to land in `unverified` and be
    // logged as "busy, cold or slow".
    expect(report.unverified).toEqual([]);
    expect(report.unavailable).toEqual([]);
    expect(report.primaryOk).toBe(false);
  });

  test('a healthy run reports authOk', async () => {
    const report = await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig()),
      client: makeProbeClient({}),
      timeoutMs: 1000,
    });
    expect(report.authOk).toBe(true);
    expect(report.unauthorized).toEqual([]);
  });

  test('one model rejected while others answer still flags auth', async () => {
    const client = makeProbeClient({ deadModels: { 'gpt-oss:120b-cloud': unauthorized() } });
    const report = await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig()),
      client,
      timeoutMs: 1000,
    });

    expect(report.authOk).toBe(false);
    expect(report.unauthorized.map((r) => r.model)).toEqual(['gpt-oss:120b-cloud']);
    // Not every model failed, so this is not a wholesale auth outage.
    expect(report.status).toBe('completed');
  });
});

describe('startup logging of an authentication failure', () => {
  const cloudConfig = (apiKey?: string) =>
    makeConfig({
      ollama: {
        baseUrl: 'https://ollama.com',
        apiKey,
        models: { primary: 'kimi-k2.6:cloud', fallbacks: [] },
      },
    });

  test('names authentication explicitly and does not claim the models are fine', async () => {
    const { logger, entries, messagesAt } = makeLogger();

    await runStartupModelValidation({
      config: cloudConfig('sk-live-key-value'),
      logger,
      client: makeProbeClient({ deadModels: { 'kimi-k2.6:cloud': unauthorized() } }),
    });

    const error = entries.find((e) => e.msg.includes('OLLAMA AUTHENTICATION FAILED'));
    expect(error?.level).toBe('error');
    expect(error?.msg).toContain('rejected');
    // The false-positive we are fixing: no success line, and no "busy or cold".
    expect(messagesAt('info').some((m) => m.includes('All configured LLM models responded'))).toBe(
      false
    );
    expect(messagesAt('warn')).toEqual([]);
  });

  test('distinguishes "no key configured" from "key rejected"', async () => {
    const withoutKey = makeLogger();
    await runStartupModelValidation({
      config: cloudConfig(undefined),
      logger: withoutKey.logger,
      client: makeProbeClient({ daemonOutcome: 'unauthorized' }),
    });
    const missing = withoutKey.entries.find((e) => e.msg.includes('AUTHENTICATION FAILED'));
    expect(missing?.msg).toContain('no ollama.apiKey is configured');
    expect(missing?.obj.apiKeyConfigured).toBe(false);
    // The specific trap this whole fix exists for.
    expect(missing?.msg).toContain('/api/tags answers 200 without credentials');

    const withKey = makeLogger();
    await runStartupModelValidation({
      config: cloudConfig('sk-live-key-value'),
      logger: withKey.logger,
      client: makeProbeClient({ daemonOutcome: 'unauthorized' }),
    });
    const rejected = withKey.entries.find((e) => e.msg.includes('AUTHENTICATION FAILED'));
    expect(rejected?.msg).toContain('wrong, expired or revoked');
    expect(rejected?.obj.apiKeyConfigured).toBe(true);
  });

  // The sidecar topology: a 401 here is the DAEMON not being signed in to
  // Ollama Cloud. Telling the operator to re-mint ollama.apiKey would be
  // actively wrong — the daemon never forwards it.
  test('a local daemon rejection points at `ollama signin`, not at the API key', async () => {
    const { logger, entries } = makeLogger();

    await runStartupModelValidation({
      config: makeConfig({
        ollama: {
          baseUrl: 'http://ollama:11434',
          apiKey: 'sk-valid-for-the-cloud',
          models: { primary: 'kimi-k2.6:cloud', fallbacks: [] },
        },
      }),
      logger,
      client: makeProbeClient({ deadModels: { 'kimi-k2.6:cloud': unauthorized() } }),
    });

    const error = entries.find((e) => e.msg.includes('AUTHENTICATION FAILED'));
    expect(error?.level).toBe('error');
    expect(error?.msg).toContain('ollama signin');
    expect(error?.msg).toContain('does NOT help');
    expect(error?.msg).not.toContain('settings/keys');
  });

  test('the API key itself never reaches the log', async () => {
    const { logger, entries } = makeLogger();
    const key = 'sk-ollama-secret-value-do-not-log';

    await runStartupModelValidation({
      config: cloudConfig(key),
      logger,
      client: makeProbeClient({ daemonOutcome: 'unauthorized' }),
    });

    expect(JSON.stringify(entries)).not.toContain(key);
  });

  test('strict mode aborts startup on an authentication failure', async () => {
    const { logger } = makeLogger();

    await expect(
      runStartupModelValidation({
        config: makeConfig({
          ollama: {
            baseUrl: 'https://ollama.com',
            apiKey: 'sk-bad',
            models: { primary: 'kimi-k2.6:cloud', fallbacks: [] },
            startupValidation: { strict: true },
          },
        }),
        logger,
        client: makeProbeClient({ daemonOutcome: 'unauthorized' }),
      })
    ).rejects.toThrow('rejected the credentials');
  });
});

// ---------------------------------------------------------------------------
// createOllamaProbeClient — the real transport, HTTP mocked
// ---------------------------------------------------------------------------

describe('createOllamaProbeClient against Ollama Cloud', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Reproduces the measured cloud behaviour: open /api/tags, guarded /api/generate. */
  function installCloudFetch(generateStatus: number): void {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        // 200 with NO credentials — this is the false positive being fixed.
        return new Response(JSON.stringify({ models: [{ name: 'gpt-oss:120b' }] }), {
          status: 200,
        });
      }
      if (generateStatus === 200) {
        return new Response(JSON.stringify({ response: 'x', done: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: generateStatus,
        statusText: 'Unauthorized',
      });
    }) as typeof globalThis.fetch;
  }

  test('an anonymous 200 from /api/tags is reachability, not health', async () => {
    installCloudFetch(401);
    const client = createOllamaProbeClient('https://ollama.com');

    // Liveness alone still says "ok" — that is all it can honestly claim.
    expect(await client.checkDaemon(1_000)).toBe('ok');

    // The whole validation must nonetheless fail, loudly and specifically.
    const report = await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig({ ollama: { models: { primary: 'x:cloud' } } })),
      client,
      timeoutMs: 1_000,
    });
    expect(report.status).toBe('unauthorized');
    expect(report.authOk).toBe(false);
    expect(report.unauthorized[0].error).toContain('401');
  });

  test('a valid key produces a clean report', async () => {
    installCloudFetch(200);
    const report = await validateConfiguredModels({
      models: collectConfiguredModels(makeConfig({ ollama: { models: { primary: 'x:cloud' } } })),
      client: createOllamaProbeClient('https://ollama.com', 'sk-good'),
      timeoutMs: 1_000,
    });
    expect(report.status).toBe('completed');
    expect(report.authOk).toBe(true);
  });

  test('a 401 on the liveness call itself is auth, not unreachable', async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"unauthorized"}', { status: 401 })) as typeof globalThis.fetch;
    expect(await createOllamaProbeClient('https://ollama.com', 'sk-bad').checkDaemon(1_000)).toBe(
      'unauthorized'
    );
  });

  test('a connection failure is still unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;
    expect(
      await createOllamaProbeClient('http://127.0.0.1:11434').checkDaemon(1_000)
    ).toBe('unreachable');
  });

  test('a local daemon with no key is unaffected — 200 means ok', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 })) as typeof globalThis.fetch;
    expect(await createOllamaProbeClient('http://127.0.0.1:11434').checkDaemon(1_000)).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// runStartupModelValidation
// ---------------------------------------------------------------------------

describe('runStartupModelValidation', () => {
  test('disabled by config: reports disabled and never touches the network', async () => {
    const client = makeProbeClient({});
    const { logger } = makeLogger();

    const report = await runStartupModelValidation({
      config: makeConfig({
        ollama: {
          models: { primary: 'kimi-k2.6:cloud' },
          startupValidation: { enabled: false },
        },
      }),
      logger,
      client,
    });

    expect(report.status).toBe('disabled');
    expect(client.daemonChecks).toBe(0);
    expect(client.probed).toEqual([]);
  });

  test('logs a success line when every model answers', async () => {
    const { logger, messagesAt } = makeLogger();
    const report = await runStartupModelValidation({
      config: makeConfig(),
      logger,
      client: makeProbeClient({}),
    });

    expect(report.unavailable).toEqual([]);
    expect(messagesAt('error')).toEqual([]);
    expect(messagesAt('info').some((m) => m.includes('All configured LLM models responded'))).toBe(
      true
    );
  });

  test('names the dead model and its error, and flags a dead primary loudly', async () => {
    const { logger, entries } = makeLogger();

    await runStartupModelValidation({
      config: makeConfig({
        ollama: {
          models: {
            primary: 'kimi-k2.5:cloud',
            fallbacks: ['nemotron-3-super:cloud'],
          },
        },
      }),
      logger,
      client: makeProbeClient({ deadModels: { 'kimi-k2.5:cloud': retired() } }),
    });

    const perModel = entries.find((e) => e.msg.includes('is GONE'));
    expect(perModel?.level).toBe('error');
    expect(perModel?.obj.model).toBe('kimi-k2.5:cloud');
    expect(perModel?.obj.error).toBe(RETIRED_MESSAGE);

    const summary = entries.find((e) => e.msg.includes('PRIMARY MODEL IS DEAD'));
    expect(summary?.level).toBe('error');
    expect(summary?.obj.unavailableModels).toEqual(['kimi-k2.5:cloud']);
  });

  test('a dead fallback is an error but does not claim the primary is dead', async () => {
    const { logger, entries } = makeLogger();

    await runStartupModelValidation({
      config: makeConfig(),
      logger,
      client: makeProbeClient({ deadModels: { 'gpt-oss:120b-cloud': notFound() } }),
    });

    expect(entries.some((e) => e.msg.includes('PRIMARY MODEL IS DEAD'))).toBe(false);
    const summary = entries.find((e) => e.msg.includes('no longer exist'));
    expect(summary?.level).toBe('error');
    expect(summary?.obj.unavailableModels).toEqual(['gpt-oss:120b-cloud']);
    expect(summary?.obj.okModels).toEqual(['kimi-k2.6:cloud', 'nemotron-3-super:cloud']);
  });

  test('a transient failure warns but never escalates to an error', async () => {
    const { logger, entries, messagesAt } = makeLogger();

    await runStartupModelValidation({
      config: makeConfig(),
      logger,
      client: makeProbeClient({ deadModels: { 'kimi-k2.6:cloud': overloaded() } }),
    });

    expect(messagesAt('error')).toEqual([]);
    const warning = entries.find((e) => e.msg.includes('Could not verify LLM model'));
    expect(warning?.level).toBe('warn');
    expect(warning?.obj.model).toBe('kimi-k2.6:cloud');
  });

  test('an unreachable daemon logs one message, not one per model', async () => {
    const { logger, entries } = makeLogger();

    const report = await runStartupModelValidation({
      config: makeConfig(),
      logger,
      client: makeProbeClient({ daemonReachable: false }),
    });

    expect(report.status).toBe('daemon-unreachable');
    const errors = entries.filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toContain('Ollama daemon is unreachable');
    expect(errors[0].obj.baseUrl).toBe('http://127.0.0.1:11434');
  });

  test('non-strict mode never throws, whatever fails', async () => {
    const { logger } = makeLogger();

    await expect(
      runStartupModelValidation({
        config: makeConfig(),
        logger,
        client: makeProbeClient({
          deadModels: {
            'kimi-k2.6:cloud': retired(),
            'nemotron-3-super:cloud': notFound(),
            'gpt-oss:120b-cloud': notFound(),
          },
        }),
      })
    ).resolves.toBeDefined();

    await expect(
      runStartupModelValidation({
        config: makeConfig(),
        logger,
        client: makeProbeClient({ daemonReachable: false }),
      })
    ).resolves.toBeDefined();
  });

  test('strict mode throws ModelValidationError carrying the report', async () => {
    const { logger } = makeLogger();

    const promise = runStartupModelValidation({
      config: makeConfig({
        ollama: {
          models: { primary: 'kimi-k2.5:cloud' },
          startupValidation: { strict: true },
        },
      }),
      logger,
      client: makeProbeClient({ deadModels: { 'kimi-k2.5:cloud': retired() } }),
    });

    await expect(promise).rejects.toThrow(ModelValidationError);
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ModelValidationError);
      const typed = error as ModelValidationError;
      expect(typed.message).toContain('kimi-k2.5:cloud');
      expect(typed.report.unavailable).toHaveLength(1);
    });
  });

  test('strict mode tolerates a transient failure — busy is not misconfigured', async () => {
    const { logger } = makeLogger();

    await expect(
      runStartupModelValidation({
        config: makeConfig({
          ollama: {
            models: { primary: 'kimi-k2.6:cloud' },
            startupValidation: { strict: true },
          },
        }),
        logger,
        client: makeProbeClient({ deadModels: { 'kimi-k2.6:cloud': overloaded() } }),
      })
    ).resolves.toMatchObject({ status: 'completed' });
  });

  test('strict mode throws when the daemon is unreachable', async () => {
    const { logger } = makeLogger();

    await expect(
      runStartupModelValidation({
        config: makeConfig({
          ollama: {
            models: { primary: 'kimi-k2.6:cloud' },
            startupValidation: { strict: true },
          },
        }),
        logger,
        client: makeProbeClient({ daemonReachable: false }),
      })
    ).rejects.toThrow('the Ollama daemon is unreachable');
  });

  test('strict mode stays quiet when everything is healthy', async () => {
    const { logger } = makeLogger();

    await expect(
      runStartupModelValidation({
        config: makeConfig({
          ollama: {
            models: { primary: 'kimi-k2.6:cloud' },
            startupValidation: { strict: true },
          },
        }),
        logger,
        client: makeProbeClient({}),
      })
    ).resolves.toMatchObject({ status: 'completed' });
  });
});

// ---------------------------------------------------------------------------
// Per-model probe timeout
// ---------------------------------------------------------------------------

/** Probe client that records the timeout each model was given. */
function makeTimeoutRecordingClient(): ModelProbeClient & { budgets: Record<string, number> } {
  const budgets: Record<string, number> = {};
  return {
    budgets,
    async checkDaemon(): Promise<DaemonProbeOutcome> {
      return 'ok';
    },
    async probeModel(model: string, timeoutMs: number): Promise<void> {
      budgets[model] = timeoutMs;
    },
  };
}

describe('resolveProbeTimeout', () => {
  test('falls back to the global budget with no override', () => {
    expect(resolveProbeTimeout('gpt-oss:120b-cloud', 20_000)).toBe(20_000);
    expect(resolveProbeTimeout('gpt-oss:120b-cloud', 20_000, {})).toBe(20_000);
  });

  test('a per-model override wins', () => {
    expect(
      resolveProbeTimeout('nemotron-3-super:cloud', 20_000, {
        'nemotron-3-super:cloud': 60_000,
      })
    ).toBe(60_000);
  });

  test('an override can also shorten the budget', () => {
    expect(resolveProbeTimeout('fast:cloud', 20_000, { 'fast:cloud': 2_000 })).toBe(2_000);
  });

  test('non-positive overrides are ignored', () => {
    expect(resolveProbeTimeout('x', 20_000, { x: 0 })).toBe(20_000);
    expect(resolveProbeTimeout('x', 20_000, { x: -5 })).toBe(20_000);
  });
});

describe('startupValidation.modelTimeoutMs', () => {
  test('defaults to an empty map', () => {
    expect(DEFAULT_STARTUP_VALIDATION.modelTimeoutMs).toEqual({});
    expect(resolveStartupValidationSettings(makeConfig()).modelTimeoutMs).toEqual({});
  });

  test('is read from config', () => {
    const settings = resolveStartupValidationSettings(
      makeConfig({
        ollama: {
          models: { primary: 'kimi-k2.6:cloud' },
          startupValidation: { modelTimeoutMs: { 'nemotron-3-super:cloud': 60_000 } },
        },
      })
    );
    expect(settings.modelTimeoutMs).toEqual({ 'nemotron-3-super:cloud': 60_000 });
  });

  test('validateConfiguredModels applies the override per model', async () => {
    const client = makeTimeoutRecordingClient();
    await validateConfiguredModels({
      models: [
        { model: 'kimi-k2.6:cloud', roles: ['primary'], sources: ['ollama.models.primary'] },
        {
          model: 'nemotron-3-super:cloud',
          roles: ['fallback'],
          sources: ['ollama.models.fallbacks[1]'],
        },
      ],
      client,
      timeoutMs: 20_000,
      modelTimeoutMs: { 'nemotron-3-super:cloud': 60_000 },
    });

    expect(client.budgets['kimi-k2.6:cloud']).toBe(20_000);
    expect(client.budgets['nemotron-3-super:cloud']).toBe(60_000);
  });

  test('a slow reasoning model given enough time verifies instead of warning', async () => {
    const { logger, messagesAt } = makeLogger();
    const client = makeTimeoutRecordingClient();

    const report = await runStartupModelValidation({
      config: makeConfig({
        ollama: {
          models: {
            primary: 'kimi-k2.6:cloud',
            fallbacks: ['gpt-oss:120b-cloud', 'nemotron-3-super:cloud'],
          },
          startupValidation: { modelTimeoutMs: { 'nemotron-3-super:cloud': 60_000 } },
        },
      }),
      logger,
      client,
    });

    expect(client.budgets['nemotron-3-super:cloud']).toBe(60_000);
    expect(report.unverified).toHaveLength(0);
    expect(messagesAt('warn')).toHaveLength(0);
  });
});
