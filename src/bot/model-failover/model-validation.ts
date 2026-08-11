/**
 * Startup Model Validation
 *
 * Pings every model referenced by the configuration and reports the ones that
 * no longer answer, so a retired or misspelled tag is visible at boot instead
 * of being silently absorbed by the failover chain in `model-fallback.ts`.
 *
 * Why this does not use `/api/tags` as the health signal:
 *   - retired Ollama *cloud* tags keep appearing in the local daemon's tag list
 *     after the hosted backend stops serving them. `listModels()` therefore
 *     reports a dead model as present. Only a real inference call surfaces the
 *     retirement error, so each model gets a 1-token generation;
 *   - `https://ollama.com/api/tags` answers `200` with the full catalogue to a
 *     request carrying no credentials at all (measured 2026-08-11), so its
 *     status code says nothing about whether the API key works. `/api/tags` is
 *     used here for reachability only; the per-model `/api/generate` probe is
 *     the authoritative test, and a `401`/`403` from it is reported as an
 *     authentication failure rather than as an unverifiable model.
 *
 * Why this does not use `OllamaClient.generate()`:
 *   - `generate()` cascades into `models.fallbacks` on failure, which would
 *     mask exactly the failure we are trying to detect;
 *   - it has no per-call timeout, and startup must stay bounded;
 *   - it discards the HTTP response body, which is where Ollama puts the
 *     actual reason ("<model> was retired at ...").
 *
 * Target: src/bot/model-failover/model-validation.ts
 */

import {
  buildOllamaHeaders,
  buildOllamaJsonHeaders,
  hasOllamaApiKey,
  isOllamaCloudUrl,
} from '../../core/ollama-http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelRole = 'primary' | 'fallback' | 'health-check' | 'bot';

/**
 * Why a probe did not succeed.
 *
 * The distinction matters: Ollama Cloud answers a retired tag with `410 Gone`
 * and a retirement date, but answers a busy one with `503 overloaded` and a
 * cold one with nothing at all until it warms up. `unavailable` and
 * `unauthorized` mean the configuration is wrong; the rest are weather.
 */
export type ProbeFailureKind = 'unavailable' | 'unauthorized' | 'transient' | 'unknown';

/**
 * Outcome of the daemon liveness call.
 *
 * `ok` means the endpoint answered — it does NOT mean the credentials work.
 * See `createOllamaProbeClient` for why the two cannot be collapsed.
 */
export type DaemonProbeOutcome = 'ok' | 'unauthorized' | 'unreachable';

/** A model name plus every configuration site that references it. */
export interface ConfiguredModel {
  model: string;
  roles: ModelRole[];
  /** Config paths referencing this model, e.g. `ollama.models.primary`. */
  sources: string[];
}

/**
 * Minimal transport surface the validator depends on.
 * Implemented for real by `createOllamaProbeClient()`, faked in tests.
 */
export interface ModelProbeClient {
  /**
   * Reachability only. `ok` says the backend answered, not that it will accept
   * this deployment's credentials — proving that is `probeModel`'s job.
   */
  checkDaemon(timeoutMs: number): Promise<DaemonProbeOutcome>;
  /** Resolves when the model produced output; rejects with a descriptive error. */
  probeModel(model: string, timeoutMs: number): Promise<void>;
}

export interface ModelValidationResult {
  model: string;
  roles: ModelRole[];
  sources: string[];
  ok: boolean;
  /** Present only when `ok` is false. */
  error?: string;
  /** Present only when `ok` is false. */
  failureKind?: ProbeFailureKind;
  elapsedMs: number;
}

export type ModelValidationStatus =
  | 'disabled'
  | 'no-models'
  | 'daemon-unreachable'
  | 'unauthorized'
  | 'completed';

export interface ModelValidationReport {
  status: ModelValidationStatus;
  daemonReachable: boolean;
  /**
   * False when the backend rejected the credentials (401/403) on the liveness
   * call or on any model probe. Independent of `daemonReachable`, because
   * Ollama Cloud answers `/api/tags` with 200 to anonymous callers.
   */
  authOk: boolean;
  results: ModelValidationResult[];
  /** Models that are genuinely misconfigured — retired, renamed or unknown. */
  unavailable: ModelValidationResult[];
  /** Models the backend refused to serve without valid credentials. */
  unauthorized: ModelValidationResult[];
  /** Models that could not be verified this time (busy, cold, timed out). */
  unverified: ModelValidationResult[];
  /** False when the primary model is `unavailable` or `unauthorized`. */
  primaryOk: boolean;
  elapsedMs: number;
}

