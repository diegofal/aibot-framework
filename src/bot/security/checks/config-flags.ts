/**
 * Security Audit — Dangerous Config Flag Detection
 *
 * Adapted from OpenClaw's dangerous-config-flags.ts + collectSandboxDangerousConfigFindings.
 * Scans bot configuration for dangerous flag patterns and insecure settings.
 *
 * Target: src/bot/security/checks/config-flags.ts
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditFinding } from '../audit-types.js';

// --- Dangerous flag patterns ---

type FlagCheck = {
  /** Dot-path in config object, e.g. "exec.unrestricted" */
  path: string;
  /** What makes this dangerous */
  reason: string;
  /** Only flag if value matches (default: truthy) */
  matchValue?: unknown;
  severity: 'critical' | 'warn';
  remediation: string;
};

const FLAG_CHECKS: FlagCheck[] = [
  {
    path: 'dangerouslyDisablePermissions',
    reason:
      'All permission checks are bypassed — tools can perform any action without human approval.',
    severity: 'critical',
    remediation:
      "Remove 'dangerouslyDisablePermissions' from your config. Use per-tool permission grants instead.",
  },
  {
    path: 'dangerouslyAllowAllTools',
    reason:
      'All tools are enabled without review. Any dynamically-created tool runs without safety checks.',
    severity: 'critical',
    remediation: "Remove 'dangerouslyAllowAllTools' and explicitly enable only the tools you need.",
  },
  {
    path: 'dangerouslyDisableAuditLog',
    reason: 'Audit logging is disabled — tool invocations are not tracked.',
    severity: 'warn',
    remediation:
      "Remove 'dangerouslyDisableAuditLog'. Audit logs are low-cost and high-value for incident response.",
  },
  {
    path: 'allowInsecureAuth',
    reason: 'Authentication security checks are relaxed.',
    severity: 'warn',
    remediation: "Remove 'allowInsecureAuth' unless you have a specific reason.",
  },
  {
    path: 'exec.unrestricted',
    reason: 'Shell execution tool has no command restrictions.',
    severity: 'critical',
    remediation: "Set 'exec.unrestricted' to false and configure allowed command patterns.",
  },
  {
    path: 'mcp.allowUntrustedServers',
    reason:
      'MCP connections to unverified servers are allowed — tool calls may be routed to hostile endpoints.',
    severity: 'critical',
    remediation:
      "Remove 'mcp.allowUntrustedServers' and explicitly whitelist trusted MCP server URLs.",
  },
];

// --- Config traversal ---

function getConfigValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function scanForDangerouslyPrefixed(
  obj: Record<string, unknown>,
  path: string
): Array<{ fullPath: string; value: unknown }> {
  const hits: Array<{ fullPath: string; value: unknown }> = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = path ? `${path}.${key}` : key;

    if ((key.startsWith('dangerously') || key.startsWith('allowInsecure')) && value) {
      // Check it's not already handled by FLAG_CHECKS
      const isKnown = FLAG_CHECKS.some((fc) => fc.path === fullPath);
      if (!isKnown) {
        hits.push({ fullPath, value });
      }
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      hits.push(...scanForDangerouslyPrefixed(value as Record<string, unknown>, fullPath));
    }
  }

  return hits;
}

// --- Main entry point ---

export async function checkDangerousFlags(opts: {
  botDir: string;
  configPath?: string;
}): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const configPath = opts.configPath ?? join(opts.botDir, 'config.json');

  let config: Record<string, unknown>;
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = JSON.parse(raw);
    if (typeof config !== 'object' || config === null) return findings;
  } catch {
    // Can't read or parse config — nothing to check
    return findings;
  }

  // Check known dangerous flags
  for (const check of FLAG_CHECKS) {
    const value = getConfigValue(config, check.path);
    if (value === undefined) continue;

    const matches = check.matchValue !== undefined ? value === check.matchValue : Boolean(value);

    if (matches) {
      findings.push({
        checkId: `config.flags.${check.path.replace(/\./g, '_')}`,
        severity: check.severity,
        title: `Dangerous config flag: ${check.path}`,
        detail: check.reason,
        remediation: check.remediation,
      });
    }
  }

  // Scan for unknown dangerously*/allowInsecure* flags
  const wildcardHits = scanForDangerouslyPrefixed(config, '');
  for (const hit of wildcardHits) {
    findings.push({
      checkId: `config.flags.${hit.fullPath.replace(/\./g, '_')}.unknown`,
      severity: 'warn',
      title: `Unknown dangerous flag: ${hit.fullPath}`,
      detail: `Config contains "${hit.fullPath}" which uses a dangerous/insecure prefix. This may bypass safety mechanisms.`,
      remediation: `Review whether "${hit.fullPath}" is necessary. If it disables a safety feature, consider removing it.`,
    });
  }

  return findings;
}
