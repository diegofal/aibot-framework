/**
 * Declarative HTTP API integrations: `integrations.httpApis[]` in config.
 *
 * Each endpoint becomes one tool, `api_<name>_<endpoint>` (same `<prefix>_<name>`
 * convention as `adaptMcpTool`). The secret lives in the environment
 * (`process.env[auth.env]`), is read at call time and only ever travels in the
 * request header: never in args, results, thrown errors or logs. The tool audit
 * keeps only arg keys and the result length for operator-only APIs (flagged
 * `sensitive`), and anything the remote echoes back is redacted anyway.
 * Redirects are never followed (the header would travel to another host).
 */

import type { HttpApiConfig, HttpApiEndpointConfig } from '../../config';
import { TOOL_ABORTED_MESSAGE, toolSignal, withTimeoutSignal } from '../../core/abort';
import type { Logger } from '../../logger';
import { sanitizePrefix } from '../../mcp/tool-adapter';
import { requireOperator } from '../../tools/operator-gate';
import { buildParametersSchema } from '../../tools/parameter-schema';
import type { Tool, ToolFailureKind, ToolResult } from '../../tools/types';
import { wrapExternalContent } from '../../tools/types';

export interface HttpApiToolDeps {
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Max chars of a non-2xx body echoed back to the model. */
export const HTTP_API_ERROR_EXCERPT_CHARS = 300;

const REDACTED = '[redacted]';

export function httpApiToolName(apiName: string, endpointName: string): string {
  return `api_${sanitizePrefix(apiName)}_${sanitizePrefix(endpointName)}`;
}

/** Tool names of every API that does not list this bot in `bots`. */
export function httpApiToolsExcludedForBot(apis: HttpApiConfig[], botId: string): Set<string> {
  const excluded = new Set<string>();
  for (const api of apis) {
    if (api.bots.includes(botId)) continue;
    for (const ep of api.endpoints) excluded.add(httpApiToolName(api.name, ep.name));
  }
  return excluded;
}

/**
 * Build the request URL: `{x}` placeholders in the path are filled (URI-encoded)
 * from the args, every other declared param goes to the query string. Args that
 * are not declared params (and internal `_` args) are ignored; declared defaults
 * fill in what the model left out. A missing required param throws.
 */
export function buildHttpApiUrl(
  baseUrl: string,
  endpoint: HttpApiEndpointConfig,
  args: Record<string, unknown>
): string {
  const params = endpoint.params ?? {};
  const argValue = (name: string): unknown => {
    const v = args[name];
    return v === undefined || v === null || v === '' ? params[name]?.default : v;
  };

  const inPath = new Set<string>();
  const path = endpoint.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    inPath.add(name);
    const v = argValue(name);
    if (v === undefined) throw new Error(`Missing required parameter "${name}"`);
    // "." / ".." survive encodeURIComponent and the URL parser resolves them:
    // a model could climb out of the declared path.
    const text = String(v).trim();
    if (text === '' || text === '.' || text === '..') {
      throw new Error(`Invalid value for path parameter "${name}"`);
    }
    return encodeURIComponent(String(v));
  });

  const query = new URLSearchParams();
  for (const [name, spec] of Object.entries(params)) {
    if (inPath.has(name)) continue;
    const v = argValue(name);
    if (v === undefined) {
      if (spec.required) throw new Error(`Missing required parameter "${name}"`);
      continue;
    }
    query.append(name, String(v));
  }

  const qs = query.toString();
  return `${baseUrl.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`;
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join(REDACTED) : text;
}

function failureKindForStatus(status: number): ToolFailureKind {
  if (status === 404 || status === 410) return 'not-found';
  if (status === 403 || status === 429) return 'blocked';
  return 'error';
}

function formatBody(text: string): string {
  if (!text.trim()) return '(empty response)';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function createEndpointTool(
  api: HttpApiConfig,
  endpoint: HttpApiEndpointConfig,
  deps: HttpApiToolDeps
): Tool {
  const name = httpApiToolName(api.name, endpoint.name);
  const label = `${api.name}/${endpoint.name}`;

  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `[API:${api.name}] ${endpoint.description}`,
        parameters: buildParametersSchema(endpoint.params),
      },
      ...(api.operatorOnly ? { sensitive: true } : {}),
    },

    async execute(args: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      if (api.operatorOnly) {
        const refused = requireOperator(args);
        if (refused) return refused;
      }

      const secret = process.env[api.auth.env] ?? '';
      if (!secret) {
        return {
          success: false,
          content: `API "${api.name}" is not configured: environment variable ${api.auth.env} is not set.`,
        };
      }

      let url: string;
      try {
        url = buildHttpApiUrl(api.baseUrl, endpoint, args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, content: `${label}: ${redact(msg, secret)}` };
      }

      const headers: Record<string, string> =
        api.auth.type === 'bearer'
          ? { Authorization: `Bearer ${secret}` }
          : { [api.auth.header as string]: secret };
      headers.Accept = 'application/json';

      const callerSignal = toolSignal(args);
      const doFetch = deps.fetch ?? fetch;
      let res: Response;
      let text: string;
      try {
        // Never follow a redirect: the auth header would go to whatever host
        // the Location names. A 3xx is reported as an error below.
        res = await doFetch(url, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: withTimeoutSignal(api.timeoutMs, callerSignal),
        });
        text = redact(await res.text(), secret);
      } catch (err) {
        if (callerSignal?.aborted) {
          return { success: false, content: TOOL_ABORTED_MESSAGE, failureKind: 'aborted' };
        }
        const isTimeout = err instanceof Error && err.name === 'TimeoutError';
        const msg = isTimeout
          ? `timed out after ${api.timeoutMs} ms`
          : redact(err instanceof Error ? err.message : String(err), secret);
        logger.warn({ tool: name, error: msg }, 'HTTP API call failed');
        return { success: false, content: `${label} request failed: ${msg}` };
      }

      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        logger.warn({ tool: name, status: res.status }, 'HTTP API answered with a redirect');
        return {
          success: false,
          content: `${label} returned a redirect${res.status ? ` (HTTP ${res.status})` : ''}; redirects are not followed — fix the API's baseUrl or path.`,
          failureKind: 'error',
        };
      }

      if (!res.ok) {
        const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, HTTP_API_ERROR_EXCERPT_CHARS);
        logger.warn({ tool: name, status: res.status }, 'HTTP API returned an error status');
        return {
          success: false,
          content: `${label} returned HTTP ${res.status}${excerpt ? `: ${excerpt}` : ''}`,
          failureKind: failureKindForStatus(res.status),
        };
      }

      return { success: true, content: wrapExternalContent(formatBody(text)) };
    },
  };
}

/** One tool per endpoint of every configured API. */
export function createHttpApiTools(apis: HttpApiConfig[], deps: HttpApiToolDeps = {}): Tool[] {
  return apis.flatMap((api) => api.endpoints.map((ep) => createEndpointTool(api, ep, deps)));
}
