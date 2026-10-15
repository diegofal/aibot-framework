import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { claudeAccountsRoutes } from '../../../src/web/routes/claude-accounts';

const quiet: any = { info() {}, warn() {}, error() {}, debug() {} };

function app(tenantId?: string) {
  const calls: string[] = [];
  const accounts: any = {
    list: async () => [{ slug: 'default', active: true, loggedIn: true }],
    startLogin: async (label: string) => {
      calls.push(`login:${label}`);
      return { loginId: 'login-1', slug: 'second', url: 'https://claude.com/x' };
    },
    submitCode: async (id: string, code: string) => {
      calls.push(`code:${id}:${code}`);
      return code === 'good' ? { ok: true, slug: 'second' } : { ok: false, error: 'invalid code' };
    },
    cancel: (id: string) => calls.push(`cancel:${id}`),
    activate: async (slug: string) => {
      if (slug !== 'second') throw new Error('Unknown account: x');
      calls.push(`activate:${slug}`);
    },
    remove: async (slug: string) => calls.push(`remove:${slug}`),
  };
  const root = new Hono();
  root.use('*', async (c, next) => {
    if (tenantId) c.set('tenant' as never, { tenantId } as never);
    await next();
  });
  root.route('/api/claude-accounts', claudeAccountsRoutes({ accounts, logger: quiet }));
  return { root, calls };
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('claude accounts routes', () => {
  test('list, log in, submit the code, activate, remove', async () => {
    const { root, calls } = app();
    expect((await (await root.request('/api/claude-accounts')).json()).accounts).toHaveLength(1);
    const started = await (
      await root.request('/api/claude-accounts/login', post({ label: 'Second' }))
    ).json();
    expect(started.url).toBe('https://claude.com/x');
    const ok = await root.request(
      '/api/claude-accounts/login/login-1/code',
      post({ code: 'good' })
    );
    expect(ok.status).toBe(200);
    const bad = await root.request(
      '/api/claude-accounts/login/login-1/code',
      post({ code: 'bad' })
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid code');
    expect((await root.request('/api/claude-accounts/second/activate', post({}))).status).toBe(200);
    expect((await root.request('/api/claude-accounts/x/activate', post({}))).status).toBe(400);
    expect((await root.request('/api/claude-accounts/second', { method: 'DELETE' })).status).toBe(
      200
    );
    expect(calls).toEqual([
      'login:Second',
      'code:login-1:good',
      'code:login-1:bad',
      'activate:second',
      'remove:second',
    ]);
  });

  test('a name and a code are required', async () => {
    const { root } = app();
    expect((await root.request('/api/claude-accounts/login', post({}))).status).toBe(400);
    expect((await root.request('/api/claude-accounts/login/l/code', post({}))).status).toBe(400);
  });

  test('a tenant that is not admin gets 403', async () => {
    const { root } = app('acme');
    expect((await root.request('/api/claude-accounts')).status).toBe(403);
  });
});
