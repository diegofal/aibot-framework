#!/usr/bin/env bun
/**
 * Backup and restore for the Docker named volumes.
 *
 * All persistent state lives in Docker named volumes, which on Windows means
 * inside the WSL2 VM's virtual disk. Losing that disk — a Docker Desktop
 * factory reset, a corrupted ext4 image, an uninstall — loses every agent's
 * soul and memory with no recourse. This pulls it out onto a normal Windows
 * directory that ordinary file backups can see.
 *
 *   bun scripts/docker/backup.ts backup
 *   bun scripts/docker/backup.ts list
 *   bun scripts/docker/backup.ts restore <backup-dir> --prefix aibot-restoretest_
 *   bun scripts/docker/backup.ts restore <backup-dir> --force      # into the live volumes
 *
 * What is captured, and what is deliberately not:
 *   aibot_config       full — soul/, config.json, bots.json. Irreplaceable.
 *   aibot_data         full — sessions, memory, karma, cron, logs.
 *   aibot_productions  full — agent-authored artefacts.
 *   ollama_data        keypair only. The 262 MB of model blobs re-pull in
 *                      minutes with `ollama pull`; the ed25519 keypair is the
 *                      Ollama Cloud identity and cannot be regenerated, only
 *                      re-registered. Backing up blobs every night to save a
 *                      re-pull is a bad trade.
 *
 * Written in TypeScript rather than shell on purpose: Bun.spawn passes argv
 * straight through, sidestepping the MSYS path mangling that rewrites
 * container-absolute paths like /v into C:/Program Files/Git/v under Git Bash.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECT = process.env.AIBOT_COMPOSE_PROJECT ?? 'aibot-framework';
const HELPER_IMAGE = 'alpine:latest';

/** Volumes to capture, and the tar path filter applied to each. */
const VOLUMES: Array<{ name: string; include: string[]; note: string }> = [
  { name: 'aibot_config', include: ['.'], note: 'soul, config.json, bots.json' },
  { name: 'aibot_data', include: ['.'], note: 'sessions, memory, karma, cron, logs' },
  { name: 'aibot_productions', include: ['.'], note: 'agent-authored artefacts' },
  {
    name: 'ollama_data',
    include: ['id_ed25519', 'id_ed25519.pub'],
    note: 'Ollama Cloud identity only — model blobs are re-pullable',
  },
];

const DEFAULT_OUT = resolve(process.cwd(), '..', 'aibot-backups');

/**
 * Bun is a native Windows binary, so it reads Git Bash's MSYS paths (/d/foo)
 * as drive-relative and resolves them to D:\d\foo. Tab-completing a path in
 * Git Bash is the normal way to invoke this, so translate rather than fail.
 */
function normalizePath(p: string): string {
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  return resolve(msys ? `${msys[1].toUpperCase()}:/${msys[2]}` : p);
}

function sh(cmd: string[], opts: { quiet?: boolean } = {}): string {
  const res = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  if (res.exitCode !== 0) {
    const err = res.stderr.toString().trim();
    if (!opts.quiet) console.error(`  ! ${cmd.join(' ')}\n    ${err}`);
    throw new Error(err || `exit ${res.exitCode}`);
  }
  return res.stdout.toString();
}

