/**
 * Personal accounts (docs/plans/personal-organizer-plan.md, P1a): the
 * operator's Google and Microsoft accounts, several of each, for calendar and
 * mail. Modeled on `src/claude-accounts/service.ts`.
 *
 * Login is the OAuth authorization-code flow:
 * 1. `startLogin(provider, label)` (behind the dashboard's admin auth) issues a
 *    signed, single-use `state` valid for 10 minutes and returns the consent URL.
 * 2. The provider redirects the browser to the public callback route, which
 *    calls `completeLogin(provider, code, state)`. An unknown, expired, reused
 *    or tampered state is refused before any call to the provider; the code is
 *    exchanged server-side.
 *
 * Refresh tokens live in `<rootDir>/accounts.json` (atomic write; the data
 * volume, like the Telegram token); access tokens only in memory, refreshed
 * when they are about to expire. A refresh the provider refuses (400/401)
 * marks the account `reauth-needed` until it is connected again. Every HTTP
 * call goes through the injected `fetch`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type FetchLike, ProviderHttpError, requestJson } from './http';
import { googleProvider } from './providers/google';
import { microsoftProvider } from './providers/microsoft';
import type { AccountApi, ProviderClient } from './providers/types';
import {
  type AccountProblem,
  type CalendarEvent,
  type MailMessage,
  type MailSummary,
  type NewEventInput,
  PERSONAL_PROVIDERS,
  type PersonalAccountView,
  type PersonalProvider,
  type StoredAccount,
} from './types';

export const LOGIN_STATE_TTL_MS = 10 * 60_000;
/** Refresh this long before the provider's expiry. */
const TOKEN_MARGIN_MS = 60_000;

const PROVIDERS: Record<PersonalProvider, ProviderClient> = {
  google: googleProvider,
  microsoft: microsoftProvider,
};

export function isPersonalProvider(v: unknown): v is PersonalProvider {
  return typeof v === 'string' && (PERSONAL_PROVIDERS as readonly string[]).includes(v);
}

/** The account must be connected again from the dashboard. */
export class ReauthNeededError extends Error {
  constructor(
    readonly slug: string,
    readonly label: string,
    detail?: string
  ) {
    super(
      `Account "${label}" needs to be connected again (Integrations → Personal accounts)${detail ? `: ${detail}` : ''}`
    );
    this.name = 'ReauthNeededError';
  }
}

export interface PersonalAccountServiceOptions {
  rootDir: string;
  /** Where the dashboard is reachable from the operator's browser, e.g. `http://127.0.0.1:3000`. */
  redirectBase: string;
  /** Where client ids and secrets are read (default `process.env`). */
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  now?: () => number;
}

export type CompleteLoginResult =
  | { ok: true; slug: string; email: string }
  | { ok: false; error: string };

interface Registry {
  version: 1;
  accounts: StoredAccount[];
}

interface PendingLogin {
  provider: PersonalProvider;
  label: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'account'
  );
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const view = ({ refreshToken: _r, ...rest }: StoredAccount): PersonalAccountView => rest;

export class PersonalAccountService {
  private readonly fetchFn: FetchLike;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly registryPath: string;
  private readonly secret = randomBytes(32);
  private readonly pending = new Map<string, PendingLogin>();
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(private readonly opts: PersonalAccountServiceOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.registryPath = join(opts.rootDir, 'accounts.json');
  }

  // ─── Registry ───

  private read(): Registry {
    try {
      const r = JSON.parse(readFileSync(this.registryPath, 'utf8')) as Registry;
      if (r && Array.isArray(r.accounts)) return { version: 1, accounts: r.accounts };
    } catch {
      /* first use, or unreadable: no accounts */
    }
    return { version: 1, accounts: [] };
  }

