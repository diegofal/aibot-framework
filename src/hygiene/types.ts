/**
 * Hygiene — deterministic, LLM-free maintenance routines for soul files,
 * memory logs, productions and the data directory.
 *
 * Every routine exposes `preview` (dry run, no writes) and `apply`. Apply
 * backs up every soul file it rewrites and never deletes anything: cleanup
 * moves paths into `<dataDir>/_trash/<stamp>/` with a manifest.
 */

import type { Config } from '../config';
import type { Logger } from '../logger';

export type HygieneScope = 'bot' | 'fleet';
export type HygieneSeverity = 'info' | 'warn' | 'critical';

export interface HygieneFix {
  action: string;
  details: string;
}

export interface HygieneFinding {
  id: string;
  kind: string;
  severity: HygieneSeverity;
  file: string | null;
  line: number | null;
  message: string;
  fixable: boolean;
  fix?: HygieneFix;
  /** Set on findings produced by the `all` routine so the caller can group them. */
  botId?: string;
  /** Routine-specific payload used by `apply` (indices, spans, deduped arrays...). */
  data?: Record<string, unknown>;
}

export interface HygieneApplied {
  findingId: string;
  action: string;
  result: string;
}

export interface HygieneSkipped {
  findingId: string;
  reason: string;
}

export interface HygieneRun {
  runId: string;
  routine: string;
  botId: string | null;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  findings: HygieneFinding[];
  applied: HygieneApplied[];
  skipped: HygieneSkipped[];
  backups: string[];
  error?: string;
}

export interface HygieneRoutineInfo {
  id: string;
  name: string;
  description: string;
  scope: HygieneScope;
  canApply: boolean;
}

/** Last soul health-check outcome, as reported by the orchestrator. */
export interface HealthCheckInfo {
  at: string;
  ok: boolean;
  error?: string;
}

/** External lookups the orchestrator may provide. All optional; defaults are conservative. */
export interface HygieneDeps {
  /** True when the tool-audit log shows a recent successful call for this bot+tool. */
  toolSucceededRecently: (botId: string, toolName: string) => boolean;
  /** Current channel state for the bot ('ok' | 'error' | ...). Undefined = unknown. */
  channelStateOf: (botId: string) => string | undefined;
  /** Last soul health-check result for the bot. Undefined = never ran / unknown. */
  lastHealthCheckOf: (botId: string) => HealthCheckInfo | undefined;
}

export interface HygieneContext {
  /** Null for fleet-scoped routines. */
  botId: string | null;
  /** Resolved soul directory for the bot (null for fleet scope). */
  soulDir: string | null;
  /** Resolved productions/work directory for the bot (null for fleet scope). */
  workDir: string | null;
  /** config.paths.data */
  dataDir: string;
  /** Absolute roots inside which writes/moves are permitted. */
  allowedRoots: string[];
  config: Config;
  logger: Logger;
  now: Date;
  options: Record<string, unknown>;
  deps: HygieneDeps;
}

export interface HygieneApplyResult {
  applied: HygieneApplied[];
  skipped: HygieneSkipped[];
  backups: string[];
}

export interface HygieneRoutine extends HygieneRoutineInfo {
  preview(ctx: HygieneContext): HygieneFinding[];
  apply(ctx: HygieneContext, findings: HygieneFinding[]): HygieneApplyResult;
}

export const HYGIENE_HISTORY_LIMIT = 500;
