/**
 * The watcher's hard kill (autonomy rung 0, invariant C1 of
 * `docs/plans/watcher-autonomy-plan.md`): an off switch the watcher cannot
 * reach. Two sources, either one kills:
 *
 * - the environment: `AIBOT_WATCHER_KILL` set to `1`, `true`, `yes` or `on`
 *   (case-insensitive);
 * - a sentinel file `<paths.data>/watcher-kill`. It sits deliberately OUTSIDE
 *   the watcher dir (`<paths.data>/watcher/`): nothing the watcher writes can
 *   create or remove it. Its content does not matter, only that it exists.
 *
 * `readKillSwitch` is pure over its inputs and never throws: an error reading
 * the file is "not killed by file" (the env still counts). It is read by
 * `instrumented()` before every model call (`llm.ts`, the single choke point)
 * and by the `Watcher` at start and every few seconds while it runs. Nothing
 * in the framework writes either source: only the operator does (shell,
 * container env, `touch`).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config';

/** The environment variable of the hard kill. */
export const WATCHER_KILL_ENV = 'AIBOT_WATCHER_KILL';

/** The sentinel file's name, directly under `paths.data`. */
export const WATCHER_KILL_FILE = 'watcher-kill';

export type KillSource = 'env' | 'file';

export type KillState = { killed: true; source: KillSource } | { killed: false };

const KILL_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** True for the env values that kill: `1`, `true`, `yes`, `on`, any case, trimmed. */
export function isKillValue(value: string | undefined): boolean {
  return typeof value === 'string' && KILL_VALUES.has(value.trim().toLowerCase());
}

/** `<paths.data>/watcher-kill` (the same `./data` default as `watcherDir`). */
export function killSentinelPath(config: Pick<Config, 'paths'>): string {
  const data = (config.paths as { data?: string } | undefined)?.data ?? './data';
  return join(data, WATCHER_KILL_FILE);
}

export interface KillSwitchInput {
  /** Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  sentinelPath: string;
  /** Default `existsSync`; a throw counts as "no file". */
  exists?: (path: string) => boolean;
}

/** Whether the hard kill is on, and which source turned it on (env first). Never throws. */
export function readKillSwitch(input: KillSwitchInput): KillState {
  let envValue: string | undefined;
  try {
    envValue = (input.env ?? process.env)[WATCHER_KILL_ENV];
  } catch {
    envValue = undefined;
  }
  if (isKillValue(envValue)) return { killed: true, source: 'env' };
  try {
    if ((input.exists ?? existsSync)(input.sentinelPath)) return { killed: true, source: 'file' };
  } catch {
    // unreadable is not a kill by file
  }
  return { killed: false };
}

/** What turned the kill on, in words (the log rows name it). */
function killCause(source: KillSource, sentinelPath: string): string {
  return source === 'env'
    ? `the environment variable ${WATCHER_KILL_ENV} is set`
    : `the file ${sentinelPath} exists`;
}

/** The row of a start refused while killed. */
export function narrateKillRefusedStart(source: KillSource, sentinelPath: string): string {
  return `I did not start: the hard kill is on (${killCause(source, sentinelPath)}). Nothing runs until it is cleared and you start me again.`;
}

/** The row of a running watcher the kill stopped. */
export function narrateKillStopped(source: KillSource, sentinelPath: string): string {
  return `The hard kill turned on (${killCause(source, sentinelPath)}), so I stopped and aborted every model call in flight. Nothing runs until it is cleared and you start me again.`;
}