  private write(r: Registry): void {
    mkdirSync(this.opts.rootDir, { recursive: true });
    const tmp = `${this.registryPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.registryPath);
  }

  private update(slug: string, patch: (a: StoredAccount) => void): void {
    const r = this.read();
    const a = r.accounts.find((x) => x.slug === slug);
    if (!a) return;
    patch(a);
    this.write(r);
  }

  list(): PersonalAccountView[] {
    return this.read().accounts.map(view);
  }

  /** Which providers have a client id and secret in the environment. */
  providers(): Record<PersonalProvider, boolean> {
    const has = (p: ProviderClient) => !!this.env[p.clientIdEnv] && !!this.env[p.clientSecretEnv];
    return { google: has(googleProvider), microsoft: has(microsoftProvider) };
  }

  setLabel(slug: string, label: string): void {
    const name = label.trim();
    if (!name) throw new Error('A name is required');
    const r = this.read();
    const a = r.accounts.find((x) => x.slug === slug);
    if (!a) throw new Error(`Unknown account: ${slug}`);
    a.label = name.slice(0, 60);
    this.write(r);
  }

  /** Forget an account and its refresh token. It stays authorized at the provider until revoked there. */
  remove(slug: string): void {
    const r = this.read();
    if (!r.accounts.some((a) => a.slug === slug)) throw new Error(`Unknown account: ${slug}`);
    r.accounts = r.accounts.filter((a) => a.slug !== slug);
    this.write(r);
    this.tokens.delete(slug);
  }

  // ─── Login ───

  redirectUri(provider: PersonalProvider): string {
    const base = this.opts.redirectBase.replace(/\/+$/, '');
    return `${base}/api/personal-accounts/callback/${provider}`;
  }

  private client(provider: PersonalProvider): { id: string; secret: string } {
    const p = PROVIDERS[provider];
    const id = this.env[p.clientIdEnv];
    const secret = this.env[p.clientSecretEnv];
    if (!id || !secret)
      throw new Error(
        `${provider} is not configured: set ${p.clientIdEnv} and ${p.clientSecretEnv} (see docs/personal-accounts-setup.md)`
      );
    return { id, secret };
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  /** The consent URL for a new account (or to reconnect one: same mailbox → same account). */
  startLogin(provider: PersonalProvider, label: string): { url: string; state: string } {
    const { id } = this.client(provider);
    const p = PROVIDERS[provider];
    const now = this.now();
    for (const [nonce, l] of this.pending) if (l.expiresAt <= now) this.pending.delete(nonce);
    const nonce = randomBytes(16).toString('base64url');
    const expiresAt = now + LOGIN_STATE_TTL_MS;
    const payload = Buffer.from(JSON.stringify({ n: nonce, p: provider, e: expiresAt })).toString(
      'base64url'
    );
    const state = `${payload}.${this.sign(payload)}`;
    this.pending.set(nonce, { provider, label: label.trim().slice(0, 60), expiresAt });
    const q = new URLSearchParams({
      client_id: id,
      redirect_uri: this.redirectUri(provider),
      response_type: 'code',
      scope: p.scopes.join(' '),
      state,
      ...p.authParams,
    });
    return { url: `${p.authorizeUrl}?${q}`, state };
  }

  /** Consume a state: the pending login it names, or why not. Single use either way. */
  private takeState(
    provider: PersonalProvider,
    state: string
  ): { login: PendingLogin } | { error: string } {
    const [payload, sig] = String(state ?? '').split('.');
    if (!payload || !sig) return { error: 'Unknown sign-in request' };
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      return { error: 'Unknown sign-in request' };
    let parsed: { n?: string; p?: string; e?: number };
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return { error: 'Unknown sign-in request' };
    }
    const login = parsed.n ? this.pending.get(parsed.n) : undefined;
    if (!login || !parsed.n) return { error: 'Unknown or already used sign-in request' };
    this.pending.delete(parsed.n);
    if (login.expiresAt <= this.now()) return { error: 'The sign-in request expired: start again' };
    if (parsed.p !== provider || login.provider !== provider)
      return { error: 'The sign-in request was for another provider' };
    return { login };
  }

  /** Burn a state without connecting (the operator declined consent). */
  discardLogin(provider: PersonalProvider, state: string): void {
    this.takeState(provider, state);
  }

  async completeLogin(
    provider: PersonalProvider,
    code: string,
    state: string
  ): Promise<CompleteLoginResult> {
    const taken = this.takeState(provider, state);
    if ('error' in taken) return { ok: false, error: taken.error };
    if (!code) return { ok: false, error: 'The provider sent no authorization code' };
    const p = PROVIDERS[provider];
    try {
      const { id, secret } = this.client(provider);
      const tok = await requestJson<TokenResponse>(this.fetchFn, p.tokenUrl, {
        method: 'POST',
        form: {
          grant_type: 'authorization_code',
          code,
          client_id: id,
          client_secret: secret,
          redirect_uri: this.redirectUri(provider),
          scope: p.scopes.join(' '),
        },
      });
      if (!tok.access_token) return { ok: false, error: 'The provider returned no access token' };
      if (!tok.refresh_token)
        return {
          ok: false,
          error:
            'The provider returned no refresh token (offline access not granted): remove the app from the account permissions and connect again',
        };
      const accessToken = tok.access_token;
      const email = (
        await p.fetchEmail((url, init) =>
          requestJson(this.fetchFn, url, { ...init, token: accessToken })
        )
      ).trim();
      if (!email) return { ok: false, error: 'Could not read the account email' };

      const r = this.read();
      const scopes = (tok.scope ?? p.scopes.join(' ')).split(/\s+/).filter(Boolean);
      const same = r.accounts.find(
        (a) => a.provider === provider && a.email.toLowerCase() === email.toLowerCase()
      );
      let slug: string;
      if (same) {
        same.refreshToken = tok.refresh_token;
        same.scopes = scopes;
        same.status = 'ok';
        same.lastError = undefined;
        slug = same.slug;
      } else {
        const base = slugify(taken.login.label || email.split('@')[0]);
        slug = base;
        for (let i = 2; r.accounts.some((a) => a.slug === slug); i++) slug = `${base}-${i}`;
        r.accounts.push({
          slug,
          provider,
          email,
          label: taken.login.label || email,
          refreshToken: tok.refresh_token,
          scopes,
          addedAt: new Date(this.now()).toISOString(),
          status: 'ok',
        });
      }
      this.write(r);
      this.tokens.set(slug, {
        token: accessToken,
        expiresAt: this.now() + (tok.expires_in ?? 3600) * 1000,
      });
      return { ok: true, slug, email };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  // ─── Tokens ───

  /** A valid access token for the account, refreshing it when needed. */
  async accessToken(slug: string): Promise<string> {
    const account = this.read().accounts.find((a) => a.slug === slug);
    if (!account) throw new Error(`Unknown account: ${slug}`);
    if (account.status === 'reauth-needed')
      throw new ReauthNeededError(slug, account.label, account.lastError);
    const cached = this.tokens.get(slug);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.now()) return cached.token;
    const inflight = this.refreshing.get(slug);
    if (inflight) return inflight;
    const run = this.refresh(account).finally(() => this.refreshing.delete(slug));
    this.refreshing.set(slug, run);
    return run;
  }

  private async refresh(account: StoredAccount): Promise<string> {
    const p = PROVIDERS[account.provider];
    const { id, secret } = this.client(account.provider);
    let tok: TokenResponse;
    try {
      tok = await requestJson<TokenResponse>(this.fetchFn, p.tokenUrl, {
        method: 'POST',
        form: {
          grant_type: 'refresh_token',
          refresh_token: account.refreshToken,
          client_id: id,
          client_secret: secret,
          scope: p.scopes.join(' '),
        },
      });
    } catch (err) {
      if (err instanceof ProviderHttpError && (err.status === 400 || err.status === 401)) {
        this.update(account.slug, (a) => {
          a.status = 'reauth-needed';
          a.lastError = err.message;
        });
        this.tokens.delete(account.slug);
        throw new ReauthNeededError(account.slug, account.label, err.message);
      }
      throw err;
    }
    if (!tok.access_token) throw new Error('The provider returned no access token');
    if (tok.refresh_token && tok.refresh_token !== account.refreshToken) {
      const rotated = tok.refresh_token;
      this.update(account.slug, (a) => {
        a.refreshToken = rotated;
      });
    }
    this.tokens.set(account.slug, {
      token: tok.access_token,
      expiresAt: this.now() + (tok.expires_in ?? 3600) * 1000,
    });
    return tok.access_token;
  }

  /** Authorized calls for one account; a 401 refreshes the token once and retries. */
  private apiFor(slug: string): AccountApi {
    return async <T>(
      url: string,
      init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}
    ): Promise<T> => {
      const token = await this.accessToken(slug);
      try {
        return await requestJson<T>(this.fetchFn, url, { ...init, token });
      } catch (err) {
        if (!(err instanceof ProviderHttpError) || err.status !== 401) throw err;
        this.tokens.delete(slug);
        const fresh = await this.accessToken(slug);
        return requestJson<T>(this.fetchFn, url, { ...init, token: fresh });
      }
    };
  }

  // ─── Calendar and mail ───

  /**
   * The accounts a call covers: all of them for `undefined`, `''` or `'all'`,
   * otherwise the one whose slug, label or email matches.
   */
  resolveAccounts(account?: string): StoredAccount[] {
    const all = this.read().accounts;
    const key = account?.trim().toLowerCase();
    if (!key || key === 'all') return all;
    const hit = all.find(
      (a) => a.slug === key || a.label.toLowerCase() === key || a.email.toLowerCase() === key
    );
    if (!hit)
      throw new Error(
        `Unknown account: ${account}. Connected: ${all.map((a) => a.slug).join(', ') || 'none'}`
      );
    return [hit];
  }

  private resolveOne(account: string): StoredAccount {
    if (!account?.trim() || account.trim().toLowerCase() === 'all')
      throw new Error('Name one account');
    return this.resolveAccounts(account)[0];
  }

  private problem(a: StoredAccount, err: unknown): AccountProblem {
    return {
      account: a.slug,
      accountLabel: a.label,
      error: errorText(err),
      reauth: err instanceof ReauthNeededError,
    };
  }

  /** Every account in parallel; one failing becomes a problem, the rest still answer. */
  private async fanOut<T>(
    accounts: StoredAccount[],
    run: (a: StoredAccount, p: ProviderClient, api: AccountApi) => Promise<T[]>
  ): Promise<{ items: T[]; problems: AccountProblem[] }> {
    const results = await Promise.all(
      accounts.map(async (a) => {
        try {
          return { items: await run(a, PROVIDERS[a.provider], this.apiFor(a.slug)) };
        } catch (err) {
          return { problem: this.problem(a, err) };
        }
      })
    );
    return {
      items: results.flatMap((r) => r.items ?? []),
      problems: results.flatMap((r) => (r.problem ? [r.problem] : [])),
    };
  }

  private label<T>(a: StoredAccount, raw: T) {
    return { ...raw, account: a.slug, accountLabel: a.label, provider: a.provider };
  }

  async listEvents(
    from: Date,
    to: Date,
    account?: string
  ): Promise<{ events: CalendarEvent[]; problems: AccountProblem[] }> {
    const { items, problems } = await this.fanOut(
      this.resolveAccounts(account),
      async (a, p, api) => (await p.listEvents(api, from, to)).map((e) => this.label(a, e))
    );
    items.sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
    return { events: items, problems };
  }

  async createEvent(account: string, input: NewEventInput): Promise<CalendarEvent> {
    const a = this.resolveOne(account);
    return this.label(a, await PROVIDERS[a.provider].createEvent(this.apiFor(a.slug), input));
  }

  async searchMail(
    query: string,
    account: string | undefined,
    limit: number
  ): Promise<{ messages: MailSummary[]; problems: AccountProblem[] }> {
    const { items, problems } = await this.fanOut(
      this.resolveAccounts(account),
      async (a, p, api) => (await p.searchMail(api, query, limit)).map((m) => this.label(a, m))
    );
    items.sort((x, y) => Date.parse(y.date) - Date.parse(x.date));
    return { messages: items, problems };
  }

  async readMail(account: string, id: string): Promise<MailMessage> {
    const a = this.resolveOne(account);
    return this.label(a, await PROVIDERS[a.provider].readMail(this.apiFor(a.slug), id));
  }
}