function volumeExists(name: string): boolean {
  try {
    sh(['docker', 'volume', 'inspect', name], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function composeRunning(): boolean {
  try {
    return sh(['docker', 'ps', '--filter', `name=${PROJECT}-aibot-1`, '--format', '{{.Names}}'], {
      quiet: true,
    }).trim().length > 0;
  } catch {
    return false;
  }
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// --- backup ----------------------------------------------------------------

function backup(outRoot: string, opts: { stop: boolean }): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = join(outRoot, `aibot-backup-${stamp}`);
  mkdirSync(dest, { recursive: true });

  // The bot writes sessions and memory continuously. Pausing it for the couple
  // of seconds this takes turns a fuzzy snapshot into a consistent one.
  const wasRunning = opts.stop && composeRunning();
  if (wasRunning) {
    console.log('Pausing aibot for a consistent snapshot...');
    sh(['docker', 'stop', `${PROJECT}-aibot-1`]);
  }

  const manifest: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    project: PROJECT,
    volumes: {} as Record<string, unknown>,
  };

  try {
    for (const vol of VOLUMES) {
      const full = `${PROJECT}_${vol.name}`;
      if (!volumeExists(full)) {
        console.log(`  skip ${vol.name} (volume not found)`);
        continue;
      }
      const tarName = `${vol.name}.tar.gz`;
      // Stream the tar to the helper's stdout and capture it host-side, so no
      // bind mount of a Windows path is needed.
      const proc = Bun.spawnSync(
        [
          'docker', 'run', '--rm',
          '-v', `${full}:/v:ro`,
          HELPER_IMAGE,
          'tar', 'czf', '-', '-C', '/v', ...vol.include,
        ],
        { stdout: 'pipe', stderr: 'pipe', maxBuffer: 1024 * 1024 * 1024 }
      );
      if (proc.exitCode !== 0) {
        throw new Error(`tar of ${full} failed: ${proc.stderr.toString().trim()}`);
      }
      const outFile = join(dest, tarName);
      writeFileSync(outFile, proc.stdout);
      const size = statSync(outFile).size;
      (manifest.volumes as Record<string, unknown>)[vol.name] = {
        archive: tarName,
        bytes: size,
        include: vol.include,
        note: vol.note,
      };
      console.log(`  ok   ${vol.name.padEnd(18)} ${human(size).padStart(9)}  (${vol.note})`);
    }
  } finally {
    if (wasRunning) {
      sh(['docker', 'start', `${PROJECT}-aibot-1`]);
      console.log('Restarted aibot.');
    }
  }

  writeFileSync(join(dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  console.log(`\nBackup written to ${dest}`);
}

// --- restore ---------------------------------------------------------------

function restore(src: string, opts: { prefix: string; force: boolean }): void {
  const manifestPath = join(src, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`No manifest.json in ${src} — not a backup directory.`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    volumes: Record<string, { archive: string }>;
  };

  const intoLive = opts.prefix === `${PROJECT}_`;
  if (intoLive && !opts.force) {
    console.error('Restoring over the live volumes destroys current state.');
    console.error('Re-run with --force, or use --prefix to restore into throwaway volumes.');
    process.exit(1);
  }
  if (intoLive && composeRunning()) {
    console.error('Stop the stack first:  docker compose --profile local-ollama stop');
    process.exit(1);
  }

  for (const [vol, meta] of Object.entries(manifest.volumes)) {
    const target = `${opts.prefix}${vol}`;
    const archive = join(src, meta.archive);
    if (!existsSync(archive)) {
      console.log(`  skip ${vol} (archive missing)`);
      continue;
    }
    sh(['docker', 'volume', 'create', target], { quiet: true });
    // Feed the archive in over stdin — again, no Windows bind mount.
    const proc = Bun.spawnSync(
      ['docker', 'run', '--rm', '-i', '-v', `${target}:/v`, HELPER_IMAGE, 'tar', 'xzf', '-', '-C', '/v'],
      { stdin: readFileSync(archive), stdout: 'pipe', stderr: 'pipe' }
    );
    if (proc.exitCode !== 0) {
      console.error(`  fail ${vol}: ${proc.stderr.toString().trim()}`);
      continue;
    }
    console.log(`  ok   ${vol} -> ${target}`);
  }
  console.log('\nRestore complete.');
  if (!intoLive) {
    console.log(`Inspect with:  docker run --rm -v ${opts.prefix}aibot_config:/v alpine ls -la /v`);
    console.log(`Remove with:   docker volume rm ${Object.keys(manifest.volumes).map((v) => opts.prefix + v).join(' ')}`);
  }
}

// --- list ------------------------------------------------------------------

function list(outRoot: string): void {
  if (!existsSync(outRoot)) {
    console.log(`No backups yet (${outRoot} does not exist).`);
    return;
  }
  const dirs = readdirSync(outRoot).filter((d) => d.startsWith('aibot-backup-')).sort();
  if (dirs.length === 0) {
    console.log(`No backups in ${outRoot}.`);
    return;
  }
  for (const d of dirs) {
    const p = join(outRoot, d);
    let total = 0;
    for (const f of readdirSync(p)) total += statSync(join(p, f)).size;
    console.log(`${d}  ${human(total).padStart(9)}`);
  }
}

// --- cli -------------------------------------------------------------------

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outRoot = normalizePath(flag('--out') ?? process.env.AIBOT_BACKUP_DIR ?? DEFAULT_OUT);

switch (cmd) {
  case 'backup':
    backup(outRoot, { stop: !args.includes('--no-stop') });
    break;
  case 'restore': {
    const src = args[1];
    if (!src || src.startsWith('--')) {
      console.error('Usage: backup.ts restore <backup-dir> [--prefix P] [--force]');
      process.exit(1);
    }
    restore(normalizePath(src), {
      prefix: flag('--prefix') ?? `${PROJECT}_`,
      force: args.includes('--force'),
    });
    break;
  }
  case 'list':
    list(outRoot);
    break;
  default:
    console.log('Usage: bun scripts/docker/backup.ts <backup|restore|list> [options]');
    console.log(`Backup directory: ${outRoot}`);
    process.exit(cmd ? 1 : 0);
}
