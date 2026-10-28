#!/usr/bin/env bun
/**
 * The mind reset (`docs/plans/mind-roster-plan.md`): turn every bot off and
 * archive the watcher's directory under `<data>/_trash/<stamp>-mind-reset`,
 * so the next start is a fresh birth that reads no bot's material.
 *
 *   bun scripts/watcher/reset-mind.ts [--apply] [--config <path>]
 *   bun scripts/watcher/reset-mind.ts --restore <archive dir> [--config <path>]
 *
 * Dry run by default: prints what would change and writes nothing. Run it with
 * the app container stopped, in a one-off container on the same volumes:
 *
 *   docker compose stop aibot
 *   docker compose run --rm --no-deps --entrypoint bun aibot scripts/watcher/reset-mind.ts --apply
 *   docker compose up -d
 *
 * `--apply` refuses when anything in the watcher dir changed in the last
 * minute (the process looks alive). Back up the volumes first
 * (`bun scripts/docker/backup.ts backup`). `--restore` puts the archived
 * watcher back and turns the same bots on again.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyMindReset, planMindReset, restoreMindReset } from '../../src/watcher/reset';
import { fail, parseArgs } from '../system-cli';

export interface ResetMindArgs {
  apply: boolean;
  restore?: string;
  configPath: string;
}

export function parseResetMindArgs(argv: string[]): ResetMindArgs {
  const args = parseArgs(argv);
  const restore = args.values.get('restore');
  return {
    apply: args.flags.has('apply'),
    ...(restore ? { restore } : {}),
    configPath: args.values.get('config') ?? './config/config.json',
  };
}

/**
 * `paths.data` from the raw config, resolved against the cwd. `${VAR}`
 * references are expanded the way `loadConfig` does; one to an unset
 * variable is refused, never resolved literally (that would turn the bots
 * off and archive no watcher).
 */
export function dataDirOf(configPath: string): string {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as { paths?: { data?: unknown } };
  const data = typeof raw.paths?.data === 'string' ? raw.paths.data : './data';
  const expanded = data.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const value = process.env[name];
    if (value === undefined || value === '')
      throw new Error(`paths.data references \${${name}}, but ${name} is not set`);
    return value;
  });
  return resolve(expanded);
}

function main(argv: string[]): void {
  const args = parseResetMindArgs(argv);
  const configDir = dirname(resolve(args.configPath));
  const dataDir = dataDirOf(args.configPath);
  const nowMs = Date.now();

  if (args.restore) {
    const r = restoreMindReset(resolve(args.restore), { dataDir, configDir, nowMs });
    console.log(`Restored the watcher from ${args.restore}.`);
    console.log(`Bots on again: ${r.reenabled.join(', ') || 'none'}`);
    if (r.missing.length) console.log(`No longer in bots.json: ${r.missing.join(', ')}`);
    if (r.displaced)
      console.log(`The watcher dir made after the reset was set aside at ${r.displaced}`);
    return;
  }

  const plan = planMindReset({ dataDir, configDir, nowMs });
  console.log(
    `Bots to turn off (${plan.enabledBots.length}): ${plan.enabledBots.join(', ') || 'none'}`
  );
  console.log(
    plan.watcherExists
      ? `Watcher dir ${plan.watcherDir} (${plan.watcherFiles} files) → ${plan.archiveDir}/watcher`
      : `No watcher dir at ${plan.watcherDir}: nothing to archive`
  );
  if (!args.apply) {
    console.log('\nDry run: nothing written. Add --apply with the app container stopped.');
    return;
  }
  const r = applyMindReset(plan, { nowMs });
  console.log(`\nDone. ${r.disabled.length} bots off; archive at ${r.archiveDir}.`);
  console.log(`Undo: bun scripts/watcher/reset-mind.ts --restore ${r.archiveDir}`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
