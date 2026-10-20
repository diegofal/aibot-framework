import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { PersonalAccountService } from '../../../src/personal-accounts/service';
import { isPublicApiPath } from '../../../src/web/public-api-paths';
import { personalAccountsRoutes } from '../../../src/web/routes/personal-accounts';
import {
  type FakeFetch,
  GOOGLE_TOKEN,
  GOOGLE_USERINFO,
  fakeFetch,
} from '../../personal-accounts/fake-fetch';

const logger = { info() {}, warn() {}, debug() {}, error() {}, child: () => logger } as never;

let dir: string;
let net: FakeFetch;
let svc: PersonalAccountService;

function app(tenantId?: string) {
  const a = new Hono();
  if (tenantId)
    a.use('*', async (c, next) => {
      c.set('tenant' as never, { tenantId } as never);
      await next();
    });
  a.route('/api/personal-accounts', personalAccountsRoutes({ accounts: svc, logger }));
  return a;
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-routes-'));
  net = fakeFetch();
  svc = new PersonalAccountService({
    rootDir: dir,
    redirectBase: 'http://127.0.0.1:3000',
    env: { GOOGLE_OAUTH_CLIENT_ID: 'g', GOOGLE_OAUTH_CLIENT_SECRET: 's' },
    fetch: net.fetch,
  });
  net.on('POST', GOOGLE_TOKEN, () => ({
    json: { access_token: 'a', expires_in: 3600, refresh_token: 'r' },
  }));
  net.on('GET', GOOGLE_USERINFO, () => ({ json: { email: 'ana<x>@gmail.com' } }));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function login(a = app()) {
  const res = await a.request(
    '/api/personal-accounts/login',
    json({ provider: 'google', label: 'Home' })
  );
  const { url } = (await res.json()) as { url: string };
  return new URL(url).searchParams.get('state') ?? '';
}

describe('admin routes', () => {
  test('GET lists accounts and which providers are configured', async () => {
    const res = await app().request('/api/personal-accounts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accounts: [],
      providers: { google: true, microsoft: false },
    });
  });

  test('POST /login returns the consent URL', async () => {
    const res = await app().request(
      '/api/personal-accounts/login',
      json({ provider: 'google', label: 'Home' })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toStartWith('https://accounts.google.com/');
  });

  test('POST /login rejects an unknown provider and an unconfigured one', async () => {
    let res = await app().request('/api/personal-accounts/login', json({ provider: 'yahoo' }));
    expect(res.status).toBe(400);
    res = await app().request('/api/personal-accounts/login', json({ provider: 'microsoft' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('MICROSOFT_OAUTH_CLIENT_ID');
  });

  test('a tenant that is not admin gets 403 everywhere but the callback', async () => {
    const t = app('tenant-a');
    expect((await t.request('/api/personal-accounts')).status).toBe(403);
    expect(
      (await t.request('/api/personal-accounts/login', json({ provider: 'google' }))).status
    ).toBe(403);
    expect((await t.request('/api/personal-accounts/x', { method: 'DELETE' })).status).toBe(403);
    expect(
      (await t.request('/api/personal-accounts/x', { ...json({ label: 'y' }), method: 'PATCH' }))
        .status
    ).toBe(403);
    // The callback answers on its own terms (400 for a missing state), never 403.
    expect((await t.request('/api/personal-accounts/callback/google')).status).toBe(400);
  });

  test('PATCH renames and DELETE removes', async () => {
    const state = await login();
    await app().request(
      `/api/personal-accounts/callback/google?code=c&state=${encodeURIComponent(state)}`
    );
    let res = await app().request('/api/personal-accounts/home', {
      ...json({ label: 'Casa' }),
      method: 'PATCH',
    });
    expect(res.status).toBe(200);
    expect(svc.list()[0].label).toBe('Casa');
    res = await app().request('/api/personal-accounts/home', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(svc.list()).toEqual([]);
    res = await app().request('/api/personal-accounts/home', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('callback (public)', () => {
  test('a known state connects the account and says so (escaped)', async () => {
    const state = await login();
    const res = await app().request(
      `/api/personal-accounts/callback/google?code=c&state=${encodeURIComponent(state)}`
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ana&lt;x&gt;@gmail.com');
    expect(html).not.toContain('ana<x>@gmail.com');
    expect(svc.list()).toHaveLength(1);
  });

  test('an unknown state is a 400 that never calls the provider', async () => {
    const res = await app().request('/api/personal-accounts/callback/google?code=c&state=forged');
    expect(res.status).toBe(400);
    expect(net.calls).toHaveLength(0);
  });

  test('a denied consent is a 400 and burns the state', async () => {
    const state = await login();
    const res = await app().request(
      `/api/personal-accounts/callback/google?error=access_denied&state=${encodeURIComponent(state)}`
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('access_denied');
    const again = await app().request(
      `/api/personal-accounts/callback/google?code=c&state=${encodeURIComponent(state)}`
    );
    expect(again.status).toBe(400);
    expect(net.calls).toHaveLength(0);
  });

  test('an unknown provider is a 404', async () => {
    expect(
      (await app().request('/api/personal-accounts/callback/yahoo?code=c&state=s')).status
    ).toBe(404);
  });
});

describe('isPublicApiPath', () => {
  test('the OAuth callback skips tenant auth; the rest of personal accounts does not', () => {
    expect(isPublicApiPath('/api/personal-accounts/callback/google')).toBe(true);
    expect(isPublicApiPath('/api/personal-accounts/callback/microsoft')).toBe(true);
    expect(isPublicApiPath('/api/personal-accounts')).toBe(false);
    expect(isPublicApiPath('/api/personal-accounts/login')).toBe(false);
  });

  test('keeps the existing public paths', () => {
    for (const p of [
      '/api/status',
      '/api/auth/login',
      '/api/admin/x',
      '/api/tenants',
      '/api/tenant/x',
      '/api/onboarding/x',
    ]) {
      expect(isPublicApiPath(p)).toBe(true);
    }
    expect(isPublicApiPath('/api/bots')).toBe(false);
  });
});