export interface StartupValidationSettings {
  enabled: boolean;
  timeoutMs: number;
  /** When true, a validation failure aborts startup. */
  strict: boolean;
  /**
   * Per-model overrides of `timeoutMs`, keyed by exact tag.
   *
   * Reasoning models spend their first seconds on thinking tokens before
   * emitting anything, so a one-token probe against them can take far longer
   * than a healthy chat model — `nemotron-3-super:cloud` has been measured at
   * ~36s. Left alone it produces a permanent "could not verify" warning, and a
   * warning that is always there is a warning nobody reads, which is exactly
   * how a genuinely retired model slips past this check.
   *
   * Probes run concurrently, so the largest value here sets the worst-case
   * added boot time. Raise deliberately.
   */
  modelTimeoutMs: Record<string, number>;
}

/** Thrown only in strict mode, so the caller can decide to abort startup. */
export class ModelValidationError extends Error {
  public readonly report: ModelValidationReport;

  constructor(report: ModelValidationReport) {
    super(ModelValidationError.describe(report));
    this.name = 'ModelValidationError';
    this.report = report;
  }

  private static describe(report: ModelValidationReport): string {
    if (report.status === 'daemon-unreachable') {
      return 'Model validation failed: the Ollama daemon is unreachable';
    }
    if (!report.authOk) {
      return 'Model validation failed: the Ollama backend rejected the credentials (authentication failure)';
    }
    return `Model validation failed for: ${report.unavailable.map((f) => f.model).join(', ')}`;
  }
}

/**
 * A probe failure that preserves the HTTP status, so callers can classify on
 * the status code rather than on a regex over the message.
 */
export class ModelProbeError extends Error {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ModelProbeError';
    this.statusCode = statusCode;
  }
}

/** Structural view of the config keys this module reads. */
export interface ModelValidationConfigView {
  ollama?: {
    baseUrl?: string;
    /** Bearer credential when `baseUrl` points at Ollama Cloud. Never logged. */
    apiKey?: string;
    models?: { primary?: string; fallbacks?: string[] };
    startupValidation?: Partial<StartupValidationSettings>;
  };
  soul?: {
    healthCheck?: { enabled?: boolean; llmBackend?: string; model?: string };
  };
  bots?: Array<{
    id?: string;
    enabled?: boolean;
    model?: string;
    llmBackend?: string;
  }>;
}

/** Logger surface used here — a subset of pino's. */
interface ValidationLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

export const DEFAULT_STARTUP_VALIDATION: StartupValidationSettings = {
  enabled: true,
  // Probes run concurrently, so this is the worst-case startup cost, not a sum.
  // Cloud models can need >10s from cold; below ~20s healthy models start
  // timing out and the report fills with noise.
  timeoutMs: 20_000,
  strict: false,
  // Empty by default: a slow model costs a warning, but a large override costs
  // every boot. Operators opt in per tag.
  modelTimeoutMs: {},
};

/** Cap on the daemon liveness probe, independent of the per-model budget. */
const DAEMON_PROBE_TIMEOUT_MS = 5_000;

/** Error bodies are truncated before they reach the logs. */
const MAX_ERROR_BODY_CHARS = 300;

// ---------------------------------------------------------------------------
// Config collection
// ---------------------------------------------------------------------------

/**
 * Gather every Ollama model the configuration points at, deduplicated by name.
 *
 * Models served by a non-Ollama backend (`llmBackend: 'claude-cli'`) and bots
 * that are disabled are skipped — probing them would produce noise, not signal.
 */
