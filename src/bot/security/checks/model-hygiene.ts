/**
 * Security Audit — Model Hygiene Checks
 *
 * Adapted from OpenClaw's collectModelHygieneFindings + collectSmallModelRiskFindings.
 * Validates model configuration for deprecated versions, missing fallbacks,
 * and small models used in security-sensitive contexts.
 *
 * Target: src/bot/security/checks/model-hygiene.ts
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditFinding } from '../audit-types.js';

// --- Known model data ---

/** Models that have been deprecated or should no longer be used */
const DEPRECATED_MODELS = new Set([
  'gpt-3.5-turbo',
  'gpt-3.5-turbo-0301',
  'gpt-3.5-turbo-0613',
  'gpt-4-0314',
  'gpt-4-0613',
  'text-davinci-003',
  'text-davinci-002',
  'code-davinci-002',
  'claude-instant-1',
  'claude-instant-1.2',
  'claude-2',
  'claude-2.0',
  'claude-2.1',
]);

/** Models known to be "small" — limited security judgment. Based on OC's SMALL_MODEL_PARAM_B_MAX = 300B */
const SMALL_MODEL_PATTERNS = [
  /gpt-3\.5/,
  /gpt-4o-mini/,
  /claude.*haiku/,
  /claude-3-haiku/,
  /gemini.*flash/,
  /llama.*7b/i,
  /llama.*8b/i,
  /llama.*13b/i,
  /mistral.*7b/i,
  /phi-[23]/i,
];

function isDeprecated(model: string): boolean {
  return DEPRECATED_MODELS.has(model.toLowerCase());
}

function isSmallModel(model: string): boolean {
  const lower = model.toLowerCase();
  return SMALL_MODEL_PATTERNS.some((p) => p.test(lower));
}

// --- Main entry point ---

export async function checkModelHygiene(opts: {
  botDir: string;
  configPath?: string;
}): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const configPath = opts.configPath ?? join(opts.botDir, 'config.json');

  let config: Record<string, unknown>;
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    return findings;
  }

  // Extract model references from config
  const models: Array<{ key: string; value: string }> = [];
  extractModels(config, '', models);

  for (const { key, value } of models) {
    if (isDeprecated(value)) {
      findings.push({
        checkId: `model.deprecated.${key.replace(/\./g, '_')}`,
        severity: 'warn',
        title: `Deprecated model: ${value}`,
        detail: `Config key "${key}" references "${value}" which is deprecated. Deprecated models may lose API support without notice and may have known security weaknesses.`,
        remediation: `Update "${key}" to a current model version (e.g., gpt-4o, claude-sonnet-4-20250514, gemini-2.0-pro).`,
      });
    }

    if (isSmallModel(value) && isPrimaryModelKey(key)) {
      findings.push({
        checkId: `model.small_primary.${key.replace(/\./g, '_')}`,
        severity: 'warn',
        title: `Small model used as primary: ${value}`,
        detail: `Config key "${key}" uses "${value}" which is a small model (<300B parameters). Small models have weaker security judgment — they may follow malicious instructions more easily.`,
        remediation: `Consider using a larger model (claude-sonnet-4-20250514, gpt-4o) for the primary agent. Reserve small models for low-stakes auxiliary tasks.`,
      });
    }
  }

  // Check for fallback configuration
  const hasFallback = models.some(
    ({ key }) => key.includes('fallback') || key.includes('backup') || key.includes('secondary')
  );
  const hasPrimary = models.some(({ key }) => isPrimaryModelKey(key));

  if (hasPrimary && !hasFallback) {
    findings.push({
      checkId: 'model.no_fallback',
      severity: 'info',
      title: 'No fallback model configured',
      detail:
        'Only a primary model is configured with no fallback. If the primary provider has an outage, the bot will be unavailable.',
      remediation:
        'Add a fallback model from a different provider (e.g., if primary is Anthropic, add an OpenAI fallback).',
    });
  }

  return findings;
}

// --- Helpers ---

function isPrimaryModelKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower === 'model' ||
    lower.endsWith('.model') ||
    lower.includes('primary') ||
    lower.includes('default_model') ||
    lower.includes('mainmodel')
  );
}

function extractModels(
  obj: Record<string, unknown>,
  path: string,
  out: Array<{ key: string; value: string }>
): void {
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = path ? `${path}.${key}` : key;

    if (typeof value === 'string' && looksLikeModelName(key, value)) {
      out.push({ key: fullPath, value });
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      extractModels(value as Record<string, unknown>, fullPath, out);
    }
  }
}

function looksLikeModelName(key: string, value: string): boolean {
  const keyLower = key.toLowerCase();
  if (keyLower.includes('model')) return true;

  // Check value patterns that look like model identifiers
  if (/^(gpt-|claude-|gemini-|llama|mistral|phi-)/.test(value.toLowerCase())) return true;

  return false;
}
