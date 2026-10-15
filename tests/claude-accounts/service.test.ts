/**
 * Claude accounts (prototype): several Claude logins, each in its own
 * CLAUDE_CONFIG_DIR, one active for the whole fleet. Log in from the UI
 * (the server drives `claude auth login`: it prints the sign-in URL and reads
 * the code from stdin) and switch with one click. Live, 2026-10-15, the only
 * account hit its weekly limit and the fleet stopped until it reset.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAccountService, type CliSpawn } from '../../src/claude-accounts/service';

const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc';

/**
 * A fake `claude` CLI: `auth status` reports logged in when the config dir has
 * a `.credentials.json`; `auth login` prints the URL and, on the code "good",
 * writes the credentials and exits 0.
 */
function fakeCli(): { spawn: CliSpawn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: CliSpawn = (args, env) => {
    calls.push(args);
    const dir = env.CLAUDE_CONFIG_DIR as string;
    const listeners: Array<(t: string) => void> = [];
    let resolveExit: (n: number) => void = () => {};
    const exited = new Promise<number>((r) => {
      resolveExit = r;
    });
    let input = '';
    if (args[2] === 'status') {
      const logged = existsSync(join(dir, '.credentials.json'));
      const email = logged ? readFileSync(join(dir, '.credentials.json'), 'utf8') : undefined;
      setTimeout(() => {
        for (const l of listeners)
          l(JSON.stringify({ loggedIn: logged, ...(email ? { email } : {}) }));
        resolveExit(0);
      }, 1);
    } else {
      setTimeout(() => {
        for (const l of listeners)
          l(
            `Opening browser to sign in…\nIf the browser didn't open, visit: ${URL}\nPaste code here if prompted > `
          );
      }, 1);
    }
    return {
      onOutput: (fn) => listeners.push(fn),
      write: (t) => {
        input += t;
      },
      end: () => {
        if (input.trim() === 'good') {
          writeFileSync(join(dir, '.credentials.json'), 'second@example.com');
          resolveExit(0);
        } else {
          for (const l of listeners) l('OAuth error: invalid code');
          resolveExit(1);
        }
      },
      exited,
      kill: () => resolveExit(143),
    };
  };
  return { spawn, calls };
}

let root: string;
let legacy: string;
let env: Record<string, string | undefined>;
let activated: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-accounts-'));
  legacy = join(root, 'claude');
  writeFileSync(join(root, 'marker'), '');
  require('node:fs').mkdirSync(legacy);
  writeFileSync(join(legacy, '.credentials.json'), 'first@example.com');
  env = { CLAUDE_CONFIG_DIR: legacy };
  activated = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const service = (cli = fakeCli()) =>
  new ClaudeAccountService({
    rootDir: join(root, 'claude-accounts'),
    legacyDir: legacy,
    claudePath: 'claude',
    spawn: cli.spawn,
    env,
    onActivate: (slug) => activated.push(slug),
  });

