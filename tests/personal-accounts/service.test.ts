import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalAccounts } from '../../src/personal-accounts';
import { PersonalAccountService, ReauthNeededError } from '../../src/personal-accounts/service';
import {
  type FakeFetch,
  GMAIL,
  GOOGLE_EVENTS,
  GOOGLE_TOKEN,
  GOOGLE_USERINFO,
  GRAPH,
  MS_TOKEN,
  fakeFetch,
} from './fake-fetch';

const ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'g-client',
  GOOGLE_OAUTH_CLIENT_SECRET: 'g-secret',
  MICROSOFT_OAUTH_CLIENT_ID: 'm-client',
  MICROSOFT_OAUTH_CLIENT_SECRET: 'm-secret',
};

let dir: string;
let net: FakeFetch;
let nowMs: number;

function service(env: Record<string, string | undefined> = ENV) {
  return new PersonalAccountService({
    rootDir: dir,
    redirectBase: 'http://127.0.0.1:3000',
    env,
    fetch: net.fetch,
    now: () => nowMs,
  });
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state') ?? '';
}

function googleLoginRoutes(refresh = 'g-refresh-1', email = 'ana@gmail.com') {
  net.on('POST', GOOGLE_TOKEN, (c) => {
    const p = new URLSearchParams(c.body);
    if (p.get('grant_type') === 'authorization_code')
      return {
        json: {
          access_token: 'g-access-1',
          expires_in: 3600,
          refresh_token: refresh,
          scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
        },
      };
    return { json: { access_token: 'g-access-2', expires_in: 3600 } };
  });
  net.on('GET', GOOGLE_USERINFO, () => ({ json: { email } }));
}

function msLoginRoutes(email = 'ana@outlook.com') {
  net.on('POST', MS_TOKEN, (c) => {
    const p = new URLSearchParams(c.body);
    if (p.get('grant_type') === 'authorization_code')
      return {
        json: {
          access_token: 'm-access-1',
          expires_in: 3600,
          refresh_token: 'm-refresh-1',
          scope: 'Calendars.ReadWrite Mail.Read',
        },
      };
    return {
      json: { access_token: 'm-access-2', expires_in: 3600, refresh_token: 'm-refresh-rotated' },
    };
  });
  net.on('GET', `${GRAPH}?`, () => ({ json: { mail: email, userPrincipalName: email } }));
  net.on('GET', `${GRAPH}`, () => ({ json: { mail: email, userPrincipalName: email } }));
}

async function connect(
  svc: PersonalAccountService,
  provider: 'google' | 'microsoft',
  label: string
) {
  const { url } = svc.startLogin(provider, label);
  const r = await svc.completeLogin(provider, 'the-code', stateOf(url));
  if (!r.ok) throw new Error(r.error);
  return r.slug;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'personal-accounts-'));
  net = fakeFetch();
  nowMs = Date.parse('2026-10-16T12:00:00Z');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('startLogin', () => {
  test('google: consent URL asks for offline access with the calendar and gmail scopes', () => {
    const { url } = service().startLogin('google', 'Personal');
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe('g-client');
    expect(u.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:3000/api/personal-accounts/callback/google'
    );
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('response_type')).toBe('code');
    const scope = u.searchParams.get('scope') ?? '';
    expect(scope).toContain('https://www.googleapis.com/auth/calendar.readonly');
    expect(scope).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(u.searchParams.get('state')).toBeTruthy();
    expect(net.calls).toHaveLength(0);
  });

  test('microsoft: common tenant, offline_access and Graph scopes', () => {
    const { url } = service().startLogin('microsoft', 'Work');
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
    );
    expect(u.searchParams.get('client_id')).toBe('m-client');
    const scope = u.searchParams.get('scope') ?? '';
    for (const s of ['offline_access', 'Calendars.ReadWrite', 'Mail.Read']) {
      expect(scope).toContain(s);
    }
  });

  test('refuses when the provider has no client id in the environment', () => {
    expect(() => service({}).startLogin('google', 'x')).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });

  test('providers() says which providers are configured', () => {
    expect(
      service({ GOOGLE_OAUTH_CLIENT_ID: 'a', GOOGLE_OAUTH_CLIENT_SECRET: 'b' }).providers()
    ).toEqual({
      google: true,
      microsoft: false,
    });
  });

  test('the redirect base trims a trailing slash', () => {
    const svc = new PersonalAccountService({
      rootDir: dir,
      redirectBase: 'https://dash.example.com/',
      env: ENV,
      fetch: net.fetch,
    });
    const u = new URL(svc.startLogin('google', 'x').url);
    expect(u.searchParams.get('redirect_uri')).toBe(
      'https://dash.example.com/api/personal-accounts/callback/google'
    );
  });
});

