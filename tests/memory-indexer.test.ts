import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverFiles } from '../src/memory/indexer';

/**
 * `discoverFiles` runs during startup reindexing, so anything it throws is
 * fatal. On a fresh Docker config volume `config/soul/` does not exist until
 * the first agent writes to it, and with `soul.search.enabled: true` that used
 * to crash-loop the container with an ENOENT before it ever reached
 * "All systems operational".
 */
describe('discoverFiles', () => {
  function withTempDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'aibot-indexer-'));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a missing soul directory is an empty result, not a throw', () => {
    withTempDir((dir) => {
      const missing = join(dir, 'soul-that-was-never-created');
      expect(() => discoverFiles(missing)).not.toThrow();
      expect(discoverFiles(missing)).toEqual([]);
    });
  });

  test('an existing but empty soul directory yields nothing', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, 'soul'));
      expect(discoverFiles(join(dir, 'soul'))).toEqual([]);
    });
  });

  test('finds markdown files recursively and ignores everything else', () => {
    withTempDir((dir) => {
      const soul = join(dir, 'soul');
      mkdirSync(join(soul, 'default', 'memory'), { recursive: true });
      writeFileSync(join(soul, 'IDENTITY.md'), '# Identity');
      writeFileSync(join(soul, 'default', 'MEMORY.md'), '# Memory');
      writeFileSync(join(soul, 'default', 'memory', '2026-08-11.md'), '# Log');
      writeFileSync(join(soul, 'notes.txt'), 'ignored');

      const found = discoverFiles(soul).map((p) => p.replace(/\\/g, '/')).sort();
      expect(found).toEqual([
        'IDENTITY.md',
        'default/MEMORY.md',
        'default/memory/2026-08-11.md',
      ]);
    });
  });
});
