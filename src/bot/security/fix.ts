/**
 * Security Audit — Auto-Remediation Engine
 *
 * Adapted from OpenClaw's src/security/fix.ts.
 * Only safe, non-destructive operations: chmod + config tightening.
 * Supports dry-run mode (default) for preview before applying.
 *
 * Target: src/bot/security/fix.ts
 */

import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  FixAction,
  FixActionChmod,
  FixActionConfig,
  FixOptions,
  FixResult,
} from './audit-types.js';

// --- Permission fixes ---

async function fixPermission(
  path: string,
  targetMode: number,
  dryRun: boolean
): Promise<FixActionChmod> {
  try {
    const st = await stat(path);
    const currentMode = st.mode & 0o777;

    if (currentMode === targetMode) {
      return { kind: 'chmod', path, oldMode: currentMode, newMode: targetMode, ok: true };
    }

    if (!dryRun) {
      await chmod(path, targetMode);
    }

    return {
      kind: 'chmod',
      path,
      oldMode: currentMode,
      newMode: targetMode,
      ok: true,
    };
  } catch (err) {
    return {
      kind: 'chmod',
      path,
      oldMode: 0,
      newMode: targetMode,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- Config fixes ---

async function fixConfigValue(
  configPath: string,
  key: string,
  newValue: unknown,
  dryRun: boolean
): Promise<FixActionConfig | null> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);

    // Navigate to key
    const parts = key.split('.');
    let current = config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof current !== 'object' || current === null) return null;
      current = current[parts[i]];
    }

    const lastKey = parts[parts.length - 1];
    if (typeof current !== 'object' || current === null) return null;
    if (!(lastKey in current)) return null;

    const oldValue = current[lastKey];

    if (!dryRun) {
      if (newValue === undefined) {
        delete current[lastKey];
      } else {
        current[lastKey] = newValue;
      }
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    }

    return {
      kind: 'config',
      key,
      oldValue: String(oldValue),
      newValue: newValue === undefined ? '(removed)' : String(newValue),
      ok: true,
    };
  } catch (err) {
    return {
      kind: 'config',
      key,
      oldValue: '(unknown)',
      newValue: String(newValue),
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- Dangerous flags to remove ---

const FLAGS_TO_REMOVE = [
  'dangerouslyDisablePermissions',
  'dangerouslyAllowAllTools',
  'dangerouslyDisableAuditLog',
  'allowInsecureAuth',
];

// --- Main entry point ---

export async function fixSecurityIssues(opts: FixOptions): Promise<FixResult> {
  const dryRun = opts.dryRun ?? true; // Default to dry-run for safety
  const actions: FixAction[] = [];
  const errors: string[] = [];
  const configPath = opts.configPath ?? join(opts.botDir, 'config.json');

  // --- Filesystem permission fixes ---

  // Bot directory → 700
  const botDirFix = await fixPermission(opts.botDir, 0o700, dryRun);
  actions.push(botDirFix);
  if (!botDirFix.ok && botDirFix.error) errors.push(`chmod ${opts.botDir}: ${botDirFix.error}`);

  // Config file → 600
  const configFix = await fixPermission(configPath, 0o600, dryRun);
  actions.push(configFix);
  if (!configFix.ok && configFix.error) errors.push(`chmod ${configPath}: ${configFix.error}`);

  // .env file → 600
  const envPath = join(opts.botDir, '.env');
  const envFix = await fixPermission(envPath, 0o600, dryRun);
  if (envFix.ok || envFix.error?.includes('ENOENT') === false) {
    actions.push(envFix);
    if (!envFix.ok && envFix.error) errors.push(`chmod ${envPath}: ${envFix.error}`);
  }

  // Credentials directory → 700
  const credsDir = join(opts.botDir, 'credentials');
  const credsFix = await fixPermission(credsDir, 0o700, dryRun);
  if (credsFix.ok || credsFix.error?.includes('ENOENT') === false) {
    actions.push(credsFix);
    if (!credsFix.ok && credsFix.error) errors.push(`chmod ${credsDir}: ${credsFix.error}`);
  }

  // Memory directory → 700
  const memoryDir = join(opts.botDir, 'memory');
  const memoryFix = await fixPermission(memoryDir, 0o700, dryRun);
  if (memoryFix.ok || memoryFix.error?.includes('ENOENT') === false) {
    actions.push(memoryFix);
    if (!memoryFix.ok && memoryFix.error) errors.push(`chmod ${memoryDir}: ${memoryFix.error}`);
  }

  // --- Config flag removal ---

  for (const flag of FLAGS_TO_REMOVE) {
    const action = await fixConfigValue(configPath, flag, undefined, dryRun);
    if (action) {
      actions.push(action);
      if (!action.ok && action.error) errors.push(`config ${flag}: ${action.error}`);
    }
  }

  // Filter out no-op chmod actions (where mode didn't change)
  const meaningfulActions = actions.filter((a) => {
    if (a.kind === 'chmod') return a.oldMode !== a.newMode;
    return true;
  });

  return {
    ok: errors.length === 0,
    dryRun,
    actions: meaningfulActions,
    errors,
  };
}

// --- Formatting ---

export function formatFixResult(result: FixResult): string {
  const lines: string[] = [];
  const prefix = result.dryRun ? '[DRY RUN] ' : '';

  if (result.actions.length === 0) {
    lines.push(`${prefix}No changes needed — all checked items are already correctly configured.`);
    return lines.join('\n');
  }

  lines.push(`${prefix}${result.actions.length} action(s):`);
  lines.push('');

  for (const action of result.actions) {
    if (action.kind === 'chmod') {
      const oldOctal = '0o' + action.oldMode.toString(8);
      const newOctal = '0o' + action.newMode.toString(8);
      const status = action.ok ? '✅' : '❌';
      lines.push(`${status} chmod ${action.path}: ${oldOctal} → ${newOctal}`);
      if (action.error) lines.push(`   Error: ${action.error}`);
    } else if (action.kind === 'config') {
      const status = action.ok ? '✅' : '❌';
      lines.push(`${status} config ${action.key}: "${action.oldValue}" → "${action.newValue}"`);
      if (action.error) lines.push(`   Error: ${action.error}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push('');
    lines.push(`⚠️ ${result.errors.length} error(s):`);
    for (const err of result.errors) {
      lines.push(`  - ${err}`);
    }
  }

  return lines.join('\n');
}
