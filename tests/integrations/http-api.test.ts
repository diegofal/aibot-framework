import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { HttpApiConfigSchema, IntegrationsConfigSchema } from '../../src/config';
import type { HttpApiConfig } from '../../src/config';
import {
  buildHttpApiUrl,
  createHttpApiTools,
  httpApiToolName,
  httpApiToolsExcludedForBot,
} from '../../src/integrations/http-api';

const logs: unknown[] = [];
const logger = {
  info: (...a: unknown[]) => logs.push(a),
  warn: (...a: unknown[]) => logs.push(a),
  debug: (...a: unknown[]) => logs.push(a),
  error: (...a: unknown[]) => logs.push(a),
  child: () => logger,
} as any;

const SECRET = 'sk-test-very-secret-123';
const ENV = 'TEST_HTTP_API_KEY';
/** The dashboard operator: what the executor injects for an admin dashboard thread. */
const OPERATOR = { _actor: 'operator' } as const;

function finanzas(overrides: Partial<Record<string, unknown>> = {}): HttpApiConfig {
  return HttpApiConfigSchema.parse({
    name: 'finanzas',
    baseUrl: 'https://finance.example.com',
    auth: { type: 'bearer', env: ENV },
    bots: ['default'],
    endpoints: [
      { name: 'saldos', method: 'GET', path: '/api/agent/saldos', description: 'Balances' },
      {
        name: 'vencimientos',
        method: 'GET',
        path: '/api/agent/vencimientos',
        description: 'Payments due',
        params: { dias: { type: 'integer', default: 7, description: 'Days ahead' } },
      },
      {
        name: 'cuenta',
        method: 'GET',
        path: '/api/agent/cuentas/{id}',
        description: 'One account',
        params: { id: { type: 'string', required: true }, full: { type: 'boolean' } },
      },
    ],
    ...overrides,
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(status = 200, body: unknown = { ok: true }) {
  const calls: Call[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch: fn as unknown as typeof fetch };
}

function tool(api: HttpApiConfig, name: string, f: typeof fetch) {
  const t = createHttpApiTools([api], { fetch: f }).find(
    (x) => x.definition.function.name === name
  );
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function headerOf(call: Call, name: string): string | null {
  return new Headers(call.init.headers).get(name);
}

beforeEach(() => {
  process.env[ENV] = SECRET;
  logs.length = 0;
});
afterEach(() => {
  delete process.env[ENV];
});

describe('HttpApiConfigSchema', () => {
  test('accepts a GET endpoint and applies defaults', () => {
    const api = finanzas();
    expect(api.operatorOnly).toBe(true);
    expect(api.timeoutMs).toBeGreaterThan(0);
  });

  test('rejects any method other than GET', () => {
    const r = HttpApiConfigSchema.safeParse({
      name: 'x',
      baseUrl: 'https://x.example.com',
      auth: { type: 'bearer', env: 'X' },
      bots: ['a'],
      endpoints: [{ name: 'e', method: 'POST', path: '/e', description: 'd' }],
    });
    expect(r.success).toBe(false);
  });

  test('header auth requires a header name', () => {
    const r = HttpApiConfigSchema.safeParse({
      name: 'x',
      baseUrl: 'https://x.example.com',
      auth: { type: 'header', env: 'X' },
      bots: ['a'],
      endpoints: [{ name: 'e', method: 'GET', path: '/e', description: 'd' }],
    });
    expect(r.success).toBe(false);
  });

  test('integrations object is optional and httpApis defaults to empty', () => {
    expect(IntegrationsConfigSchema.parse({}).httpApis).toEqual([]);
  });
});

describe('tool building', () => {
  test('one tool per endpoint named api_<name>_<endpoint>', () => {
    const tools = createHttpApiTools([finanzas()], { fetch: fakeFetch().fetch });
    expect(tools.map((t) => t.definition.function.name)).toEqual([
      'api_finanzas_saldos',
      'api_finanzas_vencimientos',
      'api_finanzas_cuenta',
    ]);
    expect(httpApiToolName('my-api', 'get.x')).toBe('api_my_api_get_x');
  });

  test('parameters schema comes from params (type, description, default, required)', () => {
    const tools = createHttpApiTools([finanzas()], { fetch: fakeFetch().fetch });
    const venc = tools[1].definition.function.parameters;
    expect(venc.properties.dias).toEqual({
      type: 'integer',
      description: 'Days ahead',
      default: 7,
    });
    expect(venc.required).toBeUndefined();
    const cuenta = tools[2].definition.function.parameters;
    expect(cuenta.required).toEqual(['id']);
  });
});

describe('buildHttpApiUrl', () => {
  test('substitutes and encodes path params, rest go to the query string', () => {
    const ep = finanzas().endpoints[2];
    const url = buildHttpApiUrl('https://finance.example.com/', ep, { id: 'a/b c', full: true });
    expect(url).toBe('https://finance.example.com/api/agent/cuentas/a%2Fb%20c?full=true');
  });

  test('applies defaults and skips undefined and internal args', () => {
    const ep = finanzas().endpoints[1];
    expect(buildHttpApiUrl('https://f.example.com', ep, { _chatId: 1 })).toBe(
      'https://f.example.com/api/agent/vencimientos?dias=7'
    );
    expect(buildHttpApiUrl('https://f.example.com', ep, { dias: 30 })).toBe(
      'https://f.example.com/api/agent/vencimientos?dias=30'
    );
  });

  test('ignores args that are not declared params', () => {
    const ep = finanzas().endpoints[0];
    expect(buildHttpApiUrl('https://f.example.com', ep, { evil: 'x' })).toBe(
      'https://f.example.com/api/agent/saldos'
    );
  });

  test('a path param that is empty, "." or ".." is rejected', () => {
    const ep = finanzas().endpoints[2];
    for (const id of ['.', '..', ' ', ' .. ']) {
      expect(() => buildHttpApiUrl('https://f.example.com', ep, { id })).toThrow(/id/);
    }
    expect(buildHttpApiUrl('https://f.example.com', ep, { id: 'a.b' })).toBe(
      'https://f.example.com/api/agent/cuentas/a.b'
    );
  });

  test('missing required path param throws', () => {
    const ep = finanzas().endpoints[2];
    expect(() => buildHttpApiUrl('https://f.example.com', ep, {})).toThrow(/id/);
  });
});

describe('execution', () => {
  test('sends the bearer header; the secret never reaches args or result', async () => {
    const f = fakeFetch(200, { saldo: 100, token: SECRET });
    const args: Record<string, unknown> = { ...OPERATOR };
    const r = await tool(finanzas(), 'api_finanzas_saldos', f.fetch).execute(args, logger);
    expect(r.success).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].init.method).toBe('GET');
    expect(headerOf(f.calls[0], 'authorization')).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(args)).not.toContain(SECRET);
    expect(r.content).not.toContain(SECRET);
    expect(r.content).toContain('"saldo": 100');
    expect(r.content).toContain('EXTERNAL_UNTRUSTED_CONTENT');
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  test('header auth sends the configured header', async () => {
    const f = fakeFetch();
    const api = finanzas({ auth: { type: 'header', env: ENV, header: 'X-Api-Key' } });
    await tool(api, 'api_finanzas_saldos', f.fetch).execute({ ...OPERATOR }, logger);
    expect(headerOf(f.calls[0], 'x-api-key')).toBe(SECRET);
    expect(headerOf(f.calls[0], 'authorization')).toBeNull();
  });

  test('missing env var → honest error without calling', async () => {
    delete process.env[ENV];
    const f = fakeFetch();
    const r = await tool(finanzas(), 'api_finanzas_saldos', f.fetch).execute(
      { ...OPERATOR },
      logger
    );
    expect(r.success).toBe(false);
    expect(r.content).toContain(ENV);
    expect(f.calls).toHaveLength(0);
  });

  test('non-2xx → failure with status and a short body excerpt', async () => {
    const f = fakeFetch(500, `boom ${SECRET} ${'x'.repeat(2000)}`);
    const r = await tool(finanzas(), 'api_finanzas_saldos', f.fetch).execute(
      { ...OPERATOR },
      logger
    );
    expect(r.success).toBe(false);
    expect(r.content).toContain('500');
    expect(r.content).toContain('boom');
    expect(r.content.length).toBeLessThan(600);
    expect(r.content).not.toContain(SECRET);
    expect(r.content.toLowerCase()).not.toContain('authorization');
  });

  test('404 → not-found, 403 → blocked', async () => {
    const r404 = await tool(finanzas(), 'api_finanzas_saldos', fakeFetch(404, 'no').fetch).execute(
      { ...OPERATOR },
      logger
    );
    expect(r404.failureKind).toBe('not-found');
    const r403 = await tool(finanzas(), 'api_finanzas_saldos', fakeFetch(403, 'no').fetch).execute(
      { ...OPERATOR },
      logger
    );
    expect(r403.failureKind).toBe('blocked');
  });

  test('a thrown fetch error never carries the secret', async () => {
    const bad = (async () => {
      throw new Error(`network down Authorization: Bearer ${SECRET}`);
    }) as unknown as typeof fetch;
    const r = await tool(finanzas(), 'api_finanzas_saldos', bad).execute({ ...OPERATOR }, logger);
    expect(r.success).toBe(false);
    expect(r.content).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  test('a redirect is never followed: 3xx is an error and the secret goes to one host only', async () => {
    const calls: Call[] = [];
    const redirecting = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('', {
        status: 302,
        headers: { location: 'https://evil.example.net/steal' },
      });
    }) as unknown as typeof fetch;
    const r = await tool(finanzas(), 'api_finanzas_saldos', redirecting).execute(
      { ...OPERATOR },
      logger
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].init.redirect).toBe('manual');
    expect(r.success).toBe(false);
    expect(r.content).toContain('302');
    expect(r.content).toContain('redirect');
  });

  test('non-JSON body is returned as text', async () => {
    const f = fakeFetch(200, 'plain text');
    const r = await tool(finanzas(), 'api_finanzas_saldos', f.fetch).execute(
      { ...OPERATOR },
      logger
    );
    expect(r.success).toBe(true);
    expect(r.content).toContain('plain text');
  });
});

describe('operator gate', () => {
  test('requester is the operator → calls', async () => {
    const f = fakeFetch();
    const r = await tool(finanzas(), 'api_finanzas_saldos', f.fetch).execute(
      { _requester: { channelKind: 'telegram', address: '1', isOperator: true } },
      logger
    );
    expect(r.success).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  test('requester is not the operator → refused without fetch', async () => {
    const f = fakeFetch();
    const r = await tool(finanzas(), 'api_finanzas_saldos', f.fetch).execute(
      { _requester: { channelKind: 'telegram', address: '2', isOperator: false } },
      logger
    );
    expect(r.success).toBe(false);
    expect(r.failureKind).toBe('policy');
    expect(f.calls).toHaveLength(0);
  });

  test("the bot's own run (_actor: 'self') → refused without fetch", async () => {
    const f = fakeFetch();
    const r = await tool(finanzas(), 'api_finanzas_saldos', f.fetch).execute(
      { _actor: 'self' },
      logger
    );
    expect(r.failureKind).toBe('policy');
    expect(f.calls).toHaveLength(0);
  });

  test('no requester and no actor (MCP expose, collaboration) → refused without fetch', async () => {
    const f = fakeFetch();
    const r = await tool(finanzas(), 'api_finanzas_saldos', f.fetch).execute({}, logger);
    expect(r.success).toBe(false);
    expect(r.failureKind).toBe('policy');
    expect(f.calls).toHaveLength(0);
  });

  test('operatorOnly APIs are flagged sensitive; open ones are not', () => {
    for (const t of createHttpApiTools([finanzas()])) expect(t.definition.sensitive).toBe(true);
    for (const t of createHttpApiTools([finanzas({ operatorOnly: false })])) {
      expect(t.definition.sensitive).toBeUndefined();
    }
  });

  test('operatorOnly: false → anyone can call', async () => {
    const f = fakeFetch();
    const r = await tool(finanzas({ operatorOnly: false }), 'api_finanzas_saldos', f.fetch).execute(
      { _requester: { channelKind: 'telegram', address: '2', isOperator: false } },
      logger
    );
    expect(r.success).toBe(true);
  });
});

describe('httpApiToolsExcludedForBot', () => {
  test('excludes the tools of APIs that do not list the bot', () => {
    const apis = [finanzas()];
    expect(httpApiToolsExcludedForBot(apis, 'default').size).toBe(0);
    expect([...httpApiToolsExcludedForBot(apis, 'other')]).toEqual([
      'api_finanzas_saldos',
      'api_finanzas_vencimientos',
      'api_finanzas_cuenta',
    ]);
  });
});
