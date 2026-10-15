/**
 * Claude accounts (prototype). Each account is its own CLAUDE_CONFIG_DIR under
 * `<rootDir>/<slug>`; the login the app already had (`legacyDir`, normally
 * `/app/data/claude`) is the first one. One account is active for the whole
 * fleet: activating sets `CLAUDE_CONFIG_DIR` in the process environment,
 * which every Claude CLI spawn copies (`{ ...process.env }`), so the switch
 * needs no restart. `onActivate` lets the caller close the claude-cli circuit.
 *
 * Login without a terminal: `claude auth login` prints the sign-in URL and
 * reads the code from stdin, so the server drives it and the UI shows the link
 * and a box for the code. Registry: `<rootDir>/accounts.json`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface CliProcess {
  onOutput(fn: (text: string) => void): void;
  write(text: string): void;
  end(): void;
  exited: Promise<number>;
  kill(): void;
}

export type CliSpawn = (args: string[], env: Record<string, string | undefined>) => CliProcess;

export interface ClaudeAccount {
  slug: string;
  label: string;
  dir: string;
  addedAt: string;
}

export interface ClaudeAccountStatus extends ClaudeAccount {
  active: boolean;
  loggedIn: boolean;
  email?: string;
  error?: string;
  /** What was left of the plan windows at the last Test (absent until one ran). */
  limits?: AccountLimits;
}

export interface LimitWindow {
  /** Share used, 0-1. */
  utilization: number;
  resetsAt?: string;
}

/** The plan's windows as the CLI reported them on the last streamed call. */
export interface AccountLimits {
  checkedAt: string;
  /** `allowed`, `allowed_warning` or `rejected`. */
  status: string;
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
}

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
}

interface StreamResult {
  is_error?: boolean;
  result?: string;
  api_error_status?: number;
  total_cost_usd?: number;
  modelUsage?: Record<string, unknown>;
}

function toLimits(info: RateLimitInfo, now = new Date()): AccountLimits {
  const win = (k: string): LimitWindow | undefined => {
    const w = info.unifiedWindows?.[k];
    if (!w || typeof w.utilization !== 'number') return undefined;
    return {
      utilization: w.utilization,
      ...(typeof w.resetsAt === 'number'
        ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() }
        : {}),
    };
  };
  const fiveHour = win('five_hour');
  const sevenDay = win('seven_day');
  return {
    checkedAt: now.toISOString(),
    status: info.status ?? 'unknown',
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };
}

interface Registry {
  active: string;
  accounts: ClaudeAccount[];
}

interface PendingLogin {
  id: string;
  slug: string;
  label: string;
  dir: string;
  proc: CliProcess;
  output: string;
  timer: ReturnType<typeof setTimeout>;
  /** Logging in again to an account that exists: a failure or cancel never touches its folder. */
  existing: boolean;
  /** Its credentials before this login (an existing account is "logged in" either way). */
  credentialsBefore: string | null;
}

export interface AccountTestResult {
  ok: boolean;
  latencyMs: number;
  reply?: string;
  model?: string;
  costUsd?: number;
  /** Upstream HTTP status the CLI reported (429 = the account's limit). */
  status?: number;
  error?: string;
  limits?: AccountLimits;
}

export interface ClaudeAccountServiceOptions {
  rootDir: string;
  /** The config dir the app used before accounts existed; becomes account `default`. */
  legacyDir: string;
  claudePath: string;
  spawn?: CliSpawn;
  /** The environment the CLI spawns copy (default `process.env`). */
  env?: Record<string, string | undefined>;
  onActivate?: (slug: string) => void;
}

const LOGIN_URL = /https:\/\/\S*oauth\/authorize\S*/;
const LOGIN_TTL_MS = 10 * 60_000;
const URL_WAIT_MS = 20_000;
const STATUS_TIMEOUT_MS = 15_000;
const CODE_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 90_000;
const TEST_PROMPT = 'Reply with exactly: OK';

