/**
 * Startup preflight for the Claude CLI backend.
 *
 * `resolveCandidatesFromConfig` puts `claude-cli` in the failover chain by
 * default, so a container without the binary — or with the binary but no
 * login — ships a backend that fails on first use. Worse, an unauthenticated
 * CLI does not fail loudly: `claude -p ... --output-format json` exits 0 with
 * `"result": "Not logged in · Please run /login"`, which `claudeGenerate`
 * happily returns as if it were the model's answer. Measured against the
 * pinned CLI (2.1.237).
 *
 * This module makes that state visible at boot instead of in a user's chat.
 * Every dependency is injectable so the tests stay hermetic — the same shape
 * as `resolveClaudeBin`'s `WhichFn` in src/claude-cli.ts.
 *
 * Target: src/bot/claude-cli-preflight.ts
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { type WhichFn, resolveClaudeBin } from '../claude-cli';

/** Credential state. `unknown` means "not determinable", never "absent". */
export type CredentialState = 'present' | 'missing' | 'unknown';

export interface ClaudeCliPreflight {
  /** The binary is on PATH and answered `--version`. */
  available: boolean;
  /** Parsed from `claude --version`; undefined if the output was unrecognised. */
  version?: string;
  /** Directory the CLI reads credentials and settings from. */
  configDir: string;
  credentials: CredentialState;
  /** Why the CLI is unusable. Only set when `available` is false. */
  reason?: string;
}

/** Runs a command and returns its exit code + stdout. Injectable for tests. */
export type RunFn = (argv: string[]) => Promise<{ exitCode: number; stdout: string }>;

export interface CheckClaudeCliOptions {
  claudePath: string;
  which?: WhichFn;
  run?: RunFn;
  /** Defaults to $CLAUDE_CONFIG_DIR, then ~/.claude — the CLI's own resolution order. */
  configDir?: string;
  exists?: (path: string) => Promise<boolean>;
}

/** The file a logged-in CLI writes its OAuth credentials to. Verified on 2.1.237. */
const CREDENTIALS_FILE = '.credentials.json';

/** Bounded so a hung binary cannot stall boot. */
const PROBE_TIMEOUT_MS = 10_000;

const VERSION_PATTERN = /(\d+\.\d+\.\d+)/;

/** Default probe: spawn the binary, capture stdout, kill it if it hangs. */
const defaultRun: RunFn = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, PROBE_TIMEOUT_MS);
  try {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout };
  } finally {
    clearTimeout(timer);
  }
};

const defaultExists = async (path: string): Promise<boolean> => Bun.file(path).exists();

/**
 * Resolve the directory the CLI reads credentials from, mirroring its own order:
 * an explicit `CLAUDE_CONFIG_DIR` wins, otherwise `~/.claude`.
 */
export function resolveConfigDir(explicit?: string): string {
  return explicit ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

/**
 * Probe the Claude CLI: is it installed, which version, and does it hold a login?
 *
 * Never throws — a preflight that breaks boot is worse than the problem it reports.
 */
export async function checkClaudeCli(opts: CheckClaudeCliOptions): Promise<ClaudeCliPreflight> {
  const which = opts.which ?? ((cmd: string) => Bun.which(cmd));
  const run = opts.run ?? defaultRun;
  const exists = opts.exists ?? defaultExists;
  const configDir = resolveConfigDir(opts.configDir);

  const bin = resolveClaudeBin(opts.claudePath, which);

  if (!which(bin)) {
    return {
      available: false,
      configDir,
      credentials: 'unknown',
      reason: `"${opts.claudePath}" not found on PATH`,
    };
  }

  let version: string | undefined;
  try {
    const { exitCode, stdout } = await run([bin, '--version']);
    if (exitCode !== 0) {
      return {
        available: false,
        configDir,
        credentials: 'unknown',
        reason: `"${opts.claudePath} --version" exited with code ${exitCode}`,
      };
    }
    version = VERSION_PATTERN.exec(stdout)?.[1];
  } catch (err) {
    return {
      available: false,
      configDir,
      credentials: 'unknown',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    available: true,
    version,
    configDir,
    credentials: await probeCredentials(configDir, exists),
  };
}

/**
 * macOS stores the login in the Keychain rather than in a file, so an absent
 * credentials file there proves nothing. Report `unknown` instead of crying wolf.
 */
async function probeCredentials(
  configDir: string,
  exists: (path: string) => Promise<boolean>
): Promise<CredentialState> {
  try {
    if (await exists(join(configDir, CREDENTIALS_FILE))) return 'present';
  } catch {
    return 'unknown';
  }
  return process.platform === 'darwin' ? 'unknown' : 'missing';
}

/** One-line human summary for the boot log. */
export function formatPreflight(result: ClaudeCliPreflight): string {
  if (!result.available) {
    return `Claude CLI unavailable: ${result.reason ?? 'unknown reason'}`;
  }
  const version = result.version ? `v${result.version}` : 'unknown version';
  if (result.credentials === 'missing') {
    return `Claude CLI ${version} installed but not logged in — run "claude auth login" (config dir: ${result.configDir})`;
  }
  return `Claude CLI ${version} ready (config dir: ${result.configDir})`;
}
