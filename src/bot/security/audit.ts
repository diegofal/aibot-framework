/**
 * Security Audit Module — Main Orchestrator
 *
 * Runs all check modules and aggregates findings into a structured report.
 * Adapted from OpenClaw's src/security/audit.ts — simplified for aibot-framework
 * (no gateway, Docker, multi-channel, or deep probe support).
 *
 * Target: src/bot/security/audit.ts
 *
 * Usage:
 *   const report = await runSecurityAudit({ botDir: "~/.aibot" });
 *   if (report.summary.critical > 0) { ... }
 *
 * Integration points:
 *   - Bot startup: quick audit (no tool scan) → log criticals
 *   - MCP tool: full audit → return report to conversation
 *   - Cron job: periodic audit → save findings to memory
 *   - Healthcheck skill: guided audit workflow via SKILL.md prompt
 */

import type { AuditFinding, AuditOptions, AuditReport, AuditSummary } from './audit-types.js';
import { checkDangerousFlags } from './checks/config-flags.js';
import { checkConfigSecrets } from './checks/config-secrets.js';
import { checkFilesystemPermissions } from './checks/filesystem.js';
import { checkModelHygiene } from './checks/model-hygiene.js';
import { checkToolSafety } from './checks/tool-safety.js';

// --- Summary computation ---

function computeSummary(findings: AuditFinding[]): AuditSummary {
  const summary: AuditSummary = { critical: 0, warn: 0, info: 0 };
  for (const f of findings) {
    summary[f.severity]++;
  }
  return summary;
}

// --- Severity ordering for display ---

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warn: 1, info: 2 };

function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
  );
}

// --- Main entry point ---

export async function runSecurityAudit(opts: AuditOptions): Promise<AuditReport> {
  const startTime = Date.now();
  const allFindings: AuditFinding[] = [];
  const platform = opts.platform ?? process.platform;

  // Phase 1: Fast synchronous-ish checks (config-based)
  // These read config files but don't walk directory trees.

  const [configSecretFindings, configFlagFindings, modelFindings] = await Promise.all([
    checkConfigSecrets({
      botDir: opts.botDir,
      configPath: opts.configPath,
      envPath: opts.envPath,
    }),
    checkDangerousFlags({
      botDir: opts.botDir,
      configPath: opts.configPath,
    }),
    checkModelHygiene({
      botDir: opts.botDir,
      configPath: opts.configPath,
    }),
  ]);

  allFindings.push(...configSecretFindings, ...configFlagFindings, ...modelFindings);

  // Phase 2: Filesystem checks (async I/O — stat calls)

  const fsFindings = await checkFilesystemPermissions({
    botDir: opts.botDir,
    configPath: opts.configPath,
  });
  allFindings.push(...fsFindings);

  // Phase 3: Tool source scanning (opt-in, potentially slow)

  if (opts.includeToolScan) {
    const toolsDir = opts.toolsDir ?? `${opts.botDir}/tools`;
    try {
      const toolFindings = await checkToolSafety({ toolsDir });
      allFindings.push(...toolFindings);
    } catch {
      // If tools directory doesn't exist or can't be read, skip silently.
      // Not having dynamic tools is fine.
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    timestamp: Date.now(),
    summary: computeSummary(allFindings),
    findings: sortFindings(allFindings),
    meta: {
      platform,
      botDir: opts.botDir,
      durationMs,
    },
  };
}

// --- Report formatting utilities ---

export function formatReportText(report: AuditReport): string {
  const lines: string[] = [];

  lines.push(`Security Audit Report — ${new Date(report.timestamp).toISOString()}`);
  lines.push(
    `Bot dir: ${report.meta.botDir} | Platform: ${report.meta.platform} | Duration: ${report.meta.durationMs}ms`
  );
  lines.push('');

  const { critical, warn, info } = report.summary;
  const total = critical + warn + info;

  if (total === 0) {
    lines.push('✅ No issues found. Security posture looks clean.');
    return lines.join('\n');
  }

  lines.push(`Found ${total} issue(s): ${critical} critical, ${warn} warnings, ${info} info`);
  lines.push('');

  for (const f of report.findings) {
    const icon = f.severity === 'critical' ? '🔴' : f.severity === 'warn' ? '🟡' : 'ℹ️';
    lines.push(`${icon} [${f.severity.toUpperCase()}] ${f.title}`);
    lines.push(`   ${f.detail}`);
    if (f.remediation) {
      lines.push(`   Fix: ${f.remediation}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatReportMarkdown(report: AuditReport): string {
  const lines: string[] = [];

  const { critical, warn, info } = report.summary;
  const total = critical + warn + info;

  lines.push('## Security Audit Report');
  lines.push(
    `*${new Date(report.timestamp).toISOString()}* | \`${report.meta.botDir}\` | ${report.meta.durationMs}ms`
  );
  lines.push('');

  if (total === 0) {
    lines.push('> ✅ No issues found.');
    return lines.join('\n');
  }

  lines.push(`**${total} issues**: ${critical} critical, ${warn} warnings, ${info} info`);
  lines.push('');

  // Group by severity
  for (const severity of ['critical', 'warn', 'info'] as const) {
    const group = report.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;

    const header =
      severity === 'critical'
        ? '### 🔴 Critical'
        : severity === 'warn'
          ? '### 🟡 Warnings'
          : '### ℹ️ Info';
    lines.push(header);
    lines.push('');

    for (const f of group) {
      lines.push(`- **${f.title}** (\`${f.checkId}\`)`);
      lines.push(`  ${f.detail}`);
      if (f.remediation) {
        lines.push(`  *Fix*: \`${f.remediation}\``);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// Re-export types for convenience
export type { AuditFinding, AuditReport, AuditOptions, AuditSummary } from './audit-types.js';
