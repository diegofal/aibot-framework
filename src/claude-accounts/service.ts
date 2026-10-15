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
    return Promise.all(
      r.accounts.map(async (a) => ({
        ...a,
        active: a.slug === r.active,
        ...(await this.status(a.dir)),
      }))
    );
  }

  /** Start `claude auth login` for a new account; resolves with the sign-in URL. */
  async startLogin(label: string): Promise<{ loginId: string; slug: string; url: string }> {
    const r = this.read();
    const base = slugify(label);
    let slug = base;
    for (
      let i = 2;
      r.accounts.some((a) => a.slug === slug) ||
      [...this.pending.values()].some((p) => p.slug === slug);
      i++
    )
      slug = `${base}-${i}`;
    const dir = resolve(this.opts.rootDir, slug);
    mkdirSync(dir, { recursive: true });
    const proc = this.spawn([this.opts.claudePath, 'auth', 'login', '--claudeai'], {
      ...this.env,
      CLAUDE_CONFIG_DIR: dir,
    });
    const id = `login-${Math.random().toString(36).slice(2, 10)}`;
    const login: PendingLogin = {
      id,
      slug,
      label: label.trim() || slug,
      dir,
      proc,
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
    if (!st.loggedIn) {
      rmSync(login.dir, { recursive: true, force: true });
      const tail = login.output.slice(before).trim() || `claude auth login exited ${exit}`;
      return { ok: false, error: tail.slice(-400) };
    }
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
    rmSync(login.dir, { recursive: true, force: true });
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

  /** Forget an account and delete its credentials. Never the active one or the original login. */
  async remove(slug: string): Promise<void> {
    const r = this.read();
    if (slug === r.active) throw new Error('The active account cannot be removed');
    const a = r.accounts.find((x) => x.slug === slug);
    if (!a) throw new Error(`Unknown account: ${slug}`);
    if (resolve(a.dir) === resolve(this.opts.legacyDir))
      throw new Error('The original login cannot be removed');
    r.accounts = r.accounts.filter((x) => x.slug !== slug);
    this.write(r);
    if (existsSync(a.dir) && resolve(a.dir).startsWith(resolve(this.opts.rootDir)))
      rmSync(a.dir, { recursive: true, force: true });
  }
}