describe('completeLogin', () => {
  test('exchanges the code server-side, stores the refresh token and lists without it', async () => {
    googleLoginRoutes();
    const svc = service();
    const { url } = svc.startLogin('google', 'Personal');
    const r = await svc.completeLogin('google', 'the-code', stateOf(url));
    expect(r).toEqual({ ok: true, slug: 'personal', email: 'ana@gmail.com' });

    const exchange = new URLSearchParams(net.calls[0].body);
    expect(net.calls[0].url).toBe(GOOGLE_TOKEN);
    expect(exchange.get('code')).toBe('the-code');
    expect(exchange.get('client_secret')).toBe('g-secret');
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('redirect_uri')).toBe(
      'http://127.0.0.1:3000/api/personal-accounts/callback/google'
    );

    const stored = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'));
    expect(stored.accounts[0].refreshToken).toBe('g-refresh-1');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const listed = svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      slug: 'personal',
      provider: 'google',
      email: 'ana@gmail.com',
      label: 'Personal',
      status: 'ok',
    });
    expect(JSON.stringify(listed)).not.toContain('g-refresh-1');
  });

  test('an unknown state is refused without calling the provider', async () => {
    const r = await service().completeLogin('google', 'code', 'forged.state');
    expect(r.ok).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  test('a state is single use', async () => {
    googleLoginRoutes();
    const svc = service();
    const { url } = svc.startLogin('google', 'Personal');
    expect((await svc.completeLogin('google', 'c', stateOf(url))).ok).toBe(true);
    const calls = net.calls.length;
    expect((await svc.completeLogin('google', 'c', stateOf(url))).ok).toBe(false);
    expect(net.calls.length).toBe(calls);
  });

  test('a state expires after 10 minutes', async () => {
    googleLoginRoutes();
    const svc = service();
    const { url } = svc.startLogin('google', 'Personal');
    nowMs += 10 * 60_000 + 1;
    expect((await svc.completeLogin('google', 'c', stateOf(url))).ok).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  test('a state issued for one provider does not work for the other', async () => {
    const svc = service();
    const { url } = svc.startLogin('google', 'Personal');
    expect((await svc.completeLogin('microsoft', 'c', stateOf(url))).ok).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  test('a tampered state is refused', async () => {
    const svc = service();
    const { url } = svc.startLogin('google', 'Personal');
    const s = stateOf(url);
    const tampered = `${s.slice(0, -2)}${s.endsWith('aa') ? 'bb' : 'aa'}`;
    expect((await svc.completeLogin('google', 'c', tampered)).ok).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  test('no refresh token in the answer → error, nothing stored', async () => {
    net.on('POST', GOOGLE_TOKEN, () => ({ json: { access_token: 'a', expires_in: 3600 } }));
    net.on('GET', GOOGLE_USERINFO, () => ({ json: { email: 'a@b.c' } }));
    const svc = service();
    const { url } = svc.startLogin('google', 'Personal');
    const r = await svc.completeLogin('google', 'c', stateOf(url));
    expect(r.ok).toBe(false);
    expect(svc.list()).toEqual([]);
  });

  test('a failed exchange reports the provider error', async () => {
    net.on('POST', GOOGLE_TOKEN, () => ({ status: 400, json: { error: 'invalid_grant' } }));
    const svc = service();
    const { url } = svc.startLogin('google', 'Personal');
    const r = await svc.completeLogin('google', 'c', stateOf(url));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('invalid_grant');
  });

  test('connecting the same mailbox again refreshes it in place (same slug and label)', async () => {
    googleLoginRoutes('g-refresh-1');
    const svc = service();
    await connect(svc, 'google', 'Personal');
    googleLoginRoutes('g-refresh-2');
    const slug = await connect(svc, 'google', 'Another name');
    expect(slug).toBe('personal');
    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0].label).toBe('Personal');
    const stored = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'));
    expect(stored.accounts[0].refreshToken).toBe('g-refresh-2');
  });

  test('labels that collide get a numbered slug', async () => {
    googleLoginRoutes('r1', 'a@gmail.com');
    const svc = service();
    await connect(svc, 'google', 'Home');
    msLoginRoutes('b@outlook.com');
    expect(await connect(svc, 'microsoft', 'Home')).toBe('home-2');
  });
});

describe('access tokens', () => {
  test('cached until close to expiry, then refreshed', async () => {
    googleLoginRoutes();
    const svc = service();
    const slug = await connect(svc, 'google', 'Personal');
    const before = net.calls.length;
    // The login's own access token is reused.
    expect(await svc.accessToken(slug)).toBe('g-access-1');
    expect(net.calls.length).toBe(before);
    nowMs += 3600_000;
    expect(await svc.accessToken(slug)).toBe('g-access-2');
    const refresh = new URLSearchParams(net.calls[net.calls.length - 1].body);
    expect(refresh.get('grant_type')).toBe('refresh_token');
    expect(refresh.get('refresh_token')).toBe('g-refresh-1');
  });

  test('a rotated refresh token (Microsoft) is persisted', async () => {
    msLoginRoutes();
    const svc = service();
    const slug = await connect(svc, 'microsoft', 'Work');
    nowMs += 3600_000;
    expect(await svc.accessToken(slug)).toBe('m-access-2');
    const stored = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'));
    expect(stored.accounts[0].refreshToken).toBe('m-refresh-rotated');
  });

  test('a refused refresh marks the account reauth-needed', async () => {
    googleLoginRoutes();
    const svc = service();
    const slug = await connect(svc, 'google', 'Personal');
    net.on('POST', GOOGLE_TOKEN, () => ({ status: 400, json: { error: 'invalid_grant' } }));
    nowMs += 3600_000;
    await expect(svc.accessToken(slug)).rejects.toBeInstanceOf(ReauthNeededError);
    expect(svc.list()[0].status).toBe('reauth-needed');
    // Survives a restart.
    expect(service().list()[0].status).toBe('reauth-needed');
  });

  test('a provider outage is not a reauth', async () => {
    googleLoginRoutes();
    const svc = service();
    const slug = await connect(svc, 'google', 'Personal');
    net.on('POST', GOOGLE_TOKEN, () => ({ status: 503, text: 'unavailable' }));
    nowMs += 3600_000;
    await expect(svc.accessToken(slug)).rejects.toThrow(/503/);
    expect(svc.list()[0].status).toBe('ok');
  });

  test('reconnecting a reauth-needed account makes it ok again', async () => {
    googleLoginRoutes();
    const svc = service();
    const slug = await connect(svc, 'google', 'Personal');
    net.on('POST', GOOGLE_TOKEN, () => ({ status: 400, json: { error: 'invalid_grant' } }));
    nowMs += 3600_000;
    await svc.accessToken(slug).catch(() => {});
    googleLoginRoutes('g-refresh-3');
    await connect(svc, 'google', 'Personal');
    expect(svc.list()[0].status).toBe('ok');
  });
});

describe('calendar and mail', () => {
  async function twoAccounts() {
    const svc = service();
    googleLoginRoutes();
    await connect(svc, 'google', 'Personal');
    msLoginRoutes();
    await connect(svc, 'microsoft', 'Work');
    return svc;
  }

  test('listEvents merges Google and Microsoft, each event labeled with its account', async () => {
    const svc = await twoAccounts();
    net.on('GET', GOOGLE_EVENTS, () => ({
      json: {
        items: [
          {
            id: 'g1',
            summary: 'Dentist',
            start: { dateTime: '2026-10-16T15:00:00-03:00' },
            end: { dateTime: '2026-10-16T16:00:00-03:00' },
            location: 'Centro',
          },
          {
            id: 'g2',
            summary: 'Feriado',
            start: { date: '2026-10-16' },
            end: { date: '2026-10-17' },
          },
          {
            id: 'g3',
            status: 'cancelled',
            start: { dateTime: '2026-10-16T10:00:00Z' },
            end: { dateTime: '2026-10-16T11:00:00Z' },
          },
        ],
      },
    }));
    net.on('GET', `${GRAPH}/calendarView`, () => ({
      json: {
        value: [
          {
            id: 'm1',
            subject: 'Standup',
            start: { dateTime: '2026-10-16T12:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2026-10-16T12:30:00.0000000', timeZone: 'UTC' },
            isAllDay: false,
            attendees: [{ emailAddress: { address: 'bob@corp.com' } }],
          },
        ],
      },
    }));
    const { events, problems } = await svc.listEvents(
      new Date('2026-10-16T00:00:00Z'),
      new Date('2026-10-17T00:00:00Z')
    );
    expect(problems).toEqual([]);
    // Sorted by start across accounts: all-day 00:00Z, standup 12:00Z, dentist 18:00Z.
    expect(events.map((e) => [e.id, e.account, e.provider])).toEqual([
      ['g2', 'personal', 'google'],
      ['m1', 'work', 'microsoft'],
      ['g1', 'personal', 'google'],
    ]);
    const dentist = events.find((e) => e.id === 'g1');
    expect(dentist?.start).toBe('2026-10-16T18:00:00.000Z');
    expect(dentist?.location).toBe('Centro');
    expect(events.find((e) => e.id === 'g2')?.allDay).toBe(true);
    const standup = events.find((e) => e.id === 'm1');
    expect(standup?.start).toBe('2026-10-16T12:00:00.000Z');
    expect(standup?.attendees).toEqual(['bob@corp.com']);

    const gcall = net.calls.find((c) => c.url.startsWith(GOOGLE_EVENTS));
    expect(gcall?.headers.authorization).toBe('Bearer g-access-1');
    expect(gcall?.url).toContain('singleEvents=true');
    const mcall = net.calls.find((c) => c.url.startsWith(`${GRAPH}/calendarView`));
    expect(mcall?.headers.authorization).toBe('Bearer m-access-1');
    expect(mcall?.headers.prefer).toContain('outlook.timezone="UTC"');
  });

  test('one account failing is a problem, not a failure of the others', async () => {
    const svc = await twoAccounts();
    net.on('GET', GOOGLE_EVENTS, () => ({ json: { items: [] } }));
    net.on('GET', `${GRAPH}/calendarView`, () => ({ status: 500, text: 'boom' }));
    const { events, problems } = await svc.listEvents(
      new Date(nowMs),
      new Date(nowMs + 86_400_000)
    );
    expect(events).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0].account).toBe('work');
    expect(problems[0].reauth).toBe(false);
  });

  test('account filter: one slug only, unknown slug throws', async () => {
    const svc = await twoAccounts();
    net.on('GET', GOOGLE_EVENTS, () => ({ json: { items: [] } }));
    await svc.listEvents(new Date(nowMs), new Date(nowMs + 1000), 'personal');
    expect(net.calls.some((c) => c.url.startsWith(`${GRAPH}/calendarView`))).toBe(false);
    await expect(svc.listEvents(new Date(nowMs), new Date(nowMs + 1000), 'nope')).rejects.toThrow(
      /Unknown account/
    );
  });

  test('a 401 from the API refreshes the token once and retries', async () => {
    const svc = await twoAccounts();
    let n = 0;
    net.on('GET', GOOGLE_EVENTS, () =>
      n++ === 0 ? { status: 401, text: 'expired' } : { json: { items: [] } }
    );
    const { problems } = await svc.listEvents(new Date(nowMs), new Date(nowMs + 1000), 'personal');
    expect(problems).toEqual([]);
    const evCalls = net.calls.filter((c) => c.url.startsWith(GOOGLE_EVENTS));
    expect(evCalls.map((c) => c.headers.authorization)).toEqual([
      'Bearer g-access-1',
      'Bearer g-access-2',
    ]);
  });

  test('createEvent posts to the account calendar (Google)', async () => {
    const svc = await twoAccounts();
    net.on('POST', GOOGLE_EVENTS, (c) => {
      const b = JSON.parse(c.body);
      return {
        json: {
          id: 'new1',
          summary: b.summary,
          start: b.start,
          end: b.end,
          htmlLink: 'https://cal/new1',
        },
      };
    });
    const ev = await svc.createEvent('personal', {
      title: 'Lunch',
      start: new Date('2026-10-17T15:00:00Z'),
      end: new Date('2026-10-17T16:00:00Z'),
      attendees: ['x@y.com'],
    });
    const post = net.calls.find((c) => c.method === 'POST' && c.url.startsWith(GOOGLE_EVENTS));
    const body = JSON.parse(post?.body ?? '{}');
    expect(body.summary).toBe('Lunch');
    expect(body.start.dateTime).toBe('2026-10-17T15:00:00.000Z');
    expect(body.attendees).toEqual([{ email: 'x@y.com' }]);
    expect(ev).toMatchObject({ id: 'new1', account: 'personal', url: 'https://cal/new1' });
  });

  test('createEvent posts to /me/events (Microsoft)', async () => {
    const svc = await twoAccounts();
    net.on('POST', `${GRAPH}/events`, (c) => {
      const b = JSON.parse(c.body);
      return {
        json: {
          id: 'mnew',
          subject: b.subject,
          start: b.start,
          end: b.end,
          webLink: 'https://o/1',
        },
      };
    });
    const ev = await svc.createEvent('work', {
      title: 'Sync',
      start: new Date('2026-10-17T15:00:00Z'),
      end: new Date('2026-10-17T15:30:00Z'),
    });
    const post = net.calls.find((c) => c.method === 'POST' && c.url.startsWith(`${GRAPH}/events`));
    const body = JSON.parse(post?.body ?? '{}');
    expect(body.subject).toBe('Sync');
    expect(body.start).toEqual({ dateTime: '2026-10-17T15:00:00.000', timeZone: 'UTC' });
    expect(ev).toMatchObject({ id: 'mnew', account: 'work', start: '2026-10-17T15:00:00.000Z' });
  });

  test('searchMail: Gmail query + Graph $search, snippets only', async () => {
    const svc = await twoAccounts();
    net.on('GET', `${GMAIL}?`, () => ({ json: { messages: [{ id: 'gm1' }] } }));
    net.on('GET', `${GMAIL}/gm1`, () => ({
      json: {
        id: 'gm1',
        snippet: 'Your invoice is ready',
        internalDate: String(Date.parse('2026-10-15T10:00:00Z')),
        payload: {
          headers: [
            { name: 'From', value: 'Billing <billing@acme.com>' },
            { name: 'Subject', value: 'Invoice' },
          ],
        },
      },
    }));
    net.on('GET', `${GRAPH}/messages?`, () => ({
      json: {
        value: [
          {
            id: 'mm1',
            subject: 'Invoice too',
            from: { emailAddress: { name: 'Acme', address: 'a@acme.com' } },
            receivedDateTime: '2026-10-16T09:00:00Z',
            bodyPreview: 'Hello there',
          },
        ],
      },
    }));
    const { messages, problems } = await svc.searchMail('invoice', undefined, 5);
    expect(problems).toEqual([]);
    expect(messages.map((m) => [m.id, m.account, m.from, m.subject, m.snippet])).toEqual([
      ['mm1', 'work', 'Acme <a@acme.com>', 'Invoice too', 'Hello there'],
      ['gm1', 'personal', 'Billing <billing@acme.com>', 'Invoice', 'Your invoice is ready'],
    ]);
    const glist = net.calls.find((c) => c.url.startsWith(`${GMAIL}?`));
    expect(new URL(glist?.url ?? '').searchParams.get('q')).toBe('invoice');
    expect(new URL(glist?.url ?? '').searchParams.get('maxResults')).toBe('5');
    const mlist = net.calls.find((c) => c.url.startsWith(`${GRAPH}/messages?`));
    expect(new URL(mlist?.url ?? '').searchParams.get('$search')).toBe('"invoice"');
  });

  test('readMail: Gmail body decoded from base64url text/plain', async () => {
    const svc = await twoAccounts();
    const data = Buffer.from('Hola Ana,\nfirmá esto.').toString('base64url');
    net.on('GET', `${GMAIL}/gm1`, () => ({
      json: {
        id: 'gm1',
        internalDate: String(Date.parse('2026-10-15T10:00:00Z')),
        payload: {
          mimeType: 'multipart/alternative',
          headers: [
            { name: 'From', value: 'x@y.com' },
            { name: 'To', value: 'ana@gmail.com' },
            { name: 'Subject', value: 'Firma' },
          ],
          parts: [
            {
              mimeType: 'text/html',
              body: { data: Buffer.from('<b>no</b>').toString('base64url') },
            },
            { mimeType: 'text/plain', body: { data } },
          ],
        },
      },
    }));
    const m = await svc.readMail('personal', 'gm1');
    expect(m).toMatchObject({ id: 'gm1', account: 'personal', subject: 'Firma', from: 'x@y.com' });
    expect(m.body).toBe('Hola Ana,\nfirmá esto.');
  });

  test('readMail: Graph asks for a text body', async () => {
    const svc = await twoAccounts();
    net.on('GET', `${GRAPH}/messages/mm1`, () => ({
      json: {
        id: 'mm1',
        subject: 'S',
        from: { emailAddress: { address: 'a@acme.com' } },
        toRecipients: [{ emailAddress: { address: 'ana@outlook.com' } }],
        receivedDateTime: '2026-10-16T09:00:00Z',
        body: { contentType: 'text', content: 'Plain body' },
      },
    }));
    const m = await svc.readMail('work', 'mm1');
    expect(m.body).toBe('Plain body');
    expect(m.to).toBe('ana@outlook.com');
    const call = net.calls.find((c) => c.url.startsWith(`${GRAPH}/messages/mm1`));
    expect(call?.headers.prefer).toContain('outlook.body-content-type="text"');
  });
});

describe('labels and removal', () => {
  test('setLabel renames; remove forgets the account and its token', async () => {
    googleLoginRoutes();
    const svc = service();
    const slug = await connect(svc, 'google', 'Personal');
    svc.setLabel(slug, '  Casa  ');
    expect(svc.list()[0].label).toBe('Casa');
    expect(() => svc.setLabel(slug, '   ')).toThrow();
    svc.remove(slug);
    expect(svc.list()).toEqual([]);
    expect(readFileSync(join(dir, 'accounts.json'), 'utf8')).not.toContain('g-refresh-1');
    expect(() => svc.remove(slug)).toThrow(/Unknown account/);
  });

  test('a corrupt registry reads as empty', () => {
    require('node:fs').writeFileSync(join(dir, 'accounts.json'), '{nope');
    expect(service().list()).toEqual([]);
  });
});

describe('createPersonalAccounts', () => {
  test('lives under <paths.data>/personal-accounts with the default redirect base', () => {
    const svc = createPersonalAccounts(
      { paths: { data: dir }, integrations: { personalAccounts: { bots: [] } } } as never,
      { env: ENV, fetch: net.fetch }
    );
    const u = new URL(svc.startLogin('google', 'x').url);
    expect(u.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:3000/api/personal-accounts/callback/google'
    );
    expect(existsSync(join(dir, 'personal-accounts'))).toBe(false);
  });

  test('uses the configured redirect base', () => {
    const svc = createPersonalAccounts(
      {
        paths: { data: dir },
        integrations: { personalAccounts: { bots: [], redirectBaseUrl: 'https://x.example' } },
      } as never,
      { env: ENV, fetch: net.fetch }
    );
    const u = new URL(svc.startLogin('microsoft', 'x').url);
    expect(u.searchParams.get('redirect_uri')).toBe(
      'https://x.example/api/personal-accounts/callback/microsoft'
    );
  });
});
