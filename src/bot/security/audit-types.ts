/**
 * Security Audit Module — Type Definitions
 *
 * Adapted from OpenClaw's src/security/ types.
 * Stripped: gateway, Docker, Windows ACL, multi-channel, deep probe types.
 * Added: meta field with platform/duration, AuditOptions with DI support.
 *
 * Target: src/bot/security/audit-types.ts
 */

export type AuditSeverity = 'info' | 'warn' | 'critical';

export type AuditFinding = {
  /** Namespaced check ID, e.g. "fs.bot_dir.world_writable" */
  checkId: string;
  severity: AuditSeverity;
  title: string;
  detail: string;
  /** Exact command or instruction to fix. Every critical/warn SHOULD have this. */
  remediation?: string;
};

export type AuditSummary = {
  critical: number;
  warn: number;
  info: number;
};

export type AuditReport = {
  timestamp: number;
  summary: AuditSummary;
  findings: AuditFinding[];
  meta: {
    platform: string;
    botDir: string;
    durationMs: number;
  };
};

export type AuditOptions = {
  /** Root bot directory, typically ~/.aibot/ */
  botDir: string;
  /** Path to main config file (config.json). Defaults to botDir/config.json */
  configPath?: string;
  /** Path to .env file. Defaults to botDir/.env */
  envPath?: string;
  /** Path to dynamic tools directory. Defaults to botDir/tools/ */
  toolsDir?: string;
  /** Whether to run the (slower) tool source scanner */
  includeToolScan?: boolean;
  /** DI: override process.env for testing */
  env?: Record<string, string | undefined>;
  /** DI: override platform for testing */
  platform?: NodeJS.Platform;
};

// --- Fix types ---

export type FixActionChmod = {
  kind: 'chmod';
  path: string;
  oldMode: number;
  newMode: number;
  ok: boolean;
  error?: string;
};

export type FixActionConfig = {
  kind: 'config';
  key: string;
  oldValue: string;
  newValue: string;
  ok: boolean;
  error?: string;
};

export type FixAction = FixActionChmod | FixActionConfig;

export type FixResult = {
  ok: boolean;
  dryRun: boolean;
  actions: FixAction[];
  errors: string[];
};

export type FixOptions = {
  botDir: string;
  configPath?: string;
  /** If true, report what would change without changing it */
  dryRun?: boolean;
};
