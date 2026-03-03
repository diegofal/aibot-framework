/**
 * Security Audit — Config Secrets Detection
 *
 * Adapted from OpenClaw's collectSecretsInConfigFindings.
 * Scans config files and .env for hardcoded credentials that should be env refs.
 *
 * Target: src/bot/security/checks/config-secrets.ts
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditFinding } from '../audit-types.js';

// --- Detection heuristics ---

const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /api[_-]?secret/i,
  /auth[_-]?token/i,
  /access[_-]?token/i,
  /secret[_-]?key/i,
  /private[_-]?key/i,
  /password/i,
  /twilio.*sid/i,
  /twilio.*token/i,
  /bot[_-]?token/i,
  /webhook[_-]?secret/i,
];

/** Known credential prefixes from various providers */
const CREDENTIAL_PREFIXES = [
  'sk-', // OpenAI
  'pk-', // Various
  'ghp_', // GitHub PAT
  'gho_', // GitHub OAuth
  'ghu_', // GitHub user
  'ghs_', // GitHub app
  'github_pat_', // GitHub fine-grained
  'xoxb-', // Slack bot
  'xoxp-', // Slack user
  'AC', // Twilio account SID (followed by 32 hex)
  'SG.', // SendGrid
  'sk_live_', // Stripe live
  'sk_test_', // Stripe test
  'AKIA', // AWS access key
  'whsec_', // Webhook secrets
];

function isEnvReference(value: string): boolean {
  // Matches ${VAR_NAME} or $VAR_NAME patterns
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value) || /^\$[A-Z_][A-Z0-9_]*$/.test(value);
}

function looksLikeRawSecret(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.length < 8) return false;
  if (isEnvReference(value)) return false;

  // Check known prefixes
  for (const prefix of CREDENTIAL_PREFIXES) {
    if (value.startsWith(prefix)) return true;
  }

  // Long alphanumeric strings (32+ chars) that aren't paths or URLs
  if (/^[A-Za-z0-9+/=_-]{32,}$/.test(value) && !value.includes('/')) {
    return true;
  }

  return false;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

// --- Scan config JSON ---

function scanConfigObject(
  obj: Record<string, unknown>,
  path: string,
  findings: AuditFinding[],
  configFilePath: string
): void {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = path ? `${path}.${key}` : key;

    if (typeof value === 'string') {
      if (isSensitiveKey(key) && looksLikeRawSecret(value)) {
        findings.push({
          checkId: `secrets.config.${fullKey.replace(/[^a-zA-Z0-9.]/g, '_')}`,
          severity: 'critical',
          title: `Hardcoded secret in config: ${fullKey}`,
          detail: `${configFilePath} contains what looks like a raw credential at key "${fullKey}" (value starts with "${value.slice(0, 6)}..."). Use an environment variable reference instead.`,
          remediation: `Replace the value with "\${${key.toUpperCase()}}" and set the env var in your .env file.`,
        });
      } else if (!isSensitiveKey(key) && looksLikeRawSecret(value)) {
        // Non-sensitive key name but the value pattern matches — lower severity
        findings.push({
          checkId: `secrets.config.${fullKey.replace(/[^a-zA-Z0-9.]/g, '_')}.possible`,
          severity: 'warn',
          title: `Possible hardcoded secret in config: ${fullKey}`,
          detail: `${configFilePath} key "${fullKey}" has a value that resembles a credential (starts with "${value.slice(0, 6)}...").`,
          remediation: `If this is a secret, move it to an env var. If not, this is a false positive.`,
        });
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      scanConfigObject(value as Record<string, unknown>, fullKey, findings, configFilePath);
    }
  }
}

// --- Scan .env file ---

function scanEnvFile(content: string, envPath: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const value = line
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');

    // .env files SHOULD have secrets — but check for obviously wrong patterns
    if (value === '' || value === 'your-key-here' || value === 'CHANGE_ME' || value === 'xxx') {
      findings.push({
        checkId: `secrets.env.${key}.placeholder`,
        severity: 'warn',
        title: `Placeholder value in .env: ${key}`,
        detail: `${envPath} has "${key}" set to a placeholder value ("${value}"). This may cause authentication failures at runtime.`,
        remediation: `Set ${key} to a real value in ${envPath}.`,
      });
    }
  }

  return findings;
}

// --- Main entry point ---

export async function checkConfigSecrets(opts: {
  botDir: string;
  configPath?: string;
  envPath?: string;
}): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const configPath = opts.configPath ?? join(opts.botDir, 'config.json');
  const envPath = opts.envPath ?? join(opts.botDir, '.env');

  // Scan config.json
  try {
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);
    if (typeof config === 'object' && config !== null) {
      scanConfigObject(config, '', findings, configPath);
    }
  } catch {
    // File doesn't exist or isn't valid JSON — not a secret leak
  }

  // Scan .env
  try {
    const raw = await readFile(envPath, 'utf-8');
    findings.push(...scanEnvFile(raw, envPath));
  } catch {
    // No .env — some setups don't use one, that's fine
  }

  // Check if .env is gitignored (only if we can find a git root)
  try {
    const gitignorePath = join(opts.botDir, '..', '.gitignore');
    const gitignore = await readFile(gitignorePath, 'utf-8');
    const envFileName = '.env';
    const lines = gitignore.split('\n').map((l) => l.trim());
    const isIgnored = lines.some(
      (l) => l === envFileName || l === `${envFileName}*` || l === '*.env' || l === '.env*'
    );
    if (!isIgnored) {
      // Check if .env actually exists before warning
      try {
        await readFile(envPath);
        findings.push({
          checkId: 'secrets.env.not_gitignored',
          severity: 'critical',
          title: '.env file may not be gitignored',
          detail: `${envPath} exists but ".env" was not found in .gitignore. This file likely contains API keys and tokens.`,
          remediation: `Add ".env" to your .gitignore file.`,
        });
      } catch {
        // .env doesn't exist, no risk
      }
    }
  } catch {
    // No .gitignore accessible — can't check, skip
  }

  return findings;
}
