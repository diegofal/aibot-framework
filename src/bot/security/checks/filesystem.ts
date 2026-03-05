/**
 * Security Audit — Filesystem Permission Checks
 *
 * Adapted from OpenClaw's audit-fs.ts (POSIX portion only — no Windows ACL).
 * Checks permissions on bot directory, config, credentials, memory, and soul files.
 *
 * Target: src/bot/security/checks/filesystem.ts
 */

import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditFinding } from '../audit-types.js';

// --- Permission inspection ---

type PermissionInfo = {
  path: string;
  mode: number;
  worldWritable: boolean;
  groupWritable: boolean;
  worldReadable: boolean;
  groupReadable: boolean;
  isSymlink: boolean;
  exists: boolean;
};

function formatOctal(mode: number): string {
  return `0o${(mode & 0o777).toString(8)}`;
}

async function inspectPermissions(path: string): Promise<PermissionInfo> {
  try {
    const lst = await lstat(path);
    const isSymlink = lst.isSymbolicLink();
    const st = await stat(path);
    const mode = st.mode;
    return {
      path,
      mode,
      worldWritable: (mode & 0o002) !== 0,
      groupWritable: (mode & 0o020) !== 0,
      worldReadable: (mode & 0o004) !== 0,
      groupReadable: (mode & 0o040) !== 0,
      isSymlink,
      exists: true,
    };
  } catch {
    return {
      path,
      mode: 0,
      worldWritable: false,
      groupWritable: false,
      worldReadable: false,
      groupReadable: false,
      isSymlink: false,
      exists: false,
    };
  }
}

// --- Check functions ---

function checkDir(perms: PermissionInfo, label: string, idPrefix: string): AuditFinding[] {
  if (!perms.exists) return [];
  const findings: AuditFinding[] = [];

  if (perms.worldWritable) {
    findings.push({
      checkId: `${idPrefix}.world_writable`,
      severity: 'critical',
      title: `${label} is world-writable`,
      detail: `${perms.path} (mode ${formatOctal(perms.mode)}) — any local user can modify contents.`,
      remediation: `chmod 700 ${perms.path}`,
    });
  } else if (perms.groupWritable) {
    findings.push({
      checkId: `${idPrefix}.group_writable`,
      severity: 'warn',
      title: `${label} is group-writable`,
      detail: `${perms.path} (mode ${formatOctal(perms.mode)}) — other group members can modify contents.`,
      remediation: `chmod 700 ${perms.path}`,
    });
  }

  if (perms.isSymlink) {
    findings.push({
      checkId: `${idPrefix}.symlink`,
      severity: 'warn',
      title: `${label} is a symlink`,
      detail: `${perms.path} is a symbolic link. This can be a trust boundary issue if the link target is outside your control.`,
    });
  }

  return findings;
}

function checkFile(
  perms: PermissionInfo,
  label: string,
  idPrefix: string,
  sensitive: boolean
): AuditFinding[] {
  if (!perms.exists) return [];
  const findings: AuditFinding[] = [];

  if (perms.worldWritable) {
    findings.push({
      checkId: `${idPrefix}.world_writable`,
      severity: 'critical',
      title: `${label} is world-writable`,
      detail: `${perms.path} (mode ${formatOctal(perms.mode)}) — any local user can modify this file.`,
      remediation: `chmod 600 ${perms.path}`,
    });
  } else if (perms.groupWritable) {
    findings.push({
      checkId: `${idPrefix}.group_writable`,
      severity: 'warn',
      title: `${label} is group-writable`,
      detail: `${perms.path} (mode ${formatOctal(perms.mode)}).`,
      remediation: `chmod 600 ${perms.path}`,
    });
  }

  if (sensitive && perms.worldReadable) {
    findings.push({
      checkId: `${idPrefix}.world_readable`,
      severity: 'critical',
      title: `${label} is world-readable (may contain secrets)`,
      detail: `${perms.path} (mode ${formatOctal(perms.mode)}) — any local user can read this potentially sensitive file.`,
      remediation: `chmod 600 ${perms.path}`,
    });
  }

  if (perms.isSymlink) {
    findings.push({
      checkId: `${idPrefix}.symlink`,
      severity: 'warn',
      title: `${label} is a symlink`,
      detail: `${perms.path} is a symbolic link.`,
    });
  }

  return findings;
}

// --- Main entry point ---

export async function checkFilesystemPermissions(opts: {
  botDir: string;
  configPath?: string;
}): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  // 1. Bot root directory — should be 700
  const botDirPerms = await inspectPermissions(opts.botDir);
  findings.push(...checkDir(botDirPerms, 'Bot directory', 'fs.bot_dir'));

  // 2. Config file — should be 600 (may contain token references)
  const configPath = opts.configPath ?? join(opts.botDir, 'config.json');
  const configPerms = await inspectPermissions(configPath);
  findings.push(...checkFile(configPerms, 'Config file', 'fs.config', true));

  // 3. .env file — definitely sensitive, should be 600
  const envPath = join(opts.botDir, '.env');
  const envPerms = await inspectPermissions(envPath);
  findings.push(...checkFile(envPerms, '.env file', 'fs.env', true));

  // 4. Credentials directory — should be 700
  const credsDir = join(opts.botDir, 'credentials');
  const credsDirPerms = await inspectPermissions(credsDir);
  findings.push(...checkDir(credsDirPerms, 'Credentials directory', 'fs.creds_dir'));

  // 5. Scan individual credential files if dir exists
  if (credsDirPerms.exists) {
    try {
      const files = await readdir(credsDir);
      for (const file of files) {
        const filePath = join(credsDir, file);
        const perms = await inspectPermissions(filePath);
        findings.push(
          ...checkFile(
            perms,
            `Credential file: ${file}`,
            `fs.creds.${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
            true
          )
        );
      }
    } catch {
      // readdir failure — not a security issue per se
    }
  }

  // 6. Memory directory — personal info, should be restricted
  const memoryDir = join(opts.botDir, 'memory');
  const memoryDirPerms = await inspectPermissions(memoryDir);
  findings.push(...checkDir(memoryDirPerms, 'Memory directory', 'fs.memory_dir'));

  // 7. Soul directory — personality/motivations, less sensitive but still
  const soulDir = join(opts.botDir, 'soul');
  const soulDirPerms = await inspectPermissions(soulDir);
  if (soulDirPerms.exists && soulDirPerms.worldWritable) {
    findings.push({
      checkId: 'fs.soul_dir.world_writable',
      severity: 'warn',
      title: 'Soul directory is world-writable',
      detail: `${soulDir} (mode ${formatOctal(soulDirPerms.mode)}) — personality and motivation files can be tampered with by any local user.`,
      remediation: `chmod 755 ${soulDir}`,
    });
  }

  return findings;
}
