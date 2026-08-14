#!/usr/bin/env bun
/**
 * Whole-system export from the command line.
 *
 *   bun run export:system -- --out ../aibot-backup.tar.gz
 *   bun run export:system -- --out /backups/agents.tar.gz --sections agents
 *   bun run export:system -- --out ./b.tar.gz --agents coach,soporte --productions
 *
 * Writes a `.tar.gz` containing a sanitized configuration, the bot roster, one
 * nested per-agent bundle per bot, and the selected data directories. No secret
 * value is ever written: credentials become `${VAR}` placeholders listed in
 * REQUIRED_ENV.txt inside the bundle.
 *
 * This is the disaster-recovery path — it never starts the bot framework and
 * never loads the config through Zod, so it still works when the app does not.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { SystemExportService } from '../src/system/system-export-service';
import { parseSections } from '../src/system/types';
import { cliConfig, fail, formatBytes, parseArgs, resolveCliContext } from './system-cli';

const USAGE = `
Usage: bun run export:system -- --out <file.tar.gz> [options]

Options:
  --out <file>        Destination archive (required)
  --sections <list>   config,agents,data,tenants or "all"   (default: all)
  --agents <ids>      Comma-separated bot ids to include    (default: all bots)
  --productions       Include each agent's productions directory
  --conversations     Include each agent's conversation logs
  --karma             Include each agent's karma data
  --config <path>     Path to config.json  (default: <root>/config/config.json)
  --root <dir>        Instance root        (default: current directory)
  --force             Overwrite --out if it already exists
  --json              Print the manifest summary as JSON
  --verbose           Verbose logging on stderr
  --help              Show this message
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help') || args.values.has('help')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const out = args.values.get('out');
  if (!out) fail(`--out is required.\n${USAGE}`);

  const context = resolveCliContext(args);
  const outPath = isAbsolute(out) ? out : resolve(process.cwd(), out);

  if (existsSync(outPath) && !args.flags.has('force')) {
    fail(`${outPath} already exists. Pass --force to overwrite.`);
  }
  if (!existsSync(context.configPath)) {
    fail(`Config not found at ${context.configPath}. Pass --config <path>.`);
  }

  let sections: ReturnType<typeof parseSections>;
  try {
    sections = parseSections(args.values.get('sections'));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const service = new SystemExportService({
    config: cliConfig(context),
    configPath: context.configPath,
    logger: context.logger,
    rootDir: context.rootDir,
  });

  const { buffer, manifest } = await service.export({
    sections,
    agentIds: args.values
      .get('agents')
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    productions: args.flags.has('productions'),
    conversations: args.flags.has('conversations'),
    karma: args.flags.has('karma'),
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer);

  if (args.flags.has('json')) {
    process.stdout.write(`${JSON.stringify({ out: outPath, manifest }, null, 2)}\n`);
    return;
  }

  const lines = [
    '',
    `System export written to ${outPath}`,
    `  size          ${formatBytes(buffer.length)} (${manifest.inventory.files} files)`,
    `  sections      ${manifest.sections.join(', ')}`,
    `  agents        ${
      manifest.inventory.agents.length > 0
        ? manifest.inventory.agents.map((agent) => agent.id).join(', ')
        : '(none)'
    }`,
    `  framework     ${manifest.frameworkVersion}`,
    '',
    `  ${manifest.security.redacted.length} secret value(s) replaced with \${VAR} placeholders`,
    `  ${manifest.security.requiredEnv.length} environment variable(s) needed on the target — see REQUIRED_ENV.txt in the bundle`,
  ];

  if (manifest.security.scrubbedFiles.length > 0) {
    lines.push(
      '',
      `  WARNING: credential-shaped strings were found and redacted inside ${manifest.security.scrubbedFiles.length} bundled file(s):`,
      ...manifest.security.scrubbedFiles.map((path) => `    ${path}`),
      '  Those credentials are live on the source instance — rotate them.'
    );
  }

  lines.push(
    '',
    '  This bundle contains every soul, session transcript and setting for this',
    '  instance. Treat it as sensitive even though it holds no credentials.',
    ''
  );

  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
