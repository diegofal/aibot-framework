#!/usr/bin/env bun
/**
 * Copies the operator's host config/ into the aibot_config Docker volume,
 * rewriting the handful of values that are host-specific and would be wrong
 * inside a container.
 *
 * The named volume — not the host directory — is the source of truth once the
 * stack is running: the dashboard rewrites config.json, bots.json and
 * config/soul/ at runtime. This script is therefore a one-way seed, and it
 * refuses to clobber an existing volume config unless --force is passed.
 *
 *   bun scripts/docker/load-config.ts            # dry run, prints the rewrites
 *   bun scripts/docker/load-config.ts --apply    # seed an empty/unseeded volume
 *   bun scripts/docker/load-config.ts --apply --force   # overwrite the volume
 *
 * Bot enabled flags are copied verbatim. Nothing here decides whether a bot
 * polls Telegram — AIBOT_AUTOSTART_BOTS in .env does, and it must stay false
 * until you have confirmed no other instance owns the tokens.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTAINER = process.env.AIBOT_CONTAINER ?? 'aibot-framework-aibot-1';
const CONTAINER_CONFIG_DIR = '/app/config';
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

interface Rewrite {
  path: string;
  from: unknown;
  to: unknown;
  why: string;
}

const rewrites: Rewrite[] = [];

function note(path: string, from: unknown, to: unknown, why: string): void {
  rewrites.push({ path, from, to, why });
}

/** Paths baked into the config that only exist on the operator's dev machine. */
function isForeignAbsolutePath(p: string): boolean {
  return p.startsWith('/') && !p.startsWith('/app') && !existsSync(p);
}

function run(cmd: string[]): string {
  const res = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  if (res.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed: ${res.stderr.toString().trim()}`);
  }
  return res.stdout.toString();
}

// --- transform -------------------------------------------------------------

const raw = readFileSync('config/config.json', 'utf-8');
const config = JSON.parse(raw) as Record<string, any>;

// The container reaches Ollama over the compose network, never over loopback.
// Switching to the ${OLLAMA_BASE_URL} placeholder keeps one config correct in
// both worlds: .env supplies 127.0.0.1 for host-native runs, and compose
// supplies http://ollama:11434 inside the container.
const baseUrl: unknown = config.ollama?.baseUrl;
if (typeof baseUrl === 'string' && /(127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(baseUrl)) {
  note('ollama.baseUrl', baseUrl, '${OLLAMA_BASE_URL}', 'loopback is the container itself, not the sidecar');
  config.ollama.baseUrl = '${OLLAMA_BASE_URL}';
}

// The app is installed at /app in the image; a dev-machine checkout path makes
// every file tool fail with ENOENT.
const basePath: unknown = config.fileTools?.basePath;
if (typeof basePath === 'string' && isForeignAbsolutePath(basePath)) {
  note('fileTools.basePath', basePath, '/app', 'path does not exist in the image');
  config.fileTools.basePath = '/app';
}

const allowed: unknown = config.fileTools?.allowedPaths;
if (Array.isArray(allowed)) {
  const kept = allowed.filter((p) => typeof p !== 'string' || !isForeignAbsolutePath(p));
  if (kept.length !== allowed.length) {
    note('fileTools.allowedPaths', allowed, kept, 'dropped paths that do not exist in the image');
    config.fileTools.allowedPaths = kept;
  }
}

// Bind the dashboard to every interface *inside* the container. That is not an
// exposure: compose publishes the port as 127.0.0.1:3000 on the host, so the
// only route in is the host loopback.
if (config.web?.enabled && config.web.host !== '0.0.0.0') {
  note('web.host', config.web.host, '0.0.0.0', 'container-internal bind; compose publishes it on host loopback only');
  config.web.host = '0.0.0.0';
}

// --- report ----------------------------------------------------------------

const bots = JSON.parse(readFileSync('config/bots.json', 'utf-8')) as Array<{
  id: string;
  enabled?: boolean;
  llmBackend?: string;
}>;

console.log('Rewrites applied to config.json for the container:');
if (rewrites.length === 0) {
  console.log('  (none — host config is already container-clean)');
}
for (const r of rewrites) {
  console.log(`  ${r.path}`);
  console.log(`    from: ${JSON.stringify(r.from)}`);
  console.log(`    to:   ${JSON.stringify(r.to)}`);
  console.log(`    why:  ${r.why}`);
}

const enabled = bots.filter((b) => b.enabled);
console.log(`\nbots.json: ${bots.length} bots, ${enabled.length} with enabled=true (copied verbatim)`);
console.log(`  enabled: ${enabled.map((b) => b.id).join(', ') || '(none)'}`);
console.log('  Whether these poll Telegram is decided by AIBOT_AUTOSTART_BOTS in .env.');

const claudeBots = bots.filter((b) => b.llmBackend === 'claude-cli');
if (claudeBots.length > 0) {
  console.log(
    `\nWARNING: ${claudeBots.length} bots use llmBackend "claude-cli" (${claudeBots
      .map((b) => b.id)
      .join(', ')}).`
  );
  console.log('  The `claude` binary is not in the image. These fall back to Ollama per call,');
  console.log('  which works but logs a spawn failure every time. Switch them to "ollama".');
}

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to write these into the volume.');
  process.exit(0);
}

// --- apply -----------------------------------------------------------------

const probe = Bun.spawnSync(['docker', 'exec', CONTAINER, 'sh', '-c', `test -f ${CONTAINER_CONFIG_DIR}/config.json && echo yes || echo no`]);
if (probe.exitCode !== 0) {
  console.error(`\nCannot reach container "${CONTAINER}". Is the stack up?`);
  process.exit(1);
}
const volumeSeeded = probe.stdout.toString().trim() === 'yes';

// A seeded volume may already contain dashboard edits. Overwriting it silently
// would discard live operator state, so make the caller say so out loud.
if (volumeSeeded && !FORCE) {
  const existing = run(['docker', 'exec', CONTAINER, 'cat', `${CONTAINER_CONFIG_DIR}/config.json`]);
  const isPristineSeed = existing.trim() === readFileSync('config/config.example.json', 'utf-8').trim();
  if (!isPristineSeed) {
    console.error('\nRefusing to overwrite: the volume config differs from the shipped example,');
    console.error('so it may contain dashboard edits. Back it up, then re-run with --force.');
    process.exit(1);
  }
  console.log('\nVolume holds an untouched example seed — safe to replace.');
}

const staging = mkdtempSync(join(tmpdir(), 'aibot-cfg-'));
const stagedConfig = join(staging, 'config.json');
writeFileSync(stagedConfig, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

run(['docker', 'cp', stagedConfig, `${CONTAINER}:${CONTAINER_CONFIG_DIR}/config.json`]);
run(['docker', 'cp', 'config/bots.json', `${CONTAINER}:${CONTAINER_CONFIG_DIR}/bots.json`]);

// docker cp lands files as root; the app runs as uid 1000 and rewrites both.
run(['docker', 'exec', '--user', 'root', CONTAINER, 'chown', 'bun:bun', `${CONTAINER_CONFIG_DIR}/config.json`, `${CONTAINER_CONFIG_DIR}/bots.json`]);

console.log('\nWrote config.json and bots.json into the volume.');
console.log('Restart to load them:  docker compose --profile local-ollama restart aibot');