describe('ClaudeAccountService', () => {
  test('the login the app already has is the first account, active', async () => {
    const accounts = await service().list();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      slug: 'default',
      dir: legacy,
      active: true,
      loggedIn: true,
      email: 'first@example.com',
    });
  });

  test('a login from the UI: the URL, then the code adds a logged-in account', async () => {
    const s = service();
    const started = await s.startLogin('Second account');
    expect(started.url).toBe(URL);
    expect(started.slug).toBe('second-account');
    const done = await s.submitCode(started.loginId, 'good');
    expect(done).toMatchObject({ ok: true, email: 'second@example.com' });
    const accounts = await s.list();
    expect(accounts.map((a) => [a.slug, a.loggedIn, a.active])).toEqual([
      ['default', true, true],
      ['second-account', true, false],
    ]);
  });

  test('a wrong code adds nothing and says why', async () => {
    const s = service();
    const started = await s.startLogin('Second');
    const done = await s.submitCode(started.loginId, 'bad');
    expect(done.ok).toBe(false);
    expect(done.error).toContain('invalid code');
    expect((await s.list()).map((a) => a.slug)).toEqual(['default']);
  });

  test('an unknown or finished login id is refused', async () => {
    const s = service();
    expect((await s.submitCode('nope', 'good')).ok).toBe(false);
  });

  test('activating an account points the CLI at it, persists, and tells the fleet', async () => {
    const s = service();
    const { loginId } = await s.startLogin('Second');
    await s.submitCode(loginId, 'good');
    await s.activate('second');
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(root, 'claude-accounts', 'second'));
    expect(activated).toEqual(['second']);
    // a new service (a restart) applies the persisted choice
    env.CLAUDE_CONFIG_DIR = legacy;
    service().applyActive();
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(root, 'claude-accounts', 'second'));
  });

  test('an account that is not logged in cannot be activated; unknown ones neither', async () => {
    const s = service();
    await expect(s.activate('nope')).rejects.toThrow('Unknown account');
    rmSync(join(legacy, '.credentials.json'));
    await expect(s.activate('default')).rejects.toThrow('not logged in');
  });

  // Deliberately changed: the original login can be removed too once another
  // account is active (CRUD from the dashboard); only its credentials go, the
  // folder keeps the CLI transcripts the usage backfill reads.
  test('remove: never the active one; others go with their folder, the original keeps its folder', async () => {
    const s = service();
    const { loginId } = await s.startLogin('Second');
    await s.submitCode(loginId, 'good');
    await expect(s.remove('default')).rejects.toThrow('active');
    await s.remove('second');
    expect((await s.list()).map((a) => a.slug)).toEqual(['default']);
    expect(existsSync(join(root, 'claude-accounts', 'second'))).toBe(false);

    const again = await s.startLogin('Third');
    await s.submitCode(again.loginId, 'good');
    await s.activate('third');
    await s.remove('default');
    expect((await s.list()).map((a) => a.slug)).toEqual(['third']);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(legacy, '.credentials.json'))).toBe(false);
  });

  test('rename changes the label only', async () => {
    const s = service();
    await s.rename('default', 'Diego work');
    const [a] = await s.list();
    expect(a).toMatchObject({ slug: 'default', label: 'Diego work' });
    await expect(s.rename('nope', 'x')).rejects.toThrow('Unknown account');
    await expect(s.rename('default', '  ')).rejects.toThrow('name');
  });

  test('log in again to an existing account keeps its slug; a failed retry keeps the old login', async () => {
    const s = service();
    const bad = await s.startLogin('', { slug: 'default' });
    expect(bad.slug).toBe('default');
    expect((await s.submitCode(bad.loginId, 'bad')).ok).toBe(false);
    expect(existsSync(join(legacy, '.credentials.json'))).toBe(true);
    const cancelled = await s.startLogin('', { slug: 'default' });
    s.cancel(cancelled.loginId);
    expect(existsSync(join(legacy, '.credentials.json'))).toBe(true);
    const good = await s.startLogin('', { slug: 'default' });
    expect((await s.submitCode(good.loginId, 'good')).ok).toBe(true);
    expect((await s.list()).map((a) => a.slug)).toEqual(['default']);
    await expect(s.startLogin('', { slug: 'nope' })).rejects.toThrow('Unknown account');
  });
});

describe('ClaudeAccountService.test (a real call with the account)', () => {
  const cliAnswer =
    (stdout: string, exit = 0): CliSpawn =>
    (args, env) => {
      const listeners: Array<(t: string) => void> = [];
      let done: (n: number) => void = () => {};
      const exited = new Promise<number>((r) => {
        done = r;
      });
      setTimeout(() => {
        if (args[1] === 'auth') {
          for (const l of listeners) l(JSON.stringify({ loggedIn: true }));
        } else {
          expect(env.CLAUDE_CONFIG_DIR).toBe(legacy);
          for (const l of listeners) l(stdout);
        }
        done(args[1] === 'auth' ? 0 : exit);
      }, 1);
      return {
        onOutput: (fn) => listeners.push(fn),
        write() {},
        end() {},
        exited,
        kill: () => done(143),
      };
    };
  const svc = (spawn: CliSpawn) =>
    new ClaudeAccountService({
      rootDir: join(root, 'claude-accounts'),
      legacyDir: legacy,
      claudePath: 'claude',
      spawn,
      env,
    });

  test('a working account answers, with model and cost', async () => {
    const out = JSON.stringify({
      is_error: false,
      result: 'OK',
      total_cost_usd: 0.0123,
      modelUsage: { 'claude-opus-5-5': {} },
    });
    const r = await svc(cliAnswer(out)).test('default');
    expect(r).toMatchObject({ ok: true, reply: 'OK', costUsd: 0.0123 });
    expect(typeof r.latencyMs).toBe('number');
  });

  test('an account at its limit says so, with the status and the provider text', async () => {
    const out = JSON.stringify({
      is_error: true,
      api_error_status: 429,
      result: "You've hit your weekly limit · resets 3pm (America/Argentina/Buenos_Aires)",
    });
    const r = await svc(cliAnswer(out, 1)).test('default');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.error).toContain('weekly limit');
  });

  test('unparseable output is a failure with the raw tail', async () => {
    const r = await svc(cliAnswer('segfault', 139)).test('default');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('segfault');
  });
});
