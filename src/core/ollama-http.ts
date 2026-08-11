/**
 * Header construction for every outbound Ollama HTTP call.
 *
 * A local Ollama daemon needs no credentials, but Ollama Cloud
 * (`https://ollama.com`) requires `Authorization: Bearer <key>`. Pointing
 * `ollama.baseUrl` straight at the hosted API removes the need for a local
 * daemon sidecar entirely — see docs/deployment-cloud.md.
 *
 * SECURITY — the object this returns can hold a live credential:
 *   - never pass it, or a `fetch` init containing it, to a logger;
 *   - log call metadata (model, timeout, elapsed) instead;
 *   - `src/logger.ts` redacts `authorization`/`apiKey` paths as a backstop, but
 *     that is a net, not the plan.
 */

/** True when a usable (non-blank) key is configured. */
export function hasOllamaApiKey(apiKey?: string): boolean {
  return typeof apiKey === 'string' && apiKey.trim().length > 0;
}

/**
 * Build request headers for an Ollama call.
 *
 * With no key the result carries only what the caller asked for, so requests
 * against a local daemon are identical to what they were before auth existed.
 * An unset `${OLLAMA_API_KEY}` interpolates to `''` (see `substituteEnvVars` in
 * `src/config.ts`), which is why blank is treated as absent rather than as a
 * credential that would produce a confusing `Bearer `.
 */
export function buildOllamaHeaders(
  apiKey?: string,
  base?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = { ...base };
  if (hasOllamaApiKey(apiKey)) {
    headers.Authorization = `Bearer ${(apiKey as string).trim()}`;
  }
  return headers;
}

/** Headers for a JSON POST body. */
export function buildOllamaJsonHeaders(apiKey?: string): Record<string, string> {
  return buildOllamaHeaders(apiKey, { 'Content-Type': 'application/json' });
}

/** Hosts that serve Ollama's hosted API rather than a local daemon. */
const OLLAMA_CLOUD_HOSTS = new Set(['ollama.com', 'www.ollama.com', 'api.ollama.com']);

/**
 * True when `baseUrl` addresses Ollama Cloud rather than a daemon.
 *
 * The distinction is operationally load-bearing: the hosted API requires a
 * bearer token and, as of 2026-08, serves NO embedding models
 * (`ollama.com/search?c=cloud&c=embedding` is empty). Anything depending on
 * `/api/embed` — i.e. `soul.search` — therefore needs a daemon.
 */
export function isOllamaCloudUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    return OLLAMA_CLOUD_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Explain the one configuration that looks fine and cannot work: semantic
 * search pointed at a backend with no embedding models. Returns `null` when
 * the combination is valid.
 *
 * Detecting this at boot matters because the runtime symptom actively lies.
 * Measured against `https://ollama.com` on 2026-08-11 with a key that chats
 * successfully: `/api/embed` answers `{"error": "unauthorized"}`. Anyone
 * reading that goes and re-mints their API key, which cannot help — the
 * endpoint has no embedding model to serve under any credential.
 */
export function describeEmbeddingBackendGap(params: {
  baseUrl: string | undefined;
  searchEnabled: boolean;
  embeddingModel?: string;
}): string | null {
  if (!params.searchEnabled) return null;
  if (!isOllamaCloudUrl(params.baseUrl)) return null;
  const model = params.embeddingModel || '(unset)';
  return `soul.search is enabled with embeddingModel "${model}", but ollama.baseUrl points at Ollama Cloud, which serves no embedding models at all. Every /api/embed call will fail — and it fails with {"error": "unauthorized"}, which is MISLEADING: it is not an API key problem and a new key will not fix it. Either set soul.search.enabled=false, or point ollama.baseUrl at a local Ollama daemon (docker compose --profile local-ollama) with "${model}" pulled.`;
}

/**
 * Describe an `/api/embed` HTTP failure in terms of its actual cause.
 *
 * Split out from the call site so the reasoning lives next to
 * `isOllamaCloudUrl`, and so it can be tested without mocking a client.
 */
export function describeEmbedFailure(params: {
  baseUrl: string | undefined;
  status: number;
  statusText: string;
  model: string;
}): string {
  const { status, statusText, model } = params;

  if (isOllamaCloudUrl(params.baseUrl)) {
    // Deliberately does NOT say "unauthorized", whatever the status was:
    // Ollama Cloud returns 401 for a request it has no backend for, and
    // repeating that word sends people to rotate a key that is working fine.
    return `Ollama embed API error: ${status} ${statusText} — this is NOT an authentication problem. ollama.baseUrl points at Ollama Cloud, which serves no embedding models at all, so /api/embed rejects "${model}" regardless of the API key. soul.search requires a local Ollama daemon (docker compose --profile local-ollama) with "${model}" pulled, or must be disabled (soul.search.enabled=false).`;
  }

  const hint =
    status === 401 || status === 403
      ? ' — the daemon rejected the credentials; check ollama.apiKey.'
      : status === 404
        ? ` — the daemon has no model "${model}". Pull it: ollama pull ${model}`
        : '';
  return `Ollama embed API error: ${status} ${statusText}${hint}`;
}
