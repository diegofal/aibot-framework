import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SoulLintIssue {
  file: string;
  severity: 'error' | 'warning';
  message: string;
}

const REQUIRED_FILES = ['IDENTITY.md', 'SOUL.md', 'MOTIVATIONS.md'] as const;

/** Headers that indicate duplicated content leaked into SOUL.md */
const SOUL_DUPLICATE_HEADERS = [
  '## Your Inner Motivations',
  '## Goals',
  '## Impulsos centrales',
  '## Foco actual',
];

/** Stale placeholder patterns in MOTIVATIONS.md */
const STALE_PLACEHOLDERS = [
  'ninguna todavia',
  'none yet',
  'populated by first reflection',
  'se poblara con',
];

export function lintSoulDirectory(soulDir: string): SoulLintIssue[] {
  const issues: SoulLintIssue[] = [];

  // Check required files exist
  for (const file of REQUIRED_FILES) {
    const filepath = join(soulDir, file);
    if (!existsSync(filepath)) {
      issues.push({ file, severity: 'error', message: `Missing required file: ${file}` });
    }
  }

  // Check SOUL.md for duplicated headers from other files
  const soulPath = join(soulDir, 'SOUL.md');
  if (existsSync(soulPath)) {
    try {
      const soulContent = readFileSync(soulPath, 'utf-8');
      for (const header of SOUL_DUPLICATE_HEADERS) {
        if (soulContent.includes(header)) {
          issues.push({
            file: 'SOUL.md',
            severity: 'warning',
            message: `Contains duplicated section "${header}" — this belongs in MOTIVATIONS.md or GOALS.md`,
          });
        }
      }
    } catch {
      // Cannot read — already caught by missing file check
    }
  }

  // Check MOTIVATIONS.md for stale placeholders
  const motivationsPath = join(soulDir, 'MOTIVATIONS.md');
  if (existsSync(motivationsPath)) {
    try {
      const content = readFileSync(motivationsPath, 'utf-8').toLowerCase();
      for (const placeholder of STALE_PLACEHOLDERS) {
        if (content.includes(placeholder)) {
          issues.push({
            file: 'MOTIVATIONS.md',
            severity: 'warning',
            message: `Contains stale placeholder: "${placeholder}"`,
          });
        }
      }
    } catch {
      // Cannot read
    }
  }

  // Check memory/ directory exists
  const memoryDir = join(soulDir, 'memory');
  if (!existsSync(memoryDir)) {
    issues.push({ file: 'memory/', severity: 'warning', message: 'Missing memory/ directory' });
  }

  return issues;
}