export function collectConfiguredModels(config: ModelValidationConfigView): ConfiguredModel[] {
  const byModel = new Map<string, ConfiguredModel>();

  const add = (model: string | undefined, role: ModelRole, source: string): void => {
    const name = model?.trim();
    if (!name) return;
    const existing = byModel.get(name);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    byModel.set(name, { model: name, roles: [role], sources: [source] });
  };

  add(config.ollama?.models?.primary, 'primary', 'ollama.models.primary');

  const fallbacks = config.ollama?.models?.fallbacks ?? [];
  fallbacks.forEach((model, index) => add(model, 'fallback', `ollama.models.fallbacks[${index}]`));

  const healthCheck = config.soul?.healthCheck;
  if (healthCheck?.enabled !== false && healthCheck?.llmBackend === 'ollama') {
    add(healthCheck.model, 'health-check', 'soul.healthCheck.model');
  }

  for (const bot of config.bots ?? []) {
    if (bot.enabled === false) continue;
    if (bot.llmBackend && bot.llmBackend !== 'ollama') continue;
    add(bot.model, 'bot', `bots[${bot.id ?? '?'}].model`);
  }

  return [...byModel.values()];
}

/** Merge configured settings over the defaults. */
export function resolveStartupValidationSettings(
  config: ModelValidationConfigView
): StartupValidationSettings {
  const configured = config.ollama?.startupValidation ?? {};
  return {
    enabled: configured.enabled ?? DEFAULT_STARTUP_VALIDATION.enabled,
    timeoutMs: configured.timeoutMs ?? DEFAULT_STARTUP_VALIDATION.timeoutMs,
    strict: configured.strict ?? DEFAULT_STARTUP_VALIDATION.strict,
    modelTimeoutMs: configured.modelTimeoutMs ?? DEFAULT_STARTUP_VALIDATION.modelTimeoutMs,
  };
}

/** Per-model budget, falling back to the global one. */
export function resolveProbeTimeout(
  model: string,
  timeoutMs: number,
  modelTimeoutMs?: Record<string, number>
): number {
  const override = modelTimeoutMs?.[model];
  return typeof override === 'number' && override > 0 ? override : timeoutMs;
}

// ---------------------------------------------------------------------------
// Probe client
// ---------------------------------------------------------------------------

/**
 * Real HTTP probe against an Ollama daemon.
 *
 * The generation is deliberately the cheapest call that still reaches the
 * model backend: a two-word prompt capped at one predicted token.
 */
export function createOllamaProbeClient(baseUrl: string, apiKey?: string): ModelProbeClient {
  const root = baseUrl.replace(/\/+$/, '');

  return {
    /**
     * `/api/tags` is a REACHABILITY test and nothing more.
     *
     * Measured against `https://ollama.com` on 2026-08-11: it answers `200`
     * with the full cloud catalogue to a request carrying no `Authorization`
     * header at all. Treating that `200` as "backend healthy" is precisely the
     * silent failure this validator exists to prevent — a missing, wrong or
     * expired key would sail through boot and only surface on the first real
     * chat. So a 200 here proves the endpoint exists, and the per-model
     * `/api/generate` probe (which does require credentials) is the
     * authoritative signal for whether it is usable.
     *
     * A 401/403 on this call is still worth distinguishing: the backend is
     * demonstrably alive, so reporting "daemon unreachable" would send the
     * operator to the wrong problem.
     */
    async checkDaemon(timeoutMs: number): Promise<DaemonProbeOutcome> {
      try {
        const response = await fetch(`${root}/api/tags`, {
          headers: buildOllamaHeaders(apiKey),
          signal: AbortSignal.timeout(Math.min(timeoutMs, DAEMON_PROBE_TIMEOUT_MS)),
        });
        if (isAuthStatus(response.status)) return 'unauthorized';
        return response.ok ? 'ok' : 'unreachable';
      } catch {
        return 'unreachable';
      }
    },

    async probeModel(model: string, timeoutMs: number): Promise<void> {
      const response = await fetch(`${root}/api/generate`, {
        method: 'POST',
        headers: buildOllamaJsonHeaders(apiKey),
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          prompt: 'ping',
          stream: false,
          options: { num_predict: 1, temperature: 0 },
        }),
      });

      if (!response.ok) {
        const body = await readBodySafely(response);
        throw new ModelProbeError(
          `HTTP ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`.trim(),
          response.status
        );
      }

      // A 200 can still carry an error payload; treat it as a failure.
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (data?.error) {
        throw new ModelProbeError(truncate(data.error));
      }
    },
  };
}

async function readBodySafely(response: Response): Promise<string> {
  try {
    const text = await response.text();
    // Ollama reports failures as {"error": "..."} — surface just the message.
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) return truncate(parsed.error);
    } catch {
      /* not JSON — fall through to the raw text */
    }
    return truncate(text);
  } catch {
    return '';
  }
}

