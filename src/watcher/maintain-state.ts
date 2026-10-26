/**
 * When daily maintenance (forget, link, relayout) last completed, kept in
 * `maintain.json`. Before it the 24 h wait counted from each start, so a fleet
 * restarted more often than daily never forgot anything.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MAINTAIN_EVERY_MS = 86_400_000;

/** The persisted `lastMaintainAt` in ms; undefined when absent or unreadable. Never throws. */
export function readLastMaintainAt(file: string): number | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { lastMaintainAt?: unknown };
    const ms = typeof raw.lastMaintainAt === 'string' ? Date.parse(raw.lastMaintainAt) : Number.NaN;
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/** Keep `lastMaintainAt` (atomic). Never throws: a lost time only means one early run. */
export function writeLastMaintainAt(file: string, at: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ lastMaintainAt: at }), 'utf-8');
    renameSync(tmp, file);
  } catch {
    // the next start finds no record and maintains once more
  }
}

/** Maintenance is due when it never ran (or the record is unreadable) or ran a day ago or more. */
export function maintenanceDue(lastMs: number | undefined, nowMs: number): boolean {
  return lastMs === undefined || nowMs - lastMs >= MAINTAIN_EVERY_MS;
}
