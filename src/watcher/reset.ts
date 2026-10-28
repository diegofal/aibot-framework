/**
 * The mind reset (`docs/plans/mind-roster-plan.md`): every bot turned off and
 * the watcher's directory archived under `<data>/_trash`, so the next start is
 * a fresh birth that reads no bot's material (birth skips disabled bots).
 * Nothing is deleted: `restoreMindReset` puts both back.
 *
 * Offline only: the running process owns the watcher files and compacts its
 * in-memory graph over them on stop. `applyMindReset` refuses when any file
 * in the watcher dir changed within `RUNNING_WINDOW_MS`. Run it from
 * `scripts/watcher/reset-mind.ts` with the app container stopped.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeJsonFileAtomic } from '../config';

/** A file written this recently means the watcher is still running. */
export const RUNNING_WINDOW_MS = 60_000;

const MANIFEST = 'manifest.json';
const KIND = 'mind-reset';

export interface MindResetPaths {
  /** `paths.data` (the watcher dir is `<dataDir>/watcher`). */
  dataDir: string;
  /** The directory of config.json and bots.json. */
  configDir: string;
  nowMs: number;
}

export interface MindResetPlan {
  dataDir: string;
  botsPath: string;
  watcherDir: string;
  archiveDir: string;
  /** Bots that are on now (an absent `enabled` is on). */
  enabledBots: string[];
  watcherExists: boolean;
  watcherFiles: number;
}

export interface MindResetManifest {
  kind: typeof KIND;
  at: string;
  previouslyEnabled: string[];
  watcherArchived: boolean;
  restoredAt?: string;
}

interface RawBot {
  id?: unknown;
  enabled?: unknown;
  [k: string]: unknown;
}

/** bots.json as written: a bare array (today) or `{ bots: [...] }`. */
interface BotsFile {
  list: RawBot[];
  wrap: (list: RawBot[]) => unknown;
}

function readBots(path: string): BotsFile {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (Array.isArray(raw)) return { list: raw as RawBot[], wrap: (l) => l };
  if (raw && typeof raw === 'object' && Array.isArray((raw as { bots?: unknown }).bots)) {
    const obj = raw as Record<string, unknown>;
    return { list: obj.bots as RawBot[], wrap: (l) => ({ ...obj, bots: l }) };
  }
  throw new Error(`${path} is neither a bot array nor { bots: [...] }`);
}

const isOn = (b: RawBot) => b.enabled !== false;
const idOf = (b: RawBot) => String(b.id ?? '');

function walk(dir: string, visit: (path: string) => void): void {
  visit(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else visit(path);
  }
}

function countFiles(dir: string): number {
  let n = 0;
  walk(dir, (p) => {
    if (p !== dir && statSync(p).isFile()) n++;
  });
  return n;
}

/** True when the dir or anything under it was modified within `windowMs` of `nowMs`. */
export function watcherWrittenWithin(dir: string, nowMs: number, windowMs: number): boolean {
  if (!existsSync(dir)) return false;
  let recent = false;
  walk(dir, (p) => {
    if (statSync(p).mtimeMs > nowMs - windowMs) recent = true;
  });
  return recent;
}

function stampOf(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, '-');
}

/** What a reset would do. Reads only. */
export function planMindReset(p: MindResetPaths): MindResetPlan {
  const botsPath = join(p.configDir, 'bots.json');
  const watcherDir = join(p.dataDir, 'watcher');
  const watcherExists = existsSync(watcherDir);
  return {
    dataDir: p.dataDir,
    botsPath,
    watcherDir,
    archiveDir: join(p.dataDir, '_trash', `${stampOf(p.nowMs)}-${KIND}`),
    enabledBots: readBots(botsPath).list.filter(isOn).map(idOf),
    watcherExists,
    watcherFiles: watcherExists ? countFiles(watcherDir) : 0,
  };
}

function refuseIfRunning(watcherDir: string, nowMs: number): void {
  if (watcherWrittenWithin(watcherDir, nowMs, RUNNING_WINDOW_MS)) {
    throw new Error(
      `${watcherDir} changed in the last minute: the app looks still running. Stop the container first.`
    );
  }
}

/**
 * Turn every bot off and archive the watcher dir. The manifest is written
 * first, so an interrupted reset can still be restored by hand.
 */
export function applyMindReset(
  plan: MindResetPlan,
  opts: { nowMs: number }
): { disabled: string[]; archiveDir: string } {
  refuseIfRunning(plan.watcherDir, opts.nowMs);
  const bots = readBots(plan.botsPath);
  const disabled = bots.list.filter(isOn).map(idOf);
  mkdirSync(plan.archiveDir, { recursive: true });
  const manifest: MindResetManifest = {
    kind: KIND,
    at: new Date(opts.nowMs).toISOString(),
    previouslyEnabled: disabled,
    watcherArchived: plan.watcherExists,
  };
  writeFileSync(join(plan.archiveDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  writeJsonFileAtomic(plan.botsPath, bots.wrap(bots.list.map((b) => ({ ...b, enabled: false }))));
  if (plan.watcherExists) renameSync(plan.watcherDir, join(plan.archiveDir, 'watcher'));
  return { disabled, archiveDir: plan.archiveDir };
}

/**
 * Undo a reset: the archived watcher dir goes back (a watcher dir made since
 * is set aside under `_trash`, never overwritten) and the bots it turned off
 * are turned on again, those that still exist.
 */
export function restoreMindReset(
  archiveDir: string,
  p: MindResetPaths
): { reenabled: string[]; missing: string[]; displaced?: string } {
  const manifestPath = join(archiveDir, MANIFEST);
  let manifest: MindResetManifest | undefined;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as MindResetManifest;
  } catch {
    manifest = undefined;
  }
  if (manifest?.kind !== KIND) throw new Error(`${archiveDir} is not a mind reset archive`);
  const watcherDir = join(p.dataDir, 'watcher');
  refuseIfRunning(watcherDir, p.nowMs);

  let displaced: string | undefined;
  const archived = join(archiveDir, 'watcher');
  if (existsSync(archived)) {
    if (existsSync(watcherDir)) {
      const aside = join(p.dataDir, '_trash', `${stampOf(p.nowMs)}-mind-restore-displaced`);
      mkdirSync(aside, { recursive: true });
      displaced = join(aside, 'watcher');
      renameSync(watcherDir, displaced);
    }
    renameSync(archived, watcherDir);
  }

  const botsPath = join(p.configDir, 'bots.json');
  const bots = readBots(botsPath);
  const ids = new Set(bots.list.map(idOf));
  const wanted = new Set(manifest.previouslyEnabled);
  writeJsonFileAtomic(
    botsPath,
    bots.wrap(bots.list.map((b) => (wanted.has(idOf(b)) ? { ...b, enabled: true } : b)))
  );
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, restoredAt: new Date(p.nowMs).toISOString() }, null, 2)}\n`
  );
  return {
    reenabled: manifest.previouslyEnabled.filter((id) => ids.has(id)),
    missing: manifest.previouslyEnabled.filter((id) => !ids.has(id)),
    ...(displaced ? { displaced } : {}),
  };
}
