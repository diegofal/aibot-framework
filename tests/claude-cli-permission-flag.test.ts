import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { SKIP_PERMISSIONS_FLAG } from '../src/claude-cli';

/**
 * Regression guard for the permission-bypass flag passed to the Claude CLI.
 *
 * Claude Code parses its flags with commander, which does NOT accept a camelCase
 * spelling of a kebab-case option. Verified against the pinned CLI (2.1.237):
 *
 *   $ claude -p hi --dangerouslySkipPermissions
 *   error: unknown option '--dangerouslySkipPermissions'
 *
 * Every spawn carrying the camelCase spelling therefore dies before the model is
 * ever reached, which takes down memory flush, soul consolidation, the soul
 * quality reviewer and the improve tool. The flag lives in one exported constant
 * so the four call sites cannot drift apart again.
 */

const SRC_DIR = join(import.meta.dir, '..', 'src');

/** Every .ts file under src/, recursively. */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('Claude CLI permission-bypass flag', () => {
  test('uses the kebab-case spelling commander actually accepts', () => {
    expect(SKIP_PERMISSIONS_FLAG).toBe('--dangerously-skip-permissions');
  });

  test('no source file passes the camelCase spelling the CLI rejects', () => {
    // Matches the flag as a string literal in an argv array — prose mentioning
    // the broken spelling (like the constant's own doc comment) is not a bug.
    const asArgument = /['"]--dangerouslySkipPermissions['"]/;
    const offenders = collectSourceFiles(SRC_DIR).filter((file) =>
      asArgument.test(readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  test('every call site spawns the flag through the shared constant', () => {
    const callSites = [
      join(SRC_DIR, 'claude-cli.ts'),
      join(SRC_DIR, 'bot', 'soul-memory-consolidator.ts'),
      join(SRC_DIR, 'bot', 'soul-quality-reviewer.ts'),
      join(SRC_DIR, 'tools', 'improve.ts'),
    ];
    for (const file of callSites) {
      expect(readFileSync(file, 'utf8')).toContain('SKIP_PERMISSIONS_FLAG');
    }
  });
});
