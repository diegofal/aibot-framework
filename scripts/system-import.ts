#!/usr/bin/env bun
/**
 * Whole-system import from the command line.
 *
 *   bun run import:system -- --in ../aibot-backup.tar.gz --dry-run
 *   bun run import:system -- --in ../aibot-backup.tar.gz --yes
 *   bun run import:system -- --in ./b.tar.gz --sections agents --overwrite --yes
 *
 * Non-destructive by default:
 *   - refuses if anything on the target would be replaced, unless --overwrite;
 *   - refuses to write at all unless --yes (run without it to see the plan);
 *   - refuses if the instance appears to be running;
 *   - every restored bot lands with enabled=false and an empty token.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ConflictError } from '../src/bot/bot-export-service';
import { pickPath } from '../src/system/effective-config';
import { SystemImportService } from '../src/system/system-import-service';
import { parseSections } from '../src/system/types';
import { fail, formatBytes, parseArgs, resolveCliContext } from './system-cli';

const USAGE = `
Usage: bun run import:system -- --in <file.tar.gz> [options]

Options:
  --in <file>         Bundle to restore (required)
  --sections <list>   config,agents,data,tenants or "all"   (default: whatever the bundle has)
  --agents <ids>      Comma-separated bot ids to restore    (default: all in the bundle)
  --overwrite         Replace items that already exist on this instance
  --dry-run           Show the plan and exit without writing
  --yes               Actually write (without it, the import stops after the plan)
  --config <path>     Path to config.json  (default: <root>/config/config.json)
  --root <dir>        Instance root        (default: current directory)
  --force             Skip the "instance appears to be running" check
  --json              Print the result as JSON
  --verbose           Verbose logging on stderr
  --help              Show this message
`;

/**
 * A responding web server means the framework is up, and importing underneath
 * a live process would have it writing stale state back over the restore.
 */
async function instanceLooksRunning(rawConfig: unknown): Promise<string | null> {
  const port = pickPath(rawConfig, ['web', 'port']);
  const host = pickPath(rawConfig, ['web', 'host']);
  if (typeof port !== 'number') return null;

  const target = `http://${typeof host === 'string' && host !== '0.0.0.0' ? host : '127.0.0.1'}:${port}/api/status`;
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(800) });
    return response.ok ? target : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help') || args.values.has('help')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const input = args.values.get('in');
  if (!input) fail(`--in is required.\n${USAGE}`);

  const inPath = isAbsolute(input) ? input : resolve(process.cwd(), input);
  if (!existsSync(inPath)) fail(`Bundle not found: ${inPath}`);

  const context = resolveCliContext(args);
  const buffer = readFileSync(inPath);

  if (!args.flags.has('force')) {
    const running = await instanceLooksRunning(context.rawConfig);
    if (running) {
      fail(
        `An AIBot instance appears to be running (${running} responded). Stop it before importing, or pass --force if you are certain.`
      );
    }
  }

  const dryRun = args.flags.has('dry-run') || !args.flags.has('yes');

  const service = new SystemImportService({
    targetRoot: context.rootDir,
    configPath: context.configPath,
    logger: context.logger,
  });

  let result: Awaited<ReturnType<SystemImportService['import']>>;
  try {
    result = await service.import(buffer, {
      sections: args.values.has('sections')
        ? parseSections(args.values.get('sections'))
        : undefined,
      agentIds: args.values
        .get('agents')
        ?.split(',')
        .map((id) => id.trim())
        .filter(Boolean),
      overwrite: args.flags.has('overwrite'),
      dryRun,
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      fail(`${err.message}\n\nRe-run with --overwrite to replace them.`);
    }
    throw err;
  }

  if (args.flags.has('json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const { manifest } = result;
  const lines = [
    '',
    dryRun ? 'PLAN (nothing was written)' : 'System import complete',
    `  bundle        ${inPath} (${formatBytes(buffer.length)})`,
    `  exported at   ${manifest.exportedAt} from ${manifest.source.hostname} (${manifest.source.platform})`,
    `  framework     ${manifest.frameworkVersion}`,
    `  sections      ${result.sections.join(', ')}`,
    `  agents        ${
      manifest.inventory.agents.length > 0
        ? manifest.inventory.agents.map((agent) => agent.id).join(', ')
        : '(none)'
    }`,
  ];

  if (!dryRun) {
    lines.push(`  restored      ${result.agents.length} agent(s), ${result.filesWritten} file(s)`);
  }
  if (result.collisions.length > 0) {
    lines.push(
      '',
      `  ${result.collisions.length} existing item(s) ${dryRun ? 'would be' : 'were'} replaced:`,
      ...result.collisions.slice(0, 20).map((item) => `    ${item}`),
      ...(result.collisions.length > 20
        ? [`    ... and ${result.collisions.length - 20} more`]
        : [])
    );
  }
  if (result.missingEnv.length > 0) {
    lines.push(
      '',
      `  ${result.missingEnv.length} required environment variable(s) are not set here:`,
      ...result.missingEnv.map((name) => `    ${name}`),
      '  See REQUIRED_ENV.txt inside the bundle for what each one is for.'
    );
  }
  for (const warning of result.warnings) lines.push(`  ! ${warning}`);

  if (dryRun) {
    lines.push('', '  Re-run with --yes to apply.', '');
  } else {
    lines.push(
      '',
      '  Every restored agent is disabled with an empty Telegram token. Paste each',
      '  token and enable the agent only once the source instance has stopped',
      '  polling it, otherwise Telegram returns 409 and both instances stall.',
      ''
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
