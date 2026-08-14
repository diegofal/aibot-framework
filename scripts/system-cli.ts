/**
 * Shared plumbing for the system export/import CLIs.
 *
 * The CLI exists because the most likely moment you need a backup is the
 * moment the dashboard will not start. It therefore avoids `loadConfig()`
 * entirely — a config that fails Zod validation (or a machine where the
 * `${VAR}`s are not set yet) must still be exportable.
 */

import type { Logger } from '../src/logger';
import { buildEffectiveConfig, readRawBots, readRawConfig } from '../src/system/effective-config';

export interface CliArgs {
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

/** Minimal `--flag` / `--key value` / `--key=value` parser. */
export function parseArgs(argv: string[]): CliArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      values.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(body, next);
      i++;
    } else {
      flags.add(body);
    }
  }

  return { flags, values, positional };
}

/** Pino-shaped logger that writes to stderr, keeping stdout clean for `--json`. */
export function createCliLogger(verbose: boolean): Logger {
  const write = (level: string) => (objOrMsg: unknown, maybeMsg?: string) => {
    if (!verbose && level === 'debug') return;
    const message = typeof objOrMsg === 'string' ? objOrMsg : (maybeMsg ?? '');
    const context =
      typeof objOrMsg === 'object' && objOrMsg !== null ? ` ${JSON.stringify(objOrMsg)}` : '';
    process.stderr.write(`[${level}] ${message}${verbose ? context : ''}\n`);
  };
  const logger = {
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    debug: write('debug'),
    trace: write('debug'),
    fatal: write('error'),
    child: () => logger,
  };
  return logger as unknown as Logger;
}

export interface CliContext {
  rootDir: string;
  configPath: string;
  rawConfig: Record<string, unknown>;
  logger: Logger;
}

export function resolveCliContext(args: CliArgs): CliContext {
  const rootDir = args.values.get('root') ?? process.cwd();
  const configPath =
    args.values.get('config') ?? process.env.AIBOT_CONFIG_PATH ?? `${rootDir}/config/config.json`;

  return {
    rootDir,
    configPath,
    rawConfig: readRawConfig(configPath),
    logger: createCliLogger(args.flags.has('verbose')),
  };
}

/** Config slice for locating files, built from raw JSON — never Zod-validated. */
export function cliConfig(context: CliContext) {
  return buildEffectiveConfig(context.rawConfig, readRawBots(context.configPath), context.rootDir);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fail(message: string): never {
  process.stderr.write(`\nError: ${message}\n`);
  process.exit(1);
}