/** Bun.spawn with stdin/stdout piped; output listeners get stdout and stderr text. */
export const bunCliSpawn: CliSpawn = (args, env) => {
  const proc = Bun.spawn(args, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...env, TERM: 'dumb' },
  });
  const listeners: Array<(t: string) => void> = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk);
      for (const l of listeners) l(text);
    }
  };
  pump(proc.stdout).catch(() => {});
  pump(proc.stderr).catch(() => {});
  return {
    onOutput: (fn) => listeners.push(fn),
    write: (t) => {
      proc.stdin.write(t);
      proc.stdin.flush();
    },
    end: () => {
      proc.stdin.end();
    },
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'account'
  );
}

function readCredentials(dir: string): string | null {
  try {
    return readFileSync(join(dir, '.credentials.json'), 'utf8');
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

export class ClaudeAccountService {
  private readonly spawn: CliSpawn;
  private readonly env: Record<string, string | undefined>;
  private readonly registryPath: string;
  private readonly pending = new Map<string, PendingLogin>();

  constructor(private readonly opts: ClaudeAccountServiceOptions) {
    this.spawn = opts.spawn ?? bunCliSpawn;
    this.env = opts.env ?? process.env;
    this.registryPath = join(opts.rootDir, 'accounts.json');
  }

  private read(): Registry {
    try {
      const r = JSON.parse(readFileSync(this.registryPath, 'utf8')) as Registry;
      if (r && Array.isArray(r.accounts) && r.accounts.length > 0) return r;
    } catch {
      /* first use */
    }
    return {
      active: 'default',
      accounts: [
        {
          slug: 'default',
          label: 'Default',
          dir: resolve(this.opts.legacyDir),
          addedAt: new Date(0).toISOString(),
        },
      ],
    };
  }

  private write(r: Registry): void {
    mkdirSync(this.opts.rootDir, { recursive: true });
    const tmp = `${this.registryPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`);
    require('node:fs').renameSync(tmp, this.registryPath);
  }

  /** Point the CLI at the persisted active account (call once at boot). */
  applyActive(): void {
    const r = this.read();
    const a = r.accounts.find((x) => x.slug === r.active);
    if (a) this.env.CLAUDE_CONFIG_DIR = a.dir;
  }

  /** Set after construction: the fleet (and its circuit breaker) exists only later in boot. */
  setOnActivate(fn: (slug: string) => void): void {
    this.opts.onActivate = fn;
  }

  activeSlug(): string {
    return this.read().active;
  }

  private async status(
    dir: string
  ): Promise<{ loggedIn: boolean; email?: string; error?: string }> {
    try {
      const proc = this.spawn([this.opts.claudePath, 'auth', 'status'], {
        ...this.env,
        CLAUDE_CONFIG_DIR: dir,
      });
      let out = '';
      proc.onOutput((t) => {
        out += t;
      });
      const code = await withTimeout(proc.exited, STATUS_TIMEOUT_MS, -1);
      if (code === -1) proc.kill();
      const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
      const parsed = JSON.parse(json) as { loggedIn?: boolean; email?: string };
      return {
        loggedIn: parsed.loggedIn === true,
        ...(parsed.email ? { email: parsed.email } : {}),
      };
    } catch (err) {
      return { loggedIn: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async list(): Promise<ClaudeAccountStatus[]> {
    const r = this.read();
    const limits = this.readLimits();
    return Promise.all(
      r.accounts.map(async (a) => ({
        ...a,
        active: a.slug === r.active,
        ...(await this.status(a.dir)),
        ...(limits[a.slug] ? { limits: limits[a.slug] } : {}),
      }))
    );
  }

  /**
   * Start `claude auth login`; resolves with the sign-in URL. With `slug`, logs
   * in again to that account (expired session, or another login into it).
   */
  async startLogin(
    label: string,
    opts: { slug?: string } = {}
  ): Promise<{ loginId: string; slug: string; url: string }> {
    const r = this.read();
    const existing = opts.slug ? r.accounts.find((a) => a.slug === opts.slug) : undefined;
    if (opts.slug && !existing) throw new Error(`Unknown account: ${opts.slug}`);
    let slug = existing?.slug ?? slugify(label);
    if (!existing) {
      const base = slug;
      for (
        let i = 2;
        r.accounts.some((a) => a.slug === slug) ||
        [...this.pending.values()].some((p) => p.slug === slug);
        i++
      )
        slug = `${base}-${i}`;
    }
    const dir = existing?.dir ?? resolve(this.opts.rootDir, slug);
    mkdirSync(dir, { recursive: true });
    const proc = this.spawn([this.opts.claudePath, 'auth', 'login', '--claudeai'], {
      ...this.env,
      CLAUDE_CONFIG_DIR: dir,
    });
    const id = `login-${Math.random().toString(36).slice(2, 10)}`;
    const login: PendingLogin = {
      id,
      slug,
      label: existing?.label ?? (label.trim() || slug),
      dir,
      proc,
      existing: !!existing,
      credentialsBefore: readCredentials(dir),
      output: '',
      timer: setTimeout(() => this.cancel(id), LOGIN_TTL_MS),
    };
    this.pending.set(id, login);
    const url = await new Promise<string | null>((done) => {
      const t = setTimeout(() => done(null), URL_WAIT_MS);
      proc.onOutput((text) => {
        login.output += text;
        const m = LOGIN_URL.exec(login.output);
        if (m) {
          clearTimeout(t);
          done(m[0]);
        }
      });
      proc.exited.then(() => {
        clearTimeout(t);
        done(LOGIN_URL.exec(login.output)?.[0] ?? null);
      });
    });
    if (!url) {
      this.cancel(id);
      throw new Error(`Claude CLI did not print a sign-in URL: ${login.output.slice(-300)}`);
    }
    return { loginId: id, slug, url };
  }

  /** Hand the code from the sign-in page to the waiting login; adds the account when it worked. */
  async submitCode(
    loginId: string,
    code: string
  ): Promise<{ ok: boolean; slug?: string; email?: string; error?: string }> {
    const login = this.pending.get(loginId);
    if (!login)
      return { ok: false, error: 'No login in progress with that id (expired or finished)' };
    const before = login.output.length;
    login.proc.write(`${code.trim()}\n`);
    login.proc.end();
    const exit = await withTimeout(login.proc.exited, CODE_TIMEOUT_MS, -1);
    clearTimeout(login.timer);
    this.pending.delete(loginId);
    if (exit === -1) login.proc.kill();
    const st = await this.status(login.dir);
    const renewed = !login.existing || readCredentials(login.dir) !== login.credentialsBefore;
    if (!st.loggedIn || !renewed) {
      if (!login.existing) rmSync(login.dir, { recursive: true, force: true });
      const tail = login.output.slice(before).trim() || `claude auth login exited ${exit}`;
      return { ok: false, error: tail.slice(-400) };
    }
    if (login.existing)
      return { ok: true, slug: login.slug, ...(st.email ? { email: st.email } : {}) };
    const r = this.read();
    r.accounts.push({
      slug: login.slug,
      label: login.label,
      dir: login.dir,
      addedAt: new Date().toISOString(),
    });
    this.write(r);
    return { ok: true, slug: login.slug, ...(st.email ? { email: st.email } : {}) };
  }

  cancel(loginId: string): void {
    const login = this.pending.get(loginId);
    if (!login) return;
    clearTimeout(login.timer);
    this.pending.delete(loginId);
    try {
      login.proc.kill();
    } catch {
      /* already gone */
    }
    if (!login.existing) rmSync(login.dir, { recursive: true, force: true });
  }

  /** Change an account's display name (its slug and folder stay). */
  async rename(slug: string, label: string): Promise<void> {
    const name = label.trim();
    if (!name) throw new Error('A name is required');
    const r = this.read();
    const a = r.accounts.find((x) => x.slug === slug);
    if (!a) throw new Error(`Unknown account: ${slug}`);
    a.label = name.slice(0, 60);
    this.write(r);
  }

  /**
   * One real call with the account (`claude -p`, streamed), to see it answers:
   * latency, reply, cost, or why not — and what is left of its plan windows
   * (the stream's `rate_limit_event`), saved so the list shows it without a call.
   */
  async test(slug: string): Promise<AccountTestResult> {
    const a = this.read().accounts.find((x) => x.slug === slug);
    if (!a) throw new Error(`Unknown account: ${slug}`);
    const started = Date.now();
    const proc = this.spawn(
      [this.opts.claudePath, '-p', TEST_PROMPT, '--output-format', 'stream-json', '--verbose'],
      { ...this.env, CLAUDE_CONFIG_DIR: a.dir }
    );
    let out = '';
    proc.onOutput((t) => {
      out += t;
    });
    const exit = await withTimeout(proc.exited, TEST_TIMEOUT_MS, -1);
    const latencyMs = Date.now() - started;
    if (exit === -1) {
      proc.kill();
      return { ok: false, latencyMs, error: `No answer in ${TEST_TIMEOUT_MS / 1000} s` };
    }
    let result: StreamResult | null = null;
    let limits: AccountLimits | undefined;
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const o = JSON.parse(t) as StreamResult & {
          type?: string;
          rate_limit_info?: RateLimitInfo;
        };
        if (o.type === 'rate_limit_event' && o.rate_limit_info)
          limits = toLimits(o.rate_limit_info);
        else if (o.type === 'result' || 'is_error' in o || 'total_cost_usd' in o) result = o;
      } catch {
        /* not a JSON line */
      }
    }
    if (limits) this.saveLimits(slug, limits);
    if (!result)
      return { ok: false, latencyMs, error: (out.trim() || `claude exited ${exit}`).slice(-400) };
    const model = result.modelUsage ? Object.keys(result.modelUsage)[0] : undefined;
    const base = {
      latencyMs,
      ...(model ? { model } : {}),
      ...(typeof result.total_cost_usd === 'number' ? { costUsd: result.total_cost_usd } : {}),
      ...(typeof result.api_error_status === 'number' ? { status: result.api_error_status } : {}),
      ...(limits ? { limits } : {}),
    };
    if (result.is_error || exit !== 0)
      return { ok: false, ...base, error: result.result || `claude exited ${exit}` };
    return { ok: true, ...base, reply: (result.result ?? '').slice(0, 200) };
  }

  private readLimits(): Record<string, AccountLimits> {
    try {
      return JSON.parse(readFileSync(join(this.opts.rootDir, 'limits.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  private saveLimits(slug: string, limits: AccountLimits): void {
    try {
      mkdirSync(this.opts.rootDir, { recursive: true });
      const all = this.readLimits();
      all[slug] = limits;
      writeFileSync(join(this.opts.rootDir, 'limits.json'), `${JSON.stringify(all, null, 2)}\n`);
    } catch {
      /* the test result still carries them */
    }
  }

  /** Make an account the one every Claude CLI call uses. */
  async activate(slug: string): Promise<void> {
    const r = this.read();
    const a = r.accounts.find((x) => x.slug === slug);
    if (!a) throw new Error(`Unknown account: ${slug}`);
    const st = await this.status(a.dir);
    if (!st.loggedIn) throw new Error(`Account ${slug} is not logged in`);
    r.active = slug;
    this.write(r);
    this.env.CLAUDE_CONFIG_DIR = a.dir;
    this.opts.onActivate?.(slug);
  }

  /**
   * Forget an account and delete its credentials. Never the active one
   * (switch first). The original login keeps its folder (CLI transcripts the
   * usage backfill reads); only its `.credentials.json` goes.
   */
  async remove(slug: string): Promise<void> {
    const r = this.read();
    if (slug === r.active)
      throw new Error('The active account cannot be removed: switch to another first');
    const a = r.accounts.find((x) => x.slug === slug);
    if (!a) throw new Error(`Unknown account: ${slug}`);
    r.accounts = r.accounts.filter((x) => x.slug !== slug);
    this.write(r);
    if (resolve(a.dir) === resolve(this.opts.legacyDir)) {
      rmSync(join(a.dir, '.credentials.json'), { force: true });
    } else if (existsSync(a.dir) && resolve(a.dir).startsWith(resolve(this.opts.rootDir))) {
      rmSync(a.dir, { recursive: true, force: true });
    }
  }
}