function truncate(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_ERROR_BODY_CHARS
    ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}…`
    : trimmed;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** The model is gone or was never there. Config must change. */
const UNAVAILABLE_STATUS = new Set([400, 404, 410]);

/** The credentials are missing, wrong or expired. Config must change. */
const AUTH_STATUS = new Set([401, 403]);

function isAuthStatus(status: number): boolean {
  return AUTH_STATUS.has(status);
}

/** The backend is having a moment. Config is probably fine. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Checked before the others: Ollama Cloud answers an unauthenticated call with
 * a bare `{"error": "unauthorized"}`, which carries no status code once it has
 * been flattened into an `Error` by a caller that lost the response.
 */
const AUTH_PATTERNS = [
  /\bunauthori[sz]ed\b/i,
  /\bunauthenticated\b/i,
  /\bforbidden\b/i,
  /invalid.{0,20}\b(api[- ]?key|token|credential)/i,
  /authentication (failed|required)/i,
  /missing.{0,20}\b(api[- ]?key|authorization|credential)/i,
];

const UNAVAILABLE_PATTERNS = [
  /\bretired\b/i,
  /\bdecommissioned\b/i,
  /no longer (available|supported|served)/i,
  /model .{0,60}not found/i,
  /not found.{0,20}\bmodel\b/i,
  /unknown model/i,
  /does not exist/i,
  /try pulling it first/i,
];

const TRANSIENT_PATTERNS = [
  /timed? ?out/i,
  /overloaded/i,
  /temporarily/i,
  /unavailable/i,
  /rate.?limit/i,
  /too many requests/i,
  /try again/i,
  /retry shortly/i,
  /fetch failed/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/,
];

/**
 * Decide whether a probe failure indicts the configuration or the weather.
 *
 * Status code first — Ollama Cloud is precise about it (`410` for a retired
 * tag, `503` for an overloaded one) — then message patterns for the transport
 * errors that carry no status at all.
 */
export function classifyProbeFailure(error: unknown): ProbeFailureKind {
  const statusCode = error instanceof ModelProbeError ? error.statusCode : undefined;
  if (statusCode !== undefined) {
    if (isAuthStatus(statusCode)) return 'unauthorized';
    if (UNAVAILABLE_STATUS.has(statusCode)) return 'unavailable';
    if (TRANSIENT_STATUS.has(statusCode)) return 'transient';
  }

  const message = errorMessage(error);
  if (AUTH_PATTERNS.some((p) => p.test(message))) return 'unauthorized';
  if (UNAVAILABLE_PATTERNS.some((p) => p.test(message))) return 'unavailable';
  if (TRANSIENT_PATTERNS.some((p) => p.test(message))) return 'transient';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Probe every model concurrently and build a report. Never throws.
 *
 * The daemon is checked once up front: when it is down, every model would fail
 * with the same connection error, so the per-model probes are skipped and the
 * caller gets a single actionable fact instead of N duplicates.
 */
export async function validateConfiguredModels(params: {
  models: ConfiguredModel[];
  client: ModelProbeClient;
  timeoutMs: number;
  /** Per-tag overrides of `timeoutMs`. */
  modelTimeoutMs?: Record<string, number>;
}): Promise<ModelValidationReport> {
  const { models, client, timeoutMs, modelTimeoutMs } = params;
  const startedAt = Date.now();

  const emptyReport = (
    status: ModelValidationStatus,
    daemonReachable: boolean,
    authOk = true
  ): ModelValidationReport => ({
    status,
    daemonReachable,
    authOk,
    results: [],
    unavailable: [],
    unauthorized: [],
    unverified: [],
    primaryOk: daemonReachable && authOk,
    elapsedMs: Date.now() - startedAt,
  });

  if (models.length === 0) return emptyReport('no-models', true);

  const daemon = await client
    .checkDaemon(timeoutMs)
    .catch((): DaemonProbeOutcome => 'unreachable');

  if (daemon === 'unreachable') return emptyReport('daemon-unreachable', false);
  // The endpoint is alive and said no. Probing models would produce N copies
  // of the same 401.
  if (daemon === 'unauthorized') return emptyReport('unauthorized', true, false);

  const results = await Promise.all(
    models.map((configured) =>
      probeOne(configured, client, resolveProbeTimeout(configured.model, timeoutMs, modelTimeoutMs))
    )
  );

  const unavailable = results.filter((r) => r.failureKind === 'unavailable');
  const unauthorized = results.filter((r) => r.failureKind === 'unauthorized');
  const unverified = results.filter(
    (r) => r.failureKind === 'transient' || r.failureKind === 'unknown'
  );
  const primary = results.find((r) => r.roles.includes('primary'));

  return {
    // A reachable endpoint that refuses every credentialled call is not a
    // completed validation — nothing was actually verified.
    status: unauthorized.length > 0 && unauthorized.length === results.length
      ? 'unauthorized'
      : 'completed',
    daemonReachable: true,
    authOk: unauthorized.length === 0,
    results,
    unavailable,
    unauthorized,
    unverified,
    // With no primary configured there is nothing to be wrong about. A primary
    // that merely failed to answer this once is not grounds for an alarm.
    primaryOk: primary
      ? primary.failureKind !== 'unavailable' && primary.failureKind !== 'unauthorized'
      : true,
    elapsedMs: Date.now() - startedAt,
  };
}

async function probeOne(
  configured: ConfiguredModel,
  client: ModelProbeClient,
  timeoutMs: number
): Promise<ModelValidationResult> {
  const startedAt = Date.now();
  try {
    await withTimeout(client.probeModel(configured.model, timeoutMs), timeoutMs);
    return { ...configured, ok: true, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ...configured,
      ok: false,
      error: errorMessage(error),
      failureKind: classifyProbeFailure(error),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/**
 * Bound the wall-clock cost of a probe even if the client ignores its own
 * timeout. The losing promise is neutralised so it cannot surface later as an
 * unhandled rejection.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Model probe timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  promise.catch(() => {});
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

// ---------------------------------------------------------------------------
// Startup entry point
// ---------------------------------------------------------------------------

/**
 * Validate the configured models and log the outcome.
 *
 * Non-fatal by default: a degraded boot beats no boot. Set
 * `ollama.startupValidation.strict` to turn failures into a
 * `ModelValidationError`, which is the only case where this throws.
 */
export async function runStartupModelValidation(params: {
  config: ModelValidationConfigView;
  logger: ValidationLogger;
  /** Injected in tests; defaults to a real HTTP client against `ollama.baseUrl`. */
  client?: ModelProbeClient;
}): Promise<ModelValidationReport> {
  const { config, logger } = params;
  const settings = resolveStartupValidationSettings(config);

  if (!settings.enabled) {
    logger.debug({}, 'Startup model validation disabled');
    return {
      status: 'disabled',
      daemonReachable: false,
      authOk: true,
      results: [],
      unavailable: [],
      unauthorized: [],
      unverified: [],
      primaryOk: true,
      elapsedMs: 0,
    };
  }

  const models = collectConfiguredModels(config);
  const baseUrl = config.ollama?.baseUrl ?? '';
  const apiKeyConfigured = hasOllamaApiKey(config.ollama?.apiKey);
  const client = params.client ?? createOllamaProbeClient(baseUrl, config.ollama?.apiKey);

  logger.info({ modelCount: models.length }, 'Validating configured LLM models...');

  const report = await validateConfiguredModels({
    models,
    client,
    timeoutMs: settings.timeoutMs,
    modelTimeoutMs: settings.modelTimeoutMs,
  });

  logReport(report, logger, { baseUrl, apiKeyConfigured });

  // Strict mode reacts only to facts about the configuration. Refusing to boot
  // because a cloud model was busy for 20 seconds would be worse than useless.
  // A rejected credential is a configuration fact, not weather.
  if (
    settings.strict &&
    (report.status === 'daemon-unreachable' || !report.authOk || report.unavailable.length > 0)
  ) {
    throw new ModelValidationError(report);
  }

  return report;
}

/**
 * The one message an operator must not be able to miss.
 *
 * Three distinct causes hide behind the same 401, and they have nothing in
 * common except the status code:
 *   - direct to Ollama Cloud with no key → set one;
 *   - direct to Ollama Cloud with a bad key → mint a new one;
 *   - a local daemon proxying `:cloud` tags → the *daemon* is not signed in,
 *     and `ollama.apiKey` cannot help, because the app's bearer token is not
 *     forwarded to Ollama's hosted backend (verified against the sidecar on
 *     2026-08-11: an authenticated `/api/generate` for a `:cloud` tag against
 *     a freshly started `ollama/ollama` still returns 401).
 * Collapsing these into a generic "auth failed" sends operators to rotate a
 * key that was never the problem.
 */
function logAuthFailure(
  report: ModelValidationReport,
  logger: ValidationLogger,
  context: { baseUrl: string; apiKeyConfigured: boolean }
): void {
  const detail = {
    baseUrl: context.baseUrl,
    // Never the key itself — only whether one exists.
    apiKeyConfigured: context.apiKeyConfigured,
    rejectedModels: report.unauthorized.map((r) => r.model),
    error: report.unauthorized[0]?.error,
  };

  if (!isOllamaCloudUrl(context.baseUrl)) {
    logger.error(
      detail,
      'OLLAMA AUTHENTICATION FAILED — the local Ollama daemon refused the request (HTTP 401/403). ' +
        'For ":cloud" model tags this means the DAEMON is not signed in to Ollama Cloud: run ' +
        '`docker compose exec ollama ollama signin` (or `ollama signin` on the host) and approve the device. ' +
        'ollama.apiKey does NOT help here — the daemon does not forward the app\'s bearer token to Ollama Cloud.'
    );
    return;
  }

  if (context.apiKeyConfigured) {
    logger.error(
      detail,
      'OLLAMA AUTHENTICATION FAILED — the configured ollama.apiKey was rejected by Ollama Cloud (HTTP 401/403). ' +
        'The key is wrong, expired or revoked. Every LLM call will fail. ' +
        'Mint a new key at https://ollama.com/settings/keys and update OLLAMA_API_KEY.'
    );
    return;
  }

  logger.error(
    detail,
    'OLLAMA AUTHENTICATION FAILED — no ollama.apiKey is configured and Ollama Cloud refused the request (HTTP 401/403). ' +
      'Set OLLAMA_API_KEY in .env (config: ollama.apiKey). ' +
      'Note that /api/tags answers 200 without credentials, so reachability is not proof of access.'
  );
}

function logReport(
  report: ModelValidationReport,
  logger: ValidationLogger,
  context: { baseUrl: string; apiKeyConfigured: boolean }
): void {
  const { baseUrl } = context;

  if (report.status === 'no-models') {
    logger.debug({}, 'No Ollama models configured — skipping model validation');
    return;
  }

  // One clear message beats N identical connection errors.
  if (report.status === 'daemon-unreachable') {
    logger.error(
      { baseUrl },
      'Ollama daemon is unreachable — skipped model validation. Every LLM call will fail until it is running.'
    );
    return;
  }

  if (!report.authOk) {
    logAuthFailure(report, logger, context);
    // When nothing answered, every other observation is downstream of the
    // rejected credential and adds only noise.
    if (!report.results.some((r) => r.ok)) return;
  }

  if (report.authOk && report.unavailable.length === 0 && report.unverified.length === 0) {
    logger.info(
      { models: report.results.map((r) => r.model), elapsedMs: report.elapsedMs },
      'All configured LLM models responded'
    );
    return;
  }

  // Could not be verified this run — worth knowing, not worth alarming about.
  for (const result of report.unverified) {
    logger.warn(
      {
        model: result.model,
        roles: result.roles,
        sources: result.sources,
        error: result.error,
        elapsedMs: result.elapsedMs,
      },
      'Could not verify LLM model (busy, cold or slow) — treating as transient'
    );
  }

  for (const result of report.unavailable) {
    logger.error(
      {
        model: result.model,
        roles: result.roles,
        sources: result.sources,
        error: result.error,
      },
      'Configured LLM model is GONE — it has been retired, renamed or never existed'
    );
  }

  if (report.unavailable.length === 0) return;

  const summary = {
    unavailableModels: report.unavailable.map((r) => r.model),
    okModels: report.results.filter((r) => r.ok).map((r) => r.model),
    unavailableCount: report.unavailable.length,
    totalCount: report.results.length,
  };

  // Deliberately not `!primaryOk`: that is also false for a primary whose only
  // problem is authentication, which logAuthFailure has already explained.
  if (report.unavailable.some((r) => r.roles.includes('primary'))) {
    logger.error(
      summary,
      'PRIMARY MODEL IS DEAD — every request will pay a failed primary call before falling back. Update ollama.models.primary.'
    );
    return;
  }

  logger.error(summary, 'Some configured LLM models no longer exist — update ollama.models');
}
