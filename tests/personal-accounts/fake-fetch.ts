/**
 * A recorded fetch for the personal-accounts tests: routes by method + URL
 * prefix, never touches the network, and keeps every call for assertions.
 */
export interface FakeCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

type Handler = (call: FakeCall) => { status?: number; json?: unknown; text?: string };

export interface FakeFetch {
  fetch: typeof fetch;
  calls: FakeCall[];
  on(method: string, urlPrefix: string, handler: Handler): void;
}

export function fakeFetch(): FakeFetch {
  const routes: Array<{ method: string; prefix: string; handler: Handler }> = [];
  const calls: FakeCall[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: FakeCall = { method, url, headers, body: init.body ? String(init.body) : '' };
    calls.push(call);
    // Last registered wins, so a test can override a default route.
    const route = [...routes]
      .reverse()
      .find((r) => r.method === method && url.startsWith(r.prefix));
    if (!route) return new Response(`no fake route for ${method} ${url}`, { status: 599 });
    const out = route.handler(call);
    const body = out.json !== undefined ? JSON.stringify(out.json) : (out.text ?? '');
    return new Response(body, {
      status: out.status ?? 200,
      headers: { 'content-type': out.json !== undefined ? 'application/json' : 'text/plain' },
    });
  };
  return {
    fetch: impl as unknown as typeof fetch,
    calls,
    on: (method, prefix, handler) => routes.push({ method, prefix, handler }),
  };
}

export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GOOGLE_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
export const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
export const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const GRAPH = 'https://graph.microsoft.com/v1.0/me';
