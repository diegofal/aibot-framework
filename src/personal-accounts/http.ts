/**
 * The one HTTP helper of personal accounts. Every call goes through an
 * injected `fetch`, so tests never reach Google or Microsoft.
 */

export type FetchLike = typeof fetch;

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export interface RequestOptions {
  method?: string;
  token?: string;
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

/** The provider's own words for an error body, short. */
function describeErrorBody(text: string): string {
  try {
    const o = JSON.parse(text) as {
      error?: string | { message?: string; code?: string };
      error_description?: string;
    };
    if (typeof o.error === 'string')
      return o.error_description ? `${o.error}: ${o.error_description}` : o.error;
    if (o.error && typeof o.error === 'object') return o.error.message ?? o.error.code ?? text;
  } catch {
    /* not JSON */
  }
  return text;
}

export async function requestJson<T>(
  fetchFn: FetchLike,
  url: string,
  opts: RequestOptions = {}
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let body: string | undefined;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetchFn(url, { method: opts.method ?? 'GET', headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new ProviderHttpError(
      res.status,
      `${res.status} ${describeErrorBody(text).slice(0, 300)}`.trim()
    );
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderHttpError(res.status, `${res.status} answer was not JSON`);
  }
}
