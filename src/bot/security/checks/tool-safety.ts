/**
 * Security Audit — Tool Safety Scanner
 *
 * Directly adapted from OpenClaw's skill-scanner.ts.
 * Scans TypeScript/JavaScript source files for dangerous patterns:
 *   - Line-level rules: dangerous exec, eval, crypto mining, suspicious network
 *   - Source-level rules: data exfiltration, obfuscated code, env harvesting
 *
 * In our context, this scans dynamic tools created via `create_tool`
 * (stored in ~/.aibot/tools/) and any custom user scripts.
 *
 * Target: src/bot/security/checks/tool-safety.ts
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { AuditFinding } from '../audit-types.js';

// --- Types ---

type ScanSeverity = 'critical' | 'warn';

type LineScanRule = {
  id: string;
  severity: ScanSeverity;
  /** Test a single line of source code */
  test: (line: string, lineNum: number) => string | null;
};

type SourceScanRule = {
  id: string;
  severity: ScanSeverity;
  /** Test the full source as a single string */
  test: (source: string) => string | null;
};

type ScanFinding = {
  ruleId: string;
  severity: ScanSeverity;
  message: string;
  line?: number;
  file: string;
};

// --- Line-level rules (adapted from OpenClaw) ---

const LINE_RULES: LineScanRule[] = [
  {
    id: 'dangerous-exec',
    severity: 'critical',
    test: (line) => {
      // Match child_process usage: exec, execSync, spawn, spawnSync, execFile
      if (/(?:require\s*\(\s*['"]child_process['"]\s*\)|from\s+['"]child_process['"])/.test(line)) {
        return 'Imports child_process — can execute arbitrary system commands.';
      }
      // Direct exec/spawn calls (without the import context, catch the usage)
      if (/\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/.test(line)) {
        // Avoid false positives on our own tool executor internals
        if (/(?:toolExec|ToolExecutor|test|spec|mock)/i.test(line)) return null;
        return 'Calls exec/spawn — can execute arbitrary system commands.';
      }
      return null;
    },
  },
  {
    id: 'dynamic-code-execution',
    severity: 'critical',
    test: (line) => {
      if (/\beval\s*\(/.test(line)) {
        return 'Uses eval() — can execute arbitrary code.';
      }
      if (/new\s+Function\s*\(/.test(line)) {
        return 'Uses new Function() — can execute arbitrary code.';
      }
      return null;
    },
  },
  {
    id: 'crypto-mining',
    severity: 'critical',
    test: (line) => {
      const lower = line.toLowerCase();
      if (
        lower.includes('stratum+tcp') ||
        lower.includes('coinhive') ||
        lower.includes('xmrig') ||
        lower.includes('cryptonight') ||
        lower.includes('minerd') ||
        lower.includes('cpuminer')
      ) {
        return 'References crypto mining tools or protocols.';
      }
      return null;
    },
  },
  {
    id: 'suspicious-network',
    severity: 'warn',
    test: (line) => {
      // WebSocket connections to non-standard ports
      const wsMatch = line.match(/wss?:\/\/[^'"\s]+:(\d+)/);
      if (wsMatch) {
        const port = Number.parseInt(wsMatch[1], 10);
        // Common legitimate ports
        const legit = [80, 443, 8080, 8443, 3000, 5000];
        if (!legit.includes(port)) {
          return `WebSocket connection to non-standard port ${port}.`;
        }
      }
      return null;
    },
  },
];

// --- Source-level rules (full-file analysis) ---

const SOURCE_RULES: SourceScanRule[] = [
  {
    id: 'potential-exfiltration',
    severity: 'warn',
    test: (source) => {
      // Heuristic: file read + network send in same file
      const hasFileRead = /(?:readFile|readFileSync|createReadStream|fs\.read)/i.test(source);
      const hasNetworkSend = /(?:fetch|axios|https?\.request|\.post\(|\.put\(|net\.connect)/i.test(
        source
      );
      if (hasFileRead && hasNetworkSend) {
        return 'File reads combined with network sends — potential data exfiltration vector.';
      }
      return null;
    },
  },
  {
    id: 'obfuscated-code',
    severity: 'warn',
    test: (source) => {
      // Long hex sequences (> 200 chars of hex)
      if (/[0-9a-f]{200,}/i.test(source)) {
        return 'Contains long hex sequence (>200 chars) — may be obfuscated payload.';
      }
      // Large base64 blobs (> 500 chars)
      if (/[A-Za-z0-9+/=]{500,}/.test(source)) {
        // Exclude if it looks like a comment or documentation
        return 'Contains large base64-like blob (>500 chars) — may be embedded binary or obfuscated code.';
      }
      // Excessive string escapes (obfuscation via \x or \u)
      const escapeCount = (source.match(/\\x[0-9a-f]{2}/gi) || []).length;
      if (escapeCount > 20) {
        return `Contains ${escapeCount} hex escape sequences — may be obfuscated.`;
      }
      return null;
    },
  },
  {
    id: 'env-harvesting',
    severity: 'critical',
    test: (source) => {
      // process.env access + network activity = credential theft attempt
      const accessesEnv =
        /process\.env(?:\[['"]\w+['"]\]|\.\w+)/g.test(source) ||
        /Object\.(?:keys|values|entries)\(process\.env\)/.test(source);
      const hasNetworkSend = /(?:fetch|axios|https?\.request|\.post\(|\.put\(|net\.connect)/i.test(
        source
      );
      if (accessesEnv && hasNetworkSend) {
        return 'Reads process.env and makes network requests — potential credential exfiltration.';
      }
      return null;
    },
  },
];

// --- Scanner engine ---

const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB — skip huge files
const SCANNABLE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.mts', '.cts']);

function scanSource(source: string, filePath: string): ScanFinding[] {
  const findings: ScanFinding[] = [];

  // Line-level rules
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of LINE_RULES) {
      const message = rule.test(line, i + 1);
      if (message) {
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          message,
          line: i + 1,
          file: filePath,
        });
      }
    }
  }

  // Source-level rules
  for (const rule of SOURCE_RULES) {
    const message = rule.test(source);
    if (message) {
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        message,
        file: filePath,
      });
    }
  }

  return findings;
}

async function scanDirectory(dirPath: string): Promise<ScanFinding[]> {
  const allFindings: ScanFinding[] = [];

  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return allFindings;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);

    try {
      const st = await stat(fullPath);

      if (st.isDirectory()) {
        // Recurse, but skip node_modules and .git
        if (entry !== 'node_modules' && entry !== '.git') {
          allFindings.push(...(await scanDirectory(fullPath)));
        }
      } else if (st.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (!SCANNABLE_EXTENSIONS.has(ext)) continue;
        if (st.size > MAX_FILE_SIZE_BYTES) continue;

        const source = await readFile(fullPath, 'utf-8');
        allFindings.push(...scanSource(source, fullPath));
      }
    } catch {
      // Permission denied or other FS error — skip
    }
  }

  return allFindings;
}

// --- Convert scan findings to audit findings ---

function toAuditFinding(sf: ScanFinding): AuditFinding {
  const location = sf.line ? ` (line ${sf.line})` : '';
  return {
    checkId: `tools.scan.${sf.ruleId}`,
    severity: sf.severity,
    title: `Tool safety: ${sf.ruleId} in ${sf.file}`,
    detail: `${sf.file}${location}: ${sf.message}`,
    remediation:
      sf.severity === 'critical'
        ? `Review the tool source at ${sf.file} and remove or sandbox the dangerous operation. Consider whether this tool should exist.`
        : `Review ${sf.file} and verify the flagged pattern is intentional and safe.`,
  };
}

// --- Main entry point ---

export async function checkToolSafety(opts: {
  toolsDir: string;
}): Promise<AuditFinding[]> {
  const rawFindings = await scanDirectory(opts.toolsDir);
  return rawFindings.map(toAuditFinding);
}

/** Exported for direct use (e.g., scanning a single tool at creation time) */
export { scanSource, scanDirectory, type ScanFinding };
